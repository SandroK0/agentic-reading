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
 * The book as one column of sections, each on its own sheet, in the reader's
 * theme. Zoom scales the type; the text reflows to the viewer's width.
 */
export class EpubView {
  private book: EpubBook | null = null;
  private sheets: HTMLElement[] = [];
  private urls: string[] = [];
  private zoom = 1;
  private scrollQueued = false;
  current = 1;

  constructor(
    private viewer: HTMLElement,
    private container: HTMLElement,
    /** Called with the current section on every scroll, so the app can save your exact place. */
    private onMove: (section: number) => void,
  ) {
    viewer.addEventListener("scroll", () => {
      if (!this.book || this.scrollQueued) return;
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
      sheet.append(...this.render(p));
      return sheet;
    });
    this.container.replaceChildren(...this.sheets);
    // Images change the height of everything after them, so wait for them before scrolling to a saved spot.
    await Promise.race([
      Promise.all([...this.container.querySelectorAll("img")].map((img) => img.decode().catch(() => {}))),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
    if (this.book !== book) return;
    this.goTo(Math.floor(start), { fraction: start % 1 });
  }

  /** Empties the viewer and frees the book's images. */
  clear() {
    this.book = null;
    this.sheets = [];
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
    this.container.classList.remove("epub");
    this.container.style.removeProperty("--epub-font-size");
    this.container.replaceChildren();
  }

  /** Scrolls to a section: its start, a fraction through it, an anchor in it, or the place a passage was quoted from. */
  goTo(n: number, target: { fraction?: number; anchor?: string; passage?: string } = {}) {
    if (!this.sheets.length) return;
    const sheet = this.sheets[Math.min(Math.max(1, Math.round(n) || 1), this.sheets.length) - 1];
    let y = this.top(sheet) + (target.fraction ?? 0) * sheet.offsetHeight;
    const spot =
      (target.anchor && sheet.querySelector(`[data-anchor="${CSS.escape(target.anchor)}"]`)) ||
      (target.passage && findText(sheet, target.passage));
    if (spot) y += spot.getBoundingClientRect().top - sheet.getBoundingClientRect().top;
    this.viewer.scrollTop = y - 12;
    this.track();
  }

  /** Where you are: the current section plus how far through it, e.g. 4.25. */
  position(): number {
    const sheet = this.sheets[this.current - 1];
    if (!sheet) return 1;
    const along = (this.viewer.scrollTop + 12 - this.top(sheet)) / Math.max(1, sheet.offsetHeight);
    return this.current + Math.min(0.999, Math.max(0, along));
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
    this.goTo(Math.floor(at), { fraction: at % 1 });
  }

  async text(n: number): Promise<string> {
    return this.sheets[n - 1]?.innerText ?? "";
  }

  private applyZoom() {
    this.container.style.setProperty("--epub-font-size", `${BASE_FONT_PX * this.zoom}px`);
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

/** The first element holding the start of `passage`, matching through any whitespace and markup. */
function findText(root: Element, passage: string): Element | null {
  const needle = passage.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!needle) return null;
  let flat = "";
  const owners: Node[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const ch of node.textContent ?? "") {
      const c = /\s/.test(ch) ? " " : ch;
      if (c === " " && flat.endsWith(" ")) continue;
      flat += c;
      owners.push(node);
    }
  }
  const at = flat.indexOf(needle);
  return at < 0 ? null : (owners[at].parentElement ?? null);
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
