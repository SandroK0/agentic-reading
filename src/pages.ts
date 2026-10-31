import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { TextLayer } from "pdfjs-dist";

/**
 * The book as one continuous column of pages. Every page gets a placeholder
 * of the right size up front, but only pages near the visible area are drawn;
 * pages that scroll far away are dropped again so long books stay light.
 */

/** How far above and below the visible area pages are drawn ahead of time. */
const RENDER_MARGIN = "150% 0px";
/** The point down the viewport that decides which page you're "on". */
const READING_LINE = 0.3;
const MAX_FIT_SCALE = 2.2;
/** How long zooming has to pause before pages are re-drawn sharp at the new size. */
const REDRAW_AFTER_ZOOM_MS = 150;

interface Slot {
  n: number;
  el: HTMLDivElement;
  /** Unscaled page size; the first page's until this page has been loaded. */
  width: number;
  height: number;
  /** Scale the current drawing was made at, 0 when nothing is drawn. */
  drawnScale: number;
  /** Bumped to invalidate an in-flight render. */
  token: number;
  task: RenderTask | null;
}

export class Pages {
  private doc: PDFDocumentProxy | null = null;
  private slots: Slot[] = [];
  private scale = 1;
  private zoom = 1;
  private near = new Set<Slot>();
  private texts = new Map<number, string>();
  private observer: IntersectionObserver;
  private scrollQueued = false;
  private redrawTimer: ReturnType<typeof setTimeout> | undefined;
  current = 1;

  constructor(
    private viewer: HTMLElement,
    private container: HTMLElement,
    private onPage: (page: number) => void,
  ) {
    this.observer = new IntersectionObserver((entries) => this.observed(entries), {
      root: viewer,
      rootMargin: RENDER_MARGIN,
    });
    viewer.addEventListener("scroll", () => {
      if (this.scrollQueued) return;
      this.scrollQueued = true;
      requestAnimationFrame(() => {
        this.scrollQueued = false;
        this.track();
      });
    });
  }

  get count() {
    return this.slots.length;
  }

  async load(doc: PDFDocumentProxy, startPage: number) {
    this.observer.disconnect();
    for (const slot of this.slots) this.release(slot);
    this.near.clear();
    this.texts.clear();
    this.doc = doc;

    const first = (await doc.getPage(1)).getViewport({ scale: 1 });
    if (this.doc !== doc) return;
    this.slots = Array.from({ length: doc.numPages }, (_, i) => {
      const el = document.createElement("div");
      el.className = "page";
      el.dataset.page = String(i + 1);
      return { n: i + 1, el, width: first.width, height: first.height, drawnScale: 0, token: 0, task: null };
    });
    this.container.replaceChildren(...this.slots.map((s) => s.el));
    this.layout();
    for (const slot of this.slots) this.observer.observe(slot.el);
    this.goTo(startPage);
  }

  goTo(n: number) {
    if (!this.slots.length) return;
    const slot = this.slots[clampPage(n, this.slots.length) - 1];
    this.viewer.scrollTop = this.top(slot) - 12;
    this.setCurrent(slot.n, true);
  }

  get zoomLevel() {
    return this.zoom;
  }

  /**
   * Zooms, keeping the point under `anchor` (viewer-relative pixels) in place,
   * or the reading line when there's no anchor. Pages stretch right away and
   * are re-drawn sharp once zooming pauses, so a pinch or a fast scroll stays smooth.
   */
  setZoom(zoom: number, anchor?: { x: number; y: number }) {
    if (zoom === this.zoom) return;
    this.zoom = zoom;
    this.relayout(anchor);
  }

  /** Re-fits pages to the viewer's width, keeping the same spot in view. */
  relayout(anchor?: { x: number; y: number }) {
    if (!this.slots.length) return;
    const ax = anchor?.x ?? this.viewer.clientWidth / 2;
    const ay = anchor?.y ?? this.viewer.clientHeight * READING_LINE;
    const line = this.viewer.scrollTop + ay;
    const slot = this.slots[this.slotAt(line)];
    const along = (line - this.top(slot)) / slot.el.offsetHeight;
    const oldScale = this.scale;
    const across = this.viewer.scrollLeft + ax;

    this.layout();
    this.viewer.scrollTop = this.top(slot) + along * slot.el.offsetHeight - ay;
    this.viewer.scrollLeft = across * (this.scale / oldScale) - ax;
    clearTimeout(this.redrawTimer);
    this.redrawTimer = setTimeout(() => {
      for (const s of this.near) void this.draw(s);
    }, REDRAW_AFTER_ZOOM_MS);
  }

