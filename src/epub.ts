import { unzipSync } from "fflate";
import type { ContentsNode } from "./toc";

/**
 * EPUB books. An EPUB is a zip of XHTML chapters plus a package file that
 * lists them in reading order (the spine) and usually a table of contents.
 * Each spine item plays the part a page plays in a PDF: explanations, the
 * contents sidebar and the page box all count in spine items, so the rest of
 * the app works unchanged. Your place is saved as a fraction through the item.
 *
 * The book's own styles and scripts are dropped; its text is shown in the
 * reader's theme, and only plain markup, images and links are kept.
 */

const OPS_NS = "http://www.idpf.org/2007/ops";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/** Elements dropped along with everything inside them. */
const DROP = new Set([
  "script", "style", "link", "meta", "base", "title", "iframe", "frame", "object", "embed", "applet",
  "form", "input", "button", "select", "textarea", "video", "audio", "source", "track", "canvas",
  "noscript", "template", "foreignobject",
]);
/** Attributes kept on any element; everything else (styles, classes, handlers) goes. */
const KEEP_ATTRS = new Set([
  "alt", "title", "lang", "colspan", "rowspan", "start", "type", "reversed", "dir",
  // SVG drawing attributes, for books that put their cover or figures in SVG.
  "viewbox", "width", "height", "x", "y", "d", "points", "transform", "preserveaspectratio",
]);

/** The point down the viewport that decides which section you're "on"; matches the PDF reader. */
const READING_LINE = 0.3;
const BASE_FONT_PX = 19;
/** How long the lines are in Scroll and Single, in ems of the text: the reader's Width setting. */
export const MIN_MEASURE = 20;
export const MAX_MEASURE = 60;
export const DEFAULT_MEASURE = 32;

/**
 * How the book is laid out: one long scroll, or paginated into one or two
 * pages at a time that slide sideways when you turn them. Two pages falls
 * back to one when the window is too narrow for two comfortable columns.
 */
export type EpubLayout = "scroll" | "single" | "double";

/** Room left around the pages when paginated: the edges take clicks to turn, the bottom holds the page bar. */
const PAGED_SIDE = 64;
const PAGED_TOP = 36;
const PAGED_BOTTOM = 60;
/** How much wheel or trackpad travel turns one page, and how long a gesture must pause before the next can. */
const SWIPE_DISTANCE = 40;
const SWIPE_PAUSE_MS = 250;

export interface EpubBook {
  title: string | null;
  sections: string[];
  contents: ContentsNode[];
  files: Record<string, Uint8Array>;
}

export function parseEpub(bytes: Uint8Array): EpubBook {
  const files = unzipSync(bytes);
  const container = xml(text(files, "META-INF/container.xml"));
  const opfPath = container.querySelector("rootfile")?.getAttribute("full-path");
  if (!opfPath) throw new Error("This EPUB has no package file.");
  const opf = xml(text(files, opfPath));

  const manifest = new Map<string, { path: string; type: string; props: string }>();
  for (const item of opf.querySelectorAll("manifest > item")) {
    manifest.set(item.getAttribute("id") ?? "", {
      path: resolve(opfPath, item.getAttribute("href") ?? ""),
      type: item.getAttribute("media-type") ?? "",
      props: item.getAttribute("properties") ?? "",
    });
  }
  const spine = opf.querySelector("spine");
  const sections = [...(spine?.querySelectorAll("itemref") ?? [])]
    .map((ref) => manifest.get(ref.getAttribute("idref") ?? "")?.path)
    .filter((p): p is string => !!p && p in files);
  if (!sections.length) throw new Error("This EPUB has no readable chapters.");

  const title = opf.getElementsByTagNameNS("*", "title")[0]?.textContent?.trim() || null;
  const sectionOf = (href: string) => {
    const at = sections.indexOf(href.split("#")[0]);
    return at < 0 ? null : at + 1;
  };

  // EPUB 3 has a navigation document; EPUB 2 an NCX file named by the spine.
  let contents: ContentsNode[] = [];
  const nav = [...manifest.values()].find((m) => m.props.split(/\s+/).includes("nav"));
  if (nav && nav.path in files) contents = navContents(nav.path, html(text(files, nav.path)), sectionOf);
  const ncx = manifest.get(spine?.getAttribute("toc") ?? "");
  if (!contents.length && ncx && ncx.path in files) contents = ncxContents(ncx.path, xml(text(files, ncx.path)), sectionOf);

  return { title, sections, contents, files };
}

