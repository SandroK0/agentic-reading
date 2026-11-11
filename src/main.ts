import * as pdfjsLib from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";
import type { ExplainMode, LibraryBook, ReaderApi } from "../shared/types";
import { Pages } from "./pages";
import { PanelWindow } from "./panel-window";
import { allThemesCss, themeById, THEMES } from "../shared/themes";
import { ExplanationCards, type CardScope } from "./cards";
import { resizableSidebar } from "./resize";
import { enableTextSelection } from "./selection";
import { collectContentsSource } from "./contents-source";
import { Contents, pdfOutline } from "./toc";
import { EpubView, parseEpub } from "./epub";
import "./style.css";

declare global {
  interface Window {
    reader: ReaderApi;
  }
}
const api = window.reader;

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).href;

const PASSAGE_CONTEXT_CHARS = 1500;
const PAGE_CONTEXT_CHARS = 6000;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const viewer = $("viewer");
const pagesEl = $("pages");
const titleEl = $("title");
const subtitleEl = $("subtitle");
const homeBtn = $<HTMLButtonElement>("home-btn");
const tbDivider = $("tb-divider");
const nav = $("nav");
const pagePrefix = $("page-prefix");
const progressLabel = $("progress-label");
const progressPct = $("progress-pct");
const progressBar = $("progress-bar");
const tocBody = $("toc-body");
const tocFilter = $<HTMLInputElement>("toc-filter");
const pageInput = $<HTMLInputElement>("page-input");
const pageTotal = $("page-total");
const prevBtn = $<HTMLButtonElement>("prev");
const nextBtn = $<HTMLButtonElement>("next");
const zoomLabel = $("zoom-label");
const modelSelect = $<HTMLSelectElement>("model");
const themeSelect = $<HTMLSelectElement>("theme");
const selectionMenu = $("selection-menu");
const questionInput = $<HTMLInputElement>("selection-question");
const cardsEl = $("cards");
const cardsEmpty = $("cards-empty");
const emptyEl = $("empty");
const tocEl = $("toc");
const tocBtn = $<HTMLButtonElement>("toc-btn");
const contents = new Contents(tocBody, (page, anchor) => goTo(page, { anchor }), {
  async generate(onProgress, signal) {
    const current = book!;
    if (!current.pdf) throw new Error("Only PDFs can have contents generated.");
    const total = current.pageCount;
    onProgress(`Reading page 1 of ${total}…`);
    const source = await collectContentsSource(current.pdf, current.title, (n) => onProgress(`Reading page ${n} of ${total}…`), signal);
    onProgress("Writing the contents. This can take a minute…");
    signal.addEventListener("abort", () => void api.cancelContents(current.path), { once: true });
    try {
      return (await api.generateContents(current.path, source)).entries;
    } catch (err) {
      throw new Error(ipcMessage(err));
    }
  },
  remove: () => api.removeContents(book!.path),
});

/** The message of an error thrown in the main process, without Electron's "Error invoking remote method" wrapper. */
function ipcMessage(err: unknown): string {
  return String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, "");
}
const pages = new Pages(viewer, pagesEl, showPage);
const epubView = new EpubView(viewer, pagesEl, showPage);
enableTextSelection(viewer);

/**
 * An open book. In a PDF a "page" is a page; in an EPUB it's one section of
 * the book's reading order (usually a chapter), which the rest of the app
 * treats just like a page.
 */
interface Book {
  path: string;
  title: string;
  kind: "pdf" | "epub";
  pageCount: number;
  pdf?: pdfjsLib.PDFDocumentProxy;
}

let book: Book | null = null;
/** Whichever reader is showing the open book. */
let view: Pages | EpubView = pages;

const BOOK_FILE = /\.(pdf|epub)$/i;

/** Scrolls to a page; in an EPUB also to an anchor or a quoted passage within it. */
function goTo(page: number, target: { anchor?: string; passage?: string } = {}) {
  if (view instanceof EpubView) view.goTo(page, target);
  else view.goTo(page);
}

// ---------- Opening books ----------