  /** The page's plain text, cached once read. */
  async text(n: number): Promise<string> {
    const cached = this.texts.get(n);
    if (cached !== undefined) return cached;
    if (!this.doc) return "";
    const content = await (await this.doc.getPage(n)).getTextContent();
    const text = joinText(content.items);
    this.texts.set(n, text);
    return text;
  }

  private layout() {
    const first = this.slots[0];
    const fit = Math.max(200, this.viewer.clientWidth - 48) / first.width;
    this.scale = Math.min(fit, MAX_FIT_SCALE) * this.zoom;
    for (const slot of this.slots) this.size(slot);
  }

  private size(slot: Slot) {
    slot.el.style.width = `${Math.floor(slot.width * this.scale)}px`;
    slot.el.style.height = `${Math.floor(slot.height * this.scale)}px`;
    slot.el.style.setProperty("--scale-factor", String(this.scale));
    slot.el.style.setProperty("--total-scale-factor", String(this.scale));
  }

  private top(slot: Slot) {
    return this.container.offsetTop + slot.el.offsetTop;
  }

  private observed(entries: IntersectionObserverEntry[]) {
    for (const entry of entries) {
      const slot = this.slots[Number((entry.target as HTMLElement).dataset.page) - 1];
      if (!slot) continue;
      if (entry.isIntersecting) {
        this.near.add(slot);
        void this.draw(slot);
      } else {
        this.near.delete(slot);
        this.release(slot);
      }
    }
  }

  private track() {
    if (!this.slots.length) return;
    this.setCurrent(this.slotAt(this.viewer.scrollTop + this.viewer.clientHeight * READING_LINE) + 1);
  }

  /** Index of the page at `line` (scroll-content pixels): the last one starting above it. */
  private slotAt(line: number): number {
    let lo = 0;
    let hi = this.slots.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.top(this.slots[mid]) <= line) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private setCurrent(n: number, force = false) {
    if (n === this.current && !force) return;
    this.current = n;
    this.onPage(n);
  }

  private async draw(slot: Slot) {
    const doc = this.doc;
    if (!doc || slot.drawnScale === this.scale) return;
    const token = ++slot.token;
    const scale = this.scale;
    try {
      const page = await doc.getPage(slot.n);
      if (token !== slot.token) return;
      const base = page.getViewport({ scale: 1 });
      if (base.width !== slot.width || base.height !== slot.height) {
        slot.width = base.width;
        slot.height = base.height;
        this.size(slot);
      }

      const viewport = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      slot.task?.cancel();
      slot.task = page.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      await slot.task.promise;
      if (token !== slot.token) return;

      const content = await page.getTextContent();
      if (token !== slot.token) return;
      const textLayer = document.createElement("div");
      textLayer.className = "textLayer";
      await new TextLayer({ textContentSource: content, container: textLayer, viewport }).render();
      if (token !== slot.token) return;

      if (!this.texts.has(slot.n)) this.texts.set(slot.n, joinText(content.items));
      // Swap in one go, so re-drawing after a zoom never flashes a blank page.
      slot.el.replaceChildren(canvas, textLayer);
      slot.drawnScale = scale;
    } catch (err) {
      if (token !== slot.token || (err instanceof Error && err.name === "RenderingCancelledException")) return;
      console.error(`Couldn't draw page ${slot.n}`, err);
    }
  }

  private release(slot: Slot) {
    slot.token++;
    slot.task?.cancel();
    slot.task = null;
    if (slot.drawnScale === 0) return;
    // Keep a selection the reader is making alive rather than pulling text out from under it.
    if (slot.el.contains(window.getSelection()?.anchorNode ?? null)) return;
    slot.el.replaceChildren();
    slot.drawnScale = 0;
  }
}

function clampPage(n: number, count: number) {
  return Math.min(Math.max(1, Math.round(n) || 1), count);
}

function joinText(items: Awaited<ReturnType<PDFPageProxy["getTextContent"]>>["items"]) {
  return items.map((i) => ("str" in i ? i.str + (i.hasEOL ? "\n" : "") : "")).join("");
}