function navContents(navPath: string, doc: Document, sectionOf: (href: string) => number | null): ContentsNode[] {
  const navs = [...doc.querySelectorAll("nav")];
  const toc = navs.find((n) => (n.getAttributeNS(OPS_NS, "type") ?? n.getAttribute("epub:type"))?.includes("toc")) ?? navs[0];
  const walk = (ol: Element | null): ContentsNode[] =>
    [...(ol?.children ?? [])]
      .filter((li) => li.localName === "li")
      .map((li) => {
        const label = [...li.children].find((c) => c.localName === "a" || c.localName === "span");
        const href = label?.getAttribute("href");
        return {
          title: label?.textContent?.replace(/\s+/g, " ").trim() ?? "",
          ...target(navPath, href, sectionOf),
          items: walk([...li.children].find((c) => c.localName === "ol") ?? null),
        };
      });
  return walk(toc?.querySelector("ol") ?? null);
}

function ncxContents(ncxPath: string, doc: Document, sectionOf: (href: string) => number | null): ContentsNode[] {
  const walk = (parent: Element | null): ContentsNode[] =>
    [...(parent?.children ?? [])]
      .filter((c) => c.localName === "navPoint")
      .map((point) => {
        const label = [...point.children].find((c) => c.localName === "navLabel");
        const content = [...point.children].find((c) => c.localName === "content");
        return {
          title: label?.textContent?.replace(/\s+/g, " ").trim() ?? "",
          ...target(ncxPath, content?.getAttribute("src"), sectionOf),
          items: walk(point),
        };
      });
  return walk(doc.getElementsByTagNameNS("*", "navMap")[0] ?? null);
}

function target(from: string, href: string | null | undefined, sectionOf: (href: string) => number | null) {
  if (!href) return { page: null };
  const full = resolve(from, href);
  return { page: sectionOf(full), anchor: full.split("#")[1] || undefined };
}

/**
 * The book in the reader's theme. Scrolling shows the sections as one column
 * of sheets; paginated shows one section at a time, flowed into CSS columns
 * one page wide, and turns pages by sliding those columns sideways. Zoom
 * scales the type; the text reflows to fit either way.
 */
export class EpubView {
  private book: EpubBook | null = null;
  private sheets: HTMLElement[] = [];
  private urls: string[] = [];
  private zoom = 1;
  private measure = DEFAULT_MEASURE;
  private scrollQueued = false;
  private layout: EpubLayout = "scroll";
  /** Paginated only: which spread of the current section is showing, out of how many, and how far apart they are. */
  private spread = 0;
  private spreads = 1;
  private step = 1;
  private swipe = { travel: 0, locked: false, timer: undefined as ReturnType<typeof setTimeout> | undefined };
  current = 1;

