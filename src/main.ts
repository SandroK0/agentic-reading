import * as pdfjsLib from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";
import type { ExplainMode, ReaderApi } from "../shared/types";
import { Pages } from "./pages";
import { PanelWindow } from "./panel-window";
import { allThemesCss, themeById, THEMES } from "../shared/themes";
import { ExplanationCards } from "./cards";
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
const nav = $("nav");
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
const countEl = $("count");
const emptyEl = $("empty");
const recentsEl = $("recents");
const tocEl = $("toc");
const tocBtn = $<HTMLButtonElement>("toc-btn");
const contents = new Contents($("toc-body"), (page, anchor) => goTo(page, { anchor }), {
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
  document.title = `${book.title} — Agentic Reading`;
  panelWindow.setTitle(`Explanations — ${book.title}`);
  pageTotal.textContent = `/ ${pageCount}`;
  pageInput.max = String(pageCount);
  const unit = epub ? "Section" : "Page";
  pageInput.setAttribute("aria-label", `${unit} number`);
  pageInput.title = epub ? "Section of the book (usually a chapter)" : "";
  prevBtn.setAttribute("aria-label", `Previous ${unit.toLowerCase()}`);
  nextBtn.setAttribute("aria-label", `Next ${unit.toLowerCase()}`);
  nav.hidden = false;
  emptyEl.hidden = true;
  pagesEl.hidden = false;
  tocBtn.hidden = false;
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

async function showRecents() {
  const recents = await api.recentBooks();
  recentsEl.replaceChildren(
    ...recents.map((p) => {
      const b = document.createElement("button");
      b.textContent = p.split("/").pop()!;
      b.title = p;
      b.onclick = () => openBook(p);
      return b;
    }),
  );
}

// ---------- Page tracking ----------

let savePageTimer: ReturnType<typeof setTimeout> | undefined;

/** Called whenever the page you're reading changes (for an EPUB, whenever you scroll), by scrolling or jumping. */
function showPage(n: number) {
  if (!book) return;
  if (document.activeElement !== pageInput) pageInput.value = String(n);
  contents.setPage(n);
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

const explanations = new ExplanationCards(cardsEl, cardsEmpty, countEl, {
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
});

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

prevBtn.onclick = () => goTo(view.current - 1);
nextBtn.onclick = () => goTo(view.current + 1);
pageInput.onchange = () => goTo(Number(pageInput.value));
$("zoom-in").onclick = () => setZoom(view.zoomLevel + 0.25);
$("zoom-out").onclick = () => setZoom(view.zoomLevel - 0.25);

// Options are "<provider>/<model>"; provider ids never contain a slash.
modelSelect.onchange = () => {
  const [provider, ...rest] = modelSelect.value.split("/");
  void api.saveSettings({ provider, model: rest.join("/") });
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
void showRecents();