async function openBook(path: string) {
  let bytes: Uint8Array;
  try {
    bytes = await api.readBook(path);
  } catch (err) {
    alert(`Couldn't open this file.\n\n${(err as Error).message}`);
    return;
  }
  const fileName = path.split("/").pop()!.replace(BOOK_FILE, "");
  const isEpub = /\.epub$/i.test(path);
  let epub: ReturnType<typeof parseEpub> | null = null;
  let pdf: pdfjsLib.PDFDocumentProxy | null = null;
  let metaTitle: string | undefined;
  try {
    if (isEpub) {
      epub = parseEpub(bytes);
      metaTitle = epub.title ?? undefined;
    } else {
      pdf = await pdfjsLib.getDocument({
        data: bytes,
        standardFontDataUrl: "./pdfjs/standard_fonts/",
        cMapUrl: "./pdfjs/cmaps/",
        cMapPacked: true,
      }).promise;
      const meta = await pdf.getMetadata().catch(() => null);
      metaTitle = (meta?.info as { Title?: string } | undefined)?.Title?.trim();
    }
  } catch (err) {
    alert(`Couldn't read this book.\n\n${(err as Error).message}`);
    return;
  }

  await book?.pdf?.destroy();
  const pageCount = epub ? epub.sections.length : pdf!.numPages;
  book = {
    path,
    title: metaTitle && metaTitle.length > 3 ? metaTitle : fileName,
    kind: epub ? "epub" : "pdf",
    pageCount,
    pdf: pdf ?? undefined,
  };

  titleEl.textContent = book.title;
  subtitleEl.hidden = true;
  document.title = `${book.title} — Agentic Reading`;
  panelWindow.setTitle(`Explanations — ${book.title}`);
  void api.saveBookInfo(path, { title: book.title, kind: book.kind, pageCount });
  pageTotal.textContent = `/ ${pageCount}`;
  pageInput.max = String(pageCount);
  pageInput.style.width = `${String(pageCount).length + 1}ch`;
  pagePrefix.hidden = !epub;
  tocFilter.value = "";
  filterContents("");
  const unit = epub ? "Section" : "Page";
  pageInput.setAttribute("aria-label", `${unit} number`);
  pageInput.title = epub ? "Section of the book (usually a chapter)" : "";
  prevBtn.setAttribute("aria-label", `Previous ${unit.toLowerCase()}`);
  nextBtn.setAttribute("aria-label", `Next ${unit.toLowerCase()}`);
  nav.hidden = false;
  emptyEl.hidden = true;
  pagesEl.hidden = false;
  tocBtn.hidden = false;
  homeBtn.hidden = false;
  tbDivider.hidden = false;
  setTocVisible(tocPreference());

  const state = await api.bookState(path);
  if (epub) {
    const own = epub.contents;
    void contents.load(async () => own, undefined, false);
  } else {
    void contents.load(() => pdfOutline(pdf!), state.generatedContents?.entries);
  }
  explanations.show(path, state.explanations);
  if (epub) {
    pages.clear();
    view = epubView;
    await epubView.load(epub, state.page);
  } else {
    epubView.clear();
    view = pages;
    await pages.load(pdf!, state.page);
  }
}

// ---------- Library ----------