  constructor(
    private viewer: HTMLElement,
    private container: HTMLElement,
    /** Called with the current section on every scroll, so the app can save your exact place. */
    private onMove: (section: number) => void,
    /** Called when you turn a page (paginated only), not when a resize or setting reflows it. */
    private onTurn: () => void = () => {},
  ) {
    viewer.addEventListener("scroll", () => {
      if (!this.book || this.paged || this.scrollQueued) return;
      this.scrollQueued = true;
      requestAnimationFrame(() => {
        this.scrollQueued = false;
        this.track();
      });
    });
    // Links inside the book: other chapters jump, the web opens in the browser (see lockDown in main).
    container.addEventListener("click", (e) => {
      const link = (e.target as Element).closest?.<HTMLAnchorElement>("a[data-section], a[data-external]");
      if (!link || !this.book) return;
      e.preventDefault();
      if (link.dataset.external) window.open(link.dataset.external);
      else this.goTo(Number(link.dataset.section), { anchor: link.dataset.target });
    });
    // Paginated, a swipe or a turn of the wheel turns one page per gesture. Ctrl + wheel stays zoom.
    // Listened for on the whole reading area, so a swipe that starts over a page-edge arrow counts too.
    (viewer.parentElement ?? viewer).addEventListener("wheel", (e) => {
      if (!this.book || !this.paged || e.ctrlKey) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const swipe = this.swipe;
      clearTimeout(swipe.timer);
      swipe.timer = setTimeout(() => Object.assign(swipe, { travel: 0, locked: false }), SWIPE_PAUSE_MS);
      if (swipe.locked) return;
      swipe.travel += delta;
      if (Math.abs(swipe.travel) < SWIPE_DISTANCE) return;
      swipe.locked = true;
      if (swipe.travel > 0) this.next();
      else this.prev();
    }, { passive: true });
  }

  /** True when the book is paginated rather than scrolling. */
  get paged() {
    return this.layout !== "scroll";
  }

  /** Paginated: on the first page of the book, or the last. */
  get atStart() {
    return this.current <= 1 && this.spread === 0;
  }

  /** Paginated: on the last page of the last section. */
  get atEnd() {
    return this.current >= this.sheets.length && this.spread >= this.spreads - 1;
  }

  get count() {
    return this.sheets.length;
  }

  get zoomLevel() {
    return this.zoom;
  }

  /** Shows the book and scrolls to `start`, a section number whose fraction is how far through it to go. */
  async load(book: EpubBook, start: number) {
    this.clear();
    this.book = book;
    this.container.classList.add("epub");
    this.applyZoom();
    this.sheets = book.sections.map((p, i) => {
      const sheet = document.createElement("article");
      sheet.className = "epub-section";
      sheet.dataset.page = String(i + 1);
      // Marks where the text ends, so a paginated section can count its pages.
      const end = document.createElement("span");
      end.className = "epub-end";
      sheet.append(...this.render(p), end);
      return sheet;
    });
    this.container.replaceChildren(...this.sheets);
    this.applyLayout();
    // Images change the height of everything after them, so wait for them before scrolling to a saved spot.
    await Promise.race([
      Promise.all([...this.container.querySelectorAll("img")].map((img) => img.decode().catch(() => {}))),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
    if (this.book !== book) return;
    this.goTo(Math.floor(start), { fraction: start % 1 });
    // An image that arrives after that changes how many pages its section has: re-count, keeping your place.
    let recount: ReturnType<typeof setTimeout> | undefined;
    for (const img of this.container.querySelectorAll("img")) {
      if (img.complete) continue;
      img.addEventListener("load", () => {
        clearTimeout(recount);
        recount = setTimeout(() => this.book === book && this.relayout(), 100);
      }, { once: true });
    }
  }

  /** Empties the viewer and frees the book's images. */
  clear() {
    this.book = null;
    this.sheets = [];
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
    this.container.classList.remove("epub", "paged");
    this.viewer.classList.remove("epub-paged");
    for (const prop of ["--epub-font-size", "--epub-measure", "--page-w", "--page-h", "--cols", "--gap"]) this.container.style.removeProperty(prop);
    this.container.replaceChildren();
  }

  /** Switches between scrolling and one or two pages, keeping your place. */
  setLayout(layout: EpubLayout) {
    if (layout === this.layout) return;
    const at = this.sheets.length ? this.position() : null;
    this.layout = layout;
    if (at === null) return;
    this.applyLayout();
    this.viewer.scrollTop = 0;
    this.goTo(Math.floor(at), { fraction: at % 1 });
  }

  /** Paginated: turns to the next page, into the next section after the last one. False if there's nowhere to go. */
  next(): boolean {
    if (!this.paged || !this.sheets.length) return false;
    if (this.spread < this.spreads - 1) {
      this.onTurn();
      this.showSpread(this.spread + 1, true);
      this.onMove(this.current);
      return true;
    }
    if (this.current >= this.sheets.length) return false;
    this.onTurn();
    this.turnTo(this.current + 1, "first", 1);
    return true;
  }

  /** Paginated: turns back a page, onto the last page of the section before at the start of one. */
  prev(): boolean {
    if (!this.paged || !this.sheets.length) return false;
    if (this.spread > 0) {
      this.onTurn();
      this.showSpread(this.spread - 1, true);
      this.onMove(this.current);
      return true;
    }
    if (this.current <= 1) return false;
    this.onTurn();
    this.turnTo(this.current - 1, "last", -1);
    return true;
  }

  /** Scrolls to a section: its start, a fraction through it, an anchor in it, or the place a passage was quoted from. */
  goTo(n: number, target: { fraction?: number; anchor?: string; passage?: string } = {}) {
    if (!this.sheets.length) return;
    const index = Math.min(Math.max(1, Math.round(n) || 1), this.sheets.length);
    const sheet = this.sheets[index - 1];
    const find = () =>
      (target.anchor && sheet.querySelector(`[data-anchor="${CSS.escape(target.anchor)}"]`)) ||
      (target.passage && findText(sheet, target.passage));
    if (this.paged) {
      const from = this.current;
      this.showSection(index);
      const spot = find();
      const spread = spot ? this.spreadOf(spot) : Math.floor((target.fraction ?? 0) * this.spreads + 1e-6);
      this.showSpread(spread, false);
      if (index !== from) this.slideIn(index > from ? 1 : -1);
      this.onMove(this.current);
      return;
    }
    let y = this.top(sheet) + (target.fraction ?? 0) * sheet.offsetHeight;
    const spot = find();
    if (spot) y += spot.getBoundingClientRect().top - sheet.getBoundingClientRect().top;
    this.viewer.scrollTop = y - 12;
    this.track();
  }

  /** Where you are: the current section plus how far through it, e.g. 4.25. */
  position(): number {
    const sheet = this.sheets[this.current - 1];
    if (!sheet) return 1;
    if (this.paged) return this.current + Math.min(0.999, this.spread / this.spreads);
    const along = (this.viewer.scrollTop + 12 - this.top(sheet)) / Math.max(1, sheet.offsetHeight);
    return this.current + Math.min(0.999, Math.max(0, along));
  }

  /** Sets how wide the text runs in Scroll and Single (in ems), keeping your place. Two pages ignores it. */
  setMeasure(ems: number) {
    const measure = Math.min(MAX_MEASURE, Math.max(MIN_MEASURE, ems));
    if (measure === this.measure) return;
    this.measure = measure;
    this.relayout();
  }

  setZoom(zoom: number) {
    if (zoom === this.zoom) return;
    this.zoom = zoom;
    this.relayout();
  }

  /** Re-flows the text (after a zoom or a width change), keeping the same spot in view. */
  relayout() {
    if (!this.sheets.length) return;
    const at = this.position();
    this.applyZoom();
    this.applyLayout();
    this.goTo(Math.floor(at), { fraction: at % 1 });
  }

  async text(n: number): Promise<string> {
    return this.sheets[n - 1]?.innerText ?? "";
  }

  private applyZoom() {
    this.container.style.setProperty("--epub-font-size", `${BASE_FONT_PX * this.zoom}px`);
    this.container.style.setProperty("--epub-measure", String(this.measure));
  }

  /**
   * Sizes the page box to the viewer. Two columns need room for about 20em
   * each; the measure is capped so lines stay readable in a wide window.
   */
  private applyLayout() {
    const paged = this.paged && this.sheets.length > 0;
    this.container.classList.toggle("paged", paged);
    this.viewer.classList.toggle("epub-paged", paged);
    for (const sheet of this.sheets) {
      sheet.classList.remove("current", "sliding");
      sheet.style.removeProperty("transform");
    }
    if (!paged) return;
    const font = BASE_FONT_PX * this.zoom;
    const room = this.viewer.clientWidth - 2 * PAGED_SIDE;
    const two = this.layout === "double" && room >= font * 42;
    const gap = Math.round(font * (two ? 3.5 : 3));
    // The Width setting is for Single and Scroll; Two pages that falls back to one keeps the default measure.
    const measure = this.layout === "single" ? this.measure : DEFAULT_MEASURE;
    const width = Math.max(200, Math.floor(Math.min(room, font * (two ? 70 : measure))));
    const height = Math.max(200, this.viewer.clientHeight - PAGED_TOP - PAGED_BOTTOM);
    this.step = width + gap;
    const style = this.container.style;
    style.setProperty("--page-w", `${width}px`);
    style.setProperty("--page-h", `${height}px`);
    style.setProperty("--cols", two ? "2" : "1");
    style.setProperty("--gap", `${gap}px`);
  }

  /** Paginated: shows section `n` alone and counts its spreads. */
  private showSection(n: number) {
    for (const sheet of this.sheets) {
      const on = Number(sheet.dataset.page) === n;
      sheet.classList.toggle("current", on);
      sheet.classList.remove("sliding");
      if (!on) sheet.style.removeProperty("transform");
    }
    this.current = n;
    const sheet = this.sheets[n - 1];
    const end = sheet.querySelector(".epub-end");
    const offset = end ? end.getBoundingClientRect().left - sheet.getBoundingClientRect().left : 0;
    this.spreads = Math.max(1, Math.floor((offset + 1) / this.step) + 1);
  }

  /** Paginated: moves the section sideways to `spread`, sliding there if `animate`. */
  private showSpread(spread: number, animate: boolean) {
    this.spread = Math.min(Math.max(0, spread), this.spreads - 1);
    const sheet = this.sheets[this.current - 1];
    sheet.classList.toggle("sliding", animate);
    sheet.style.transform = `translateX(${-this.spread * this.step}px)`;
  }

  /** Paginated: which spread an element (or the start of a passage) is on. */
  private spreadOf(el: Element | Range) {
    const sheet = this.sheets[this.current - 1];
    const left = el.getBoundingClientRect().left - sheet.getBoundingClientRect().left;
    return Math.floor((left + 1) / this.step);
  }

  /** Paginated: turns onto another section's first or last page, sliding it in from the side you're heading to. */
  private turnTo(n: number, at: "first" | "last", direction: 1 | -1) {
    this.showSection(n);
    this.showSpread(at === "first" ? 0 : this.spreads - 1, false);
    this.slideIn(direction);
    this.onMove(this.current);
  }

  /** A new section slides in from the side you're heading to, like the next page would. */
  private slideIn(direction: 1 | -1) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    this.sheets[this.current - 1].animate(
      [
        { translate: `${direction * 48}px 0`, opacity: 0 },
        { translate: "0 0", opacity: 1 },
      ],
      { duration: 280, easing: "cubic-bezier(0.22, 0.8, 0.3, 1)" },
    );
  }

  private top(sheet: HTMLElement) {
    return this.container.offsetTop + sheet.offsetTop;
  }

  private track() {
    const line = this.viewer.scrollTop + this.viewer.clientHeight * READING_LINE;
    let at = 0;
    while (at + 1 < this.sheets.length && this.top(this.sheets[at + 1]) <= line) at++;
    this.current = at + 1;
    this.onMove(this.current);
  }

  /** One spine item as clean nodes in this document. */
  private render(sectionPath: string): Node[] {
    const source = text(this.book!.files, sectionPath);
    let doc = new DOMParser().parseFromString(source, "application/xhtml+xml");
    // Plenty of EPUBs aren't valid XML (HTML entities, stray tags); the HTML parser takes anything.
    if (doc.querySelector("parsererror")) doc = new DOMParser().parseFromString(source, "text/html");
    const body = doc.body ?? doc.getElementsByTagNameNS("*", "body")[0];
    if (!body) return [];
    return [...body.childNodes].map((n) => this.clean(n, sectionPath)).filter((n): n is Node => !!n);
  }

  private clean(node: Node, sectionPath: string): Node | null {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent ?? "");
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const el = node as Element;
    const name = el.localName.toLowerCase();
    if (DROP.has(name)) return null;

    const copy = el.namespaceURI === "http://www.w3.org/2000/svg"
      ? document.createElementNS(el.namespaceURI, el.localName)
      : document.createElement(name === "body" ? "div" : name);
    for (const attr of el.attributes) {
      if (KEEP_ATTRS.has(attr.localName.toLowerCase())) copy.setAttribute(attr.localName, attr.value);
    }
    const id = el.getAttribute("id");
    if (id) copy.setAttribute("data-anchor", id);

    if (name === "img") {
      const url = this.resource(sectionPath, el.getAttribute("src"));
      if (!url) return null;
      copy.setAttribute("src", url);
    } else if (name === "image") {
      const url = this.resource(sectionPath, el.getAttributeNS(XLINK_NS, "href") ?? el.getAttribute("href"));
      if (!url) return null;
      copy.setAttribute("href", url);
    } else if (name === "a") {
      this.link(copy, sectionPath, el.getAttributeNS(XLINK_NS, "href") ?? el.getAttribute("href"));
    }

    for (const child of el.childNodes) {
      const cleaned = this.clean(child, sectionPath);
      if (cleaned) copy.append(cleaned);
    }
    return copy;
  }