const svg = (paths: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const SPARK = svg('<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1L5 10.5l5.1-1.9z" />');
const UPLOAD = svg('<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15" />');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

function bookName(b: LibraryBook): string {
  return b.info?.title ?? b.path.split("/").pop()!.replace(BOOK_FILE, "");
}

function bookKind(b: LibraryBook): "pdf" | "epub" {
  return b.info?.kind ?? (/\.epub$/i.test(b.path) ? "epub" : "pdf");
}

/** A cover made from the title, in one of the theme's four categorical colours, picked by the path so it stays put. */
function cover(b: LibraryBook): HTMLElement {
  let hash = 0;
  for (const ch of b.path) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const c = el("div", `cover c${(Math.abs(hash) % 4) + 1}`);
  c.append(el("span", "cover-title", bookName(b)), el("span", "cover-kind", bookKind(b).toUpperCase()));
  return c;
}

/** "Page 300 of 675", "§ 4 of 30", or nothing when the book hasn't been measured yet. */
function whereIn(b: LibraryBook): string {
  if (!b.info) return "";
  return bookKind(b) === "epub" ? `§ ${b.page} of ${b.info.pageCount}` : `Page ${b.page} of ${b.info.pageCount}`;
}

function percentRead(b: LibraryBook): number | null {
  if (!b.info || b.info.pageCount < 1) return null;
  return Math.round((Math.min(b.page, b.info.pageCount) / b.info.pageCount) * 100);
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function openedWhen(at?: number): string {
  if (!at) return "";
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days <= 0 && new Date(at).toDateString() === new Date().toDateString()) return "Opened today";
  if (days <= 1) return "Opened yesterday";
  if (days < 7) return `Opened ${days} days ago`;
  return `Opened ${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function continueCard(b: LibraryBook): HTMLElement {
  const box = el("div", "continue");
  const info = el("div", "continue-info");
  const meta = el("div", "continue-meta");
  meta.append(el("span", "badge", bookKind(b).toUpperCase()));
  const when = openedWhen(b.openedAt);
  if (when) meta.append(el("span", "", when));
  info.append(meta, el("h3", "", bookName(b)));

  const pct = percentRead(b);
  if (pct !== null) {
    const progress = el("div", "continue-progress");
    const label = el("div", "toc-progress");
    label.append(el("span", "", whereIn(b)), el("span", "", `${pct}%`));
    const bar = el("div", "progress");
    const fill = el("div", "progress-fill");
    fill.style.width = `${pct}%`;
    bar.append(fill);
    progress.append(label, bar);
    info.append(progress);
  }

  const actions = el("div", "continue-actions");
  const resume = el("button", "primary", "Resume reading");
  resume.onclick = () => void openBook(b.path);
  actions.append(resume);
  if (b.explanationCount) {
    const n = el("span");
    n.innerHTML = SPARK;
    n.append(plural(b.explanationCount, "explanation"));
    actions.append(n);
  }
  info.append(actions);
  box.append(cover(b), info);
  return box;
}

function bookTile(b: LibraryBook): HTMLElement {
  const tile = el("button", "book-tile");
  tile.title = b.path;
  tile.onclick = () => void openBook(b.path);
  const meta = el("span", "book-tile-meta");
  const pct = percentRead(b);
  const parts = [
    pct === null ? "" : pct >= 100 ? "Finished" : b.page <= 1 ? "Not started" : `${pct}%`,
    b.explanationCount ? plural(b.explanationCount, "explanation") : "",
  ].filter(Boolean);
  meta.textContent = parts.join(" · ");
  tile.append(cover(b), el("span", "book-tile-name", bookName(b)), meta);
  return tile;
}

/** The home screen: the book you were last reading, the others you've opened, and how to add more. */
async function showLibrary() {
  const books = await api.library();
  if (book) return;
  const parts: HTMLElement[] = [];
  if (!books.length) {
    const welcome = el("div", "welcome");
    const open = el("button", "primary", "Open a book");
    open.onclick = () => $("open-btn").click();
    welcome.append(
      el("h1", "", "Open a book to start reading"),
      el("p", "", "Select any passage and choose Explain for a few sentences, or Explain visually for a drawing."),
      open,
    );
    parts.push(welcome);
  } else {
    const [latest, ...rest] = books;
    const current = el("section");
    current.append(el("h2", "", "Continue reading"), continueCard(latest));
    parts.push(current);
    if (rest.length) {
      const recent = el("section");
      const head = el("div", "library-section-head");
      head.append(el("h2", "", "Recent"), el("span", "", plural(rest.length, "book")));
      const shelf = el("div", "shelf");
      shelf.append(...rest.map(bookTile));
      recent.append(head, shelf);
      parts.push(recent);
    }
  }
  const drop = el("div", "dropzone");
  drop.innerHTML = UPLOAD;
  drop.append("Drop a PDF or EPUB anywhere in the window to open it");
  parts.push(drop);
  emptyEl.replaceChildren(...parts);
}

/** Puts the book away and goes back to the library. */
async function closeBook() {
  if (!book) return;
  clearTimeout(savePageTimer);
  await api.savePage(book.path, view.position());
  hideMenu();
  await book.pdf?.destroy();
  book = null;
  pages.clear();
  epubView.clear();
  pagesEl.replaceChildren();
  pagesEl.hidden = true;
  nav.hidden = true;
  tocEl.hidden = true;
  tocBtn.hidden = true;
  homeBtn.hidden = true;
  tbDivider.hidden = true;
  titleEl.textContent = "Agentic Reading";
  subtitleEl.hidden = true;
  document.title = "Agentic Reading";
  explanations.show("", []);
  emptyEl.hidden = false;
  viewer.scrollTop = 0;
  await showLibrary();
}

// ---------- Page tracking ----------

let savePageTimer: ReturnType<typeof setTimeout> | undefined;

/** Called whenever the page you're reading changes (for an EPUB, whenever you scroll), by scrolling or jumping. */
function showPage(n: number) {
  if (!book) return;
  if (document.activeElement !== pageInput) pageInput.value = String(n);
  contents.setPage(n);
  explanations.setPage(n);
  const chapter = tocBody.querySelector(".toc-link.active > span:first-child")?.textContent ?? "";
  subtitleEl.textContent = chapter;
  subtitleEl.hidden = !chapter;
  const pct = Math.round((n / book.pageCount) * 100);
  progressLabel.textContent = book.kind === "epub" ? `Section ${n} of ${book.pageCount}` : `Page ${n} of ${book.pageCount}`;
  progressPct.textContent = `${pct}%`;
  progressBar.style.width = `${pct}%`;
  prevBtn.disabled = n <= 1;
  nextBtn.disabled = n >= book.pageCount;
  clearTimeout(savePageTimer);
  const path = book.path;
  const reader = view;
  savePageTimer = setTimeout(() => api.savePage(path, reader.position()), 400);
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;

function setZoom(zoom: number, anchor?: { x: number; y: number }) {
  view.setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)), anchor);
  zoomLabel.textContent = `${Math.round(view.zoomLevel * 100)}%`;
}

// Ctrl + scroll zooms around the pointer. A trackpad pinch arrives the same way, in smaller steps.
viewer.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey || !book) return;
    e.preventDefault();
    const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
    const box = viewer.getBoundingClientRect();
    setZoom(view.zoomLevel * Math.exp(-delta * 0.0015), { x: e.clientX - box.left, y: e.clientY - box.top });
  },
  { passive: false },
);

// ---------- Window ----------

// On macOS the window buttons sit inside the toolbar (see createWindow); make room for them.
document.documentElement.classList.toggle("inset-titlebar", api.platform === "darwin");
api.onFullscreen((fullscreen) => document.documentElement.classList.toggle("fullscreen", fullscreen));

// ---------- Theme ----------

const THEME_KEY = "visual-reader:theme";

const themeStyle = document.createElement("style");
themeStyle.textContent = allThemesCss();
document.head.append(themeStyle);

function currentTheme(): string {
  return document.documentElement.dataset.theme ?? "ink";
}

const darkSystem = matchMedia("(prefers-color-scheme: dark)");

/** The palette the reader is showing: dark-only themes are always dark, the rest follow the system. */
function currentScheme(): "light" | "dark" {
  return themeById(currentTheme()).darkOnly || darkSystem.matches ? "dark" : "light";
}

// Drawings are told which palette to use, so redraw them when the system switches between light and dark.
darkSystem.addEventListener("change", () => explanations.refreshDrawings());

/** Applies a theme to the reader and re-renders open drawings in it. */
function applyTheme(id: string | null) {
  const theme = themeById(id);
  document.documentElement.dataset.theme = theme.id;
  themeSelect.value = theme.id;
  for (const tile of themeTiles.children) tile.setAttribute("aria-pressed", String((tile as HTMLElement).dataset.theme === theme.id));
  $("theme-note").textContent = theme.darkOnly ? "Always dark" : "Follows your Mac";
  try {
    localStorage.setItem(THEME_KEY, theme.id);
  } catch {
    // the choice just won't persist
  }
  explanations.refreshDrawings();
  panelWindow.setTheme(theme.id);
}

themeSelect.append(...THEMES.map((t) => new Option(t.label, t.id)));
themeSelect.onchange = () => applyTheme(themeSelect.value);

/** One tile per theme, drawn in that theme's own colours for the scheme you'd see it in. */
const themeTiles = $("theme-tiles");
themeTiles.replaceChildren(
  ...THEMES.map((t) => {
    const p = t.darkOnly || darkSystem.matches ? t.dark : t.light;
    const tile = el("button", "theme-tile");
    tile.dataset.theme = t.id;
    tile.setAttribute("aria-pressed", "false");
    const swatch = el("span", "theme-swatch");
    swatch.style.background = p.canvas;
    const page = el("span", "theme-swatch-page");
    page.style.background = p.bg;
    for (const [w, c, o] of [["70%", p.text, 0.6], ["90%", p.text, 0.3], ["50%", p.accent, 1]] as const) {
      const line = el("i");
      Object.assign(line.style, { width: w, background: c, opacity: String(o) });
      page.append(line);
    }
    const side = el("span", "theme-swatch-side");
    side.style.background = p.accent;
    swatch.append(page, side);
    const label = el("span", "theme-label");
    label.append(el("b", "", t.label), el("span", "", t.darkOnly ? "Always dark" : "Light or dark"));
    tile.append(swatch, label);
    tile.onclick = () => applyTheme(t.id);
    return tile;
  }),
);

// ---------- Settings popover ----------

const settingsEl = $("settings");
const settingsBtn = $<HTMLButtonElement>("settings-btn");

function setSettingsOpen(open: boolean) {
  settingsEl.hidden = !open;
  settingsBtn.setAttribute("aria-expanded", String(open));
  settingsBtn.setAttribute("aria-pressed", String(open));
}
settingsBtn.onclick = () => setSettingsOpen(settingsEl.hidden);
document.addEventListener("mousedown", (e) => {
  if (!settingsEl.hidden && !settingsEl.contains(e.target as Node) && !settingsBtn.contains(e.target as Node)) setSettingsOpen(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !settingsEl.hidden) setSettingsOpen(false);
});

// ---------- Contents sidebar ----------

const TOC_KEY = "visual-reader:toc-visible";

function tocPreference(): boolean {
  try {
    return localStorage.getItem(TOC_KEY) !== "false";
  } catch {
    return true;
  }
}

function setTocVisible(visible: boolean) {
  tocEl.hidden = !visible;
  tocBtn.setAttribute("aria-pressed", String(visible));
  try {
    localStorage.setItem(TOC_KEY, String(visible));
  } catch {
    // preference just won't persist
  }
}

tocBtn.onclick = () => setTocVisible(tocEl.hidden);

/** Hides contents entries that don't match, keeping the parents of those that do. */
function filterContents(query: string) {
  const q = query.trim().toLowerCase();
  tocBody.classList.toggle("filtering", !!q);
  const visit = (li: HTMLLIElement): boolean => {
    const own = li.querySelector(":scope > .toc-row .toc-link")?.textContent?.toLowerCase() ?? "";
    let match = !q || own.includes(q);
    for (const child of li.querySelectorAll<HTMLLIElement>(":scope > ul > li")) if (visit(child)) match = true;
    li.classList.toggle("filtered-out", !match);
    return match;
  };
  for (const li of tocBody.querySelectorAll<HTMLLIElement>(":scope > ul > li")) visit(li);
}
tocFilter.oninput = () => filterContents(tocFilter.value);
tocFilter.onkeydown = (e) => {
  if (e.key === "Escape") {
    tocFilter.value = "";
    filterContents("");
  }
};

// ---------- Selection ----------

function selectedPassage(): { text: string; page: number; rect: DOMRect; upward: boolean } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const anchor = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
  const pageEl =
    anchor?.closest<HTMLElement>(".textLayer")?.closest<HTMLElement>(".page") ?? anchor?.closest<HTMLElement>(".epub-section");
  if (!pageEl || !pagesEl.contains(pageEl)) return null;
  const text = sel.toString().replace(/\s+/g, " ").trim();
  if (text.length < 2) return null;
  return { text, page: Number(pageEl.dataset.page), ...selectionEnd(sel) };
}

/**
 * Where the selection ends, as the line box of its moving end. The range's own
 * bounding box is no use once a selection crosses pages: it takes in the next
 * page's whole canvas, so its bottom can be far off screen.
 */
function selectionEnd(sel: Selection): { rect: DOMRect; upward: boolean } {
  const { anchorNode, anchorOffset, focusNode, focusOffset } = sel;
  const upward =
    anchorNode === focusNode
      ? focusOffset < anchorOffset
      : !!(anchorNode && focusNode && anchorNode.compareDocumentPosition(focusNode) & Node.DOCUMENT_POSITION_PRECEDING);
  const caret = document.createRange();
  if (focusNode) caret.setStart(focusNode, focusOffset);
  const rects = caret.getClientRects();
  const rect = rects.length ? rects[0] : (focusNode?.parentElement ?? viewer).getBoundingClientRect();
  return { rect, upward };
}

/** Shows the menu just below where the selection ends, or above it when you dragged upwards. */
function showMenu(rect: DOMRect, upward: boolean) {
  const box = viewer.getBoundingClientRect();
  selectionMenu.hidden = false;
  const w = selectionMenu.offsetWidth;
  const h = selectionMenu.offsetHeight;
  // clientWidth leaves out the scrollbar, so the menu never sticks out under it.
  const left = Math.min(Math.max(8, rect.left - box.left - w / 2), viewer.clientWidth - w - 8);
  let top = upward ? rect.top - box.top - h - 8 : rect.bottom - box.top + 8;
  // Keep it inside the visible part of the viewer.
  top = Math.min(Math.max(8, top), viewer.clientHeight - h - 8);
  selectionMenu.style.left = `${left + viewer.scrollLeft}px`;
  selectionMenu.style.top = `${top + viewer.scrollTop}px`;
}

/** The selection the open menu is for. Kept, because focusing the question box clears the page selection. */
let pendingSelection: { text: string; page: number } | null = null;

/**
 * Paints the menu's passage with the CSS Highlight API, so it stays marked
 * while focus is in the question box and the page selection itself is gone.
 */
const PENDING_HIGHLIGHT = "pending-selection";

function markPending(range: Range | null) {
  if (range) CSS.highlights.set(PENDING_HIGHLIGHT, new Highlight(range));
  else CSS.highlights.delete(PENDING_HIGHLIGHT);
}

function hideMenu() {
  selectionMenu.hidden = true;
  pendingSelection = null;
  questionInput.value = "";
  markPending(null);
}

function explainSelection(mode: ExplainMode) {
  const sel = pendingSelection;
  if (!sel) return;
  const question = questionInput.value.trim() || undefined;
  hideMenu();
  window.getSelection()?.removeAllRanges();
  void explainPassage(sel.page, sel.text, mode, question);
}

async function surrounding(page: number, passage: string): Promise<string> {
  const text = (await view.text(page)).replace(/\s+/g, " ");
  const at = text.indexOf(passage.slice(0, 60));
  if (at < 0) return text.slice(0, PASSAGE_CONTEXT_CHARS * 2);
  return text.slice(Math.max(0, at - PASSAGE_CONTEXT_CHARS), at + passage.length + PASSAGE_CONTEXT_CHARS);
}

// ---------- Explanations ----------

const SCOPE_KEY = "visual-reader:card-scope";
const scopeButtons: Record<CardScope, HTMLButtonElement> = { page: $("scope-page"), all: $("scope-all") };

function showScope(scope: CardScope) {
  for (const [s, b] of Object.entries(scopeButtons)) b.setAttribute("aria-selected", String(s === scope));
  try {
    localStorage.setItem(SCOPE_KEY, scope);
  } catch {
    // the choice just won't persist
  }
}

function storedScope(): CardScope {
  try {
    return localStorage.getItem(SCOPE_KEY) === "all" ? "all" : "page";
  } catch {
    return "page";
  }
}

const explanations = new ExplanationCards(cardsEl, cardsEmpty, { all: $("count"), page: $("count-page") }, {
  api,
  goTo: (page, passage) => goTo(page, { passage }),
  pageLabel: (page) =>
    book?.kind === "epub"
      ? { short: `§ ${page}`, title: "Go to this passage" }
      : { short: `p. ${page}`, title: "Go to this page" },
  look: () => ({ theme: currentTheme(), scheme: currentScheme() }),
  // A new explanation shouldn't land in a hidden panel.
  onStart: () => {
    if (panelWindow.place === "hidden") panelWindow.dock();
  },
  book: () => (book ? { path: book.path, title: book.title, pageCount: book.pageCount } : null),
  onScope: showScope,
}, storedScope());
showScope(storedScope());
scopeButtons.page.onclick = () => explanations.setScope("page");
scopeButtons.all.onclick = () => explanations.setScope("all");

async function explainPassage(page: number, passage: string, mode: ExplainMode, question?: string) {
  if (!book) return;
  const current = book;
  const context = passage ? await surrounding(page, passage) : (await view.text(page)).slice(0, PAGE_CONTEXT_CHARS);
  if (book !== current) return;
  explanations.explain(current.path, {
    mode,
    question,
    bookPath: current.path,
    bookTitle: current.title,
    page,
    pageCount: current.pageCount,
    passage,
    context,
  });
}

api.onExplainEvent((event) => explanations.onEvent(event));
const handleFrameMessage = (e: MessageEvent) => explanations.onFrameMessage(e);
window.addEventListener("message", handleFrameMessage);

// ---------- Explanations panel: docked, own window, or hidden ----------

const panelEl = $("panel");
const panelBtn = $<HTMLButtonElement>("panel-btn");
const popoutBtn = $<HTMLButtonElement>("panel-popout");
const panelWindow = new PanelWindow(panelEl, {
  onFrameMessage: handleFrameMessage,
  onChange: (place) => {
    panelBtn.setAttribute("aria-pressed", String(place !== "hidden"));
    const label = place === "window" ? "Put back beside the page" : "Open in a new window";
    popoutBtn.title = label;
    popoutBtn.setAttribute("aria-label", label);
    if (place === "window" && book) panelWindow.setTitle(`Explanations — ${book.title}`);
  },
});
popoutBtn.onclick = () => (panelWindow.place === "window" ? panelWindow.dock() : panelWindow.popOut());
$("panel-close").onclick = () => panelWindow.hide();
$("panel-collapse-all").onclick = () => explanations.toggleAll();
panelBtn.onclick = () => panelWindow.toggle();

// ---------- Wiring ----------

$("open-btn").onclick = async () => {
  const picked = await api.openDialog();
  if (picked) await openBook(picked);
};
api.onOpenBook((path) => void openBook(path));
homeBtn.onclick = () => void closeBook();

prevBtn.onclick = () => goTo(view.current - 1);
nextBtn.onclick = () => goTo(view.current + 1);
pageInput.onchange = () => goTo(Number(pageInput.value));
$("zoom-in").onclick = () => setZoom(view.zoomLevel + 0.25);
$("zoom-out").onclick = () => setZoom(view.zoomLevel - 0.25);

// Options are "<provider>/<model>"; provider ids never contain a slash.
modelSelect.onchange = () => {
  const [provider, ...rest] = modelSelect.value.split("/");
  void api.saveSettings({ provider, model: rest.join("/") });
  showModel();
};

// Keep the selection alive when a menu button is pressed; the question box still takes focus.
selectionMenu.onmousedown = (e) => {
  if (e.target !== questionInput) e.preventDefault();
};
questionInput.onkeydown = (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    explainSelection("text");
  } else if (e.key === "Escape") {
    hideMenu();
  }
};
$("explain-text").onclick = () => explainSelection("text");
$("explain-visual").onclick = () => explainSelection("visual");

document.addEventListener("mouseup", (e) => {
  if (selectionMenu.contains(e.target as Node)) return;
  setTimeout(() => {
    const sel = selectedPassage();
    if (sel) {
      // A new selection starts with an empty question.
      if (sel.text !== pendingSelection?.text) questionInput.value = "";
      pendingSelection = { text: sel.text, page: sel.page };
      markPending(window.getSelection()!.getRangeAt(0).cloneRange());
      showMenu(sel.rect, sel.upward);
    }
    else hideMenu();
  });
});

document.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
  if (!book) return;
  if (e.key === "ArrowRight") goTo(view.current + 1);
  else if (e.key === "ArrowLeft") goTo(view.current - 1);
  else if (!e.metaKey && !e.ctrlKey && !e.altKey) {
    const key = e.key.toLowerCase();
    if (key === "e") explainSelection("text");
    else if (key === "v") explainSelection("visual");
  }
});

viewer.addEventListener("dragover", (e) => {
  e.preventDefault();
  viewer.classList.add("dragging");
});
viewer.addEventListener("dragleave", () => viewer.classList.remove("dragging"));
viewer.addEventListener("drop", (e) => {
  e.preventDefault();
  viewer.classList.remove("dragging");
  const file = e.dataTransfer?.files[0];
  if (file && BOOK_FILE.test(file.name)) void openBook(api.pathForFile(file));
});

resizableSidebar(tocEl, $("toc-resizer"), {
  side: "left",
  min: 180,
  initial: 280,
  storageKey: "visual-reader:toc-width",
  other: () => (panelWindow.place === "docked" ? panelEl : null),
});
resizableSidebar($("panel"), $("panel-resizer"), {
  side: "right",
  min: 300,
  initial: 460,
  storageKey: "visual-reader:panel-width",
  other: () => tocEl,
});

// Re-fit pages once the viewer's width settles, not on every frame of a sidebar drag.
let lastWidth = 0;
let relayoutTimer: ReturnType<typeof setTimeout> | undefined;
new ResizeObserver(() => {
  if (Math.abs(viewer.clientWidth - lastWidth) < 4) return;
  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(() => {
    lastWidth = viewer.clientWidth;
    if (book) view.relayout();
  }, 120);
}).observe(viewer);

/** Fills the model menu from the available providers, grouped when there's more than one. */
async function loadModels() {
  const [providers, settings] = await Promise.all([api.providers(), api.settings()]);
  const option = (provider: string, m: { id: string; label: string }) => new Option(m.label, `${provider}/${m.id}`);
  modelSelect.replaceChildren(
    ...providers.flatMap((p) => {
      const options = p.models.map((m) => option(p.id, m));
      if (providers.length === 1) return options;
      const group = document.createElement("optgroup");
      group.label = p.label;
      group.append(...options);
      return [group];
    }),
  );
  modelSelect.value = `${settings.provider}/${settings.model}`;
  if (modelSelect.selectedIndex < 0) modelSelect.selectedIndex = 0;

  const list = $("model-list");
  list.replaceChildren(
    ...providers.flatMap((p) => {
      const rows: HTMLElement[] = providers.length > 1 ? [el("div", "model-group", p.label)] : [];
      for (const m of p.models) {
        const row = el("button", "model-option");
        row.setAttribute("role", "radio");
        row.dataset.value = `${p.id}/${m.id}`;
        row.append(el("span", "", m.label));
        row.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>');
        row.onclick = () => {
          modelSelect.value = row.dataset.value!;
          modelSelect.dispatchEvent(new Event("change"));
        };
        rows.push(row);
      }
      return rows;
    }),
  );
  showModel();
}

/** Marks the chosen model in the settings list and names it under the selection menu. */
function showModel() {
  for (const row of $("model-list").querySelectorAll<HTMLElement>(".model-option")) {
    row.setAttribute("aria-checked", String(row.dataset.value === modelSelect.value));
  }
  $("selection-model").textContent = modelSelect.selectedOptions[0]?.textContent ?? "";
}
void loadModels();
applyTheme(storedTheme());

function storedTheme(): string | null {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}
void showLibrary();