  private link(a: Element, from: string, href: string | null) {
    if (!href) return;
    if (/^https?:\/\//i.test(href)) {
      a.setAttribute("data-external", href);
    } else if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      const [file, anchor] = resolve(from, href).split("#");
      const section = this.book!.sections.indexOf(file) + 1;
      if (!section) return;
      a.setAttribute("data-section", String(section));
      if (anchor) a.setAttribute("data-target", anchor);
    } else {
      return;
    }
    a.setAttribute("href", "#");
  }

  private resource(from: string, href: string | null): string | null {
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
    const file = this.book!.files[resolve(from, href).split("#")[0]];
    if (!file) return null;
    const url = URL.createObjectURL(new Blob([file as BlobPart], { type: imageType(href) }));
    this.urls.push(url);
    return url;
  }
}

/**
 * The first character of `passage`, matching through any whitespace and
 * markup. A range rather than its element, so a passage in the middle of a
 * long paragraph is found where it is, even on a later page than the paragraph's start.
 */
function findText(root: Element, passage: string): Range | null {
  const needle = passage.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!needle) return null;
  let flat = "";
  const owners: { node: Node; offset: number }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    for (let i = 0; i < text.length; i++) {
      const c = /\s/.test(text[i]) ? " " : text[i];
      if (c === " " && flat.endsWith(" ")) continue;
      flat += c;
      owners.push({ node, offset: i });
    }
  }
  const at = flat.indexOf(needle);
  if (at < 0) return null;
  const range = document.createRange();
  range.setStart(owners[at].node, owners[at].offset);
  range.setEnd(owners[at].node, owners[at].offset + 1);
  return range;
}

function text(files: Record<string, Uint8Array>, filePath: string): string {
  const file = files[filePath];
  if (!file) throw new Error(`This EPUB is missing ${filePath}.`);
  return new TextDecoder().decode(file);
}

function xml(source: string): Document {
  return new DOMParser().parseFromString(source, "application/xml");
}

function html(source: string): Document {
  const doc = new DOMParser().parseFromString(source, "application/xhtml+xml");
  return doc.querySelector("parsererror") ? new DOMParser().parseFromString(source, "text/html") : doc;
}

/** Resolves `href` against the file it appears in; zip paths have no leading slash. */
function resolve(from: string, href: string): string {
  const [pathPart, hash] = href.split("#");
  const parts = from.split("/").slice(0, -1);
  for (const seg of decodeURIComponent(pathPart).split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  const joined = pathPart ? parts.join("/") : from;
  return hash !== undefined ? `${joined}#${hash}` : joined;
}

function imageType(href: string): string {
  const ext = href.split(/[?#]/)[0].split(".").pop()?.toLowerCase();
  return ext === "svg" ? "image/svg+xml" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/png";
}
