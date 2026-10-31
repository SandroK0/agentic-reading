import * as pdfjsLib from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";
import type { ExplainEvent, ExplainMode, ExplainRequest, Explanation, ReaderApi } from "../shared/types";
import { Pages } from "./pages";
import { renderProse } from "./prose";
import { resizableSidebar } from "./resize";
import { enableTextSelection } from "./selection";
import { Contents } from "./toc";
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
const selectionMenu = $("selection-menu");
const explainPageBtn = $<HTMLButtonElement>("explain-page");
const cardsEl = $("cards");
const cardsEmpty = $("cards-empty");
const countEl = $("count");
const emptyEl = $("empty");
const recentsEl = $("recents");
const tocEl = $("toc");
const tocBtn = $<HTMLButtonElement>("toc-btn");
const contents = new Contents($("toc-body"), (page) => pages.goTo(page));
const pages = new Pages(viewer, pagesEl, showPage);
enableTextSelection(viewer);

interface Book {
  path: string;
  title: string;
  doc: pdfjsLib.PDFDocumentProxy;
}

let book: Book | null = null;

// ---------- Opening books ----------

async function openBook(path: string) {
  let bytes: Uint8Array;
  try {
    bytes = await api.readBook(path);
  } catch (err) {
    alert(`Couldn't open this file.\n\n${(err as Error).message}`);
    return;
  }
  const doc = await pdfjsLib.getDocument({
    data: bytes,
    standardFontDataUrl: "./pdfjs/standard_fonts/",
    cMapUrl: "./pdfjs/cmaps/",
    cMapPacked: true,
  }).promise;

  await book?.doc.destroy();
  const meta = await doc.getMetadata().catch(() => null);
  const metaTitle = (meta?.info as { Title?: string } | undefined)?.Title?.trim();
  const fileName = path.split("/").pop()!.replace(/\.pdf$/i, "");
  book = { path, title: metaTitle && metaTitle.length > 3 ? metaTitle : fileName, doc };

  titleEl.textContent = book.title;
  document.title = `${book.title} — Visual Reader`;
  pageTotal.textContent = `/ ${doc.numPages}`;
  pageInput.max = String(doc.numPages);
  nav.hidden = false;
  emptyEl.hidden = true;
  pagesEl.hidden = false;
  explainPageBtn.disabled = false;
  tocBtn.hidden = false;
  setTocVisible(tocPreference());
  void contents.load(doc);

  const state = await api.bookState(path);
  renderCards(state.explanations);
  await pages.load(doc, state.page);
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

/** Called whenever the page you're reading changes, by scrolling or jumping. */
function showPage(n: number) {
  if (!book) return;
  pageInput.value = String(n);
  contents.setPage(n);
  prevBtn.disabled = n <= 1;
  nextBtn.disabled = n >= book.doc.numPages;
  clearTimeout(savePageTimer);
  const path = book.path;
  savePageTimer = setTimeout(() => api.savePage(path, n), 400);
}

function setZoom(zoom: number) {
  pages.setZoom(Math.min(3, Math.max(0.5, zoom)));
  zoomLabel.textContent = `${Math.round(pages.zoomLevel * 100)}%`;
}

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
  const pageEl = anchor?.closest<HTMLElement>(".textLayer")?.closest<HTMLElement>(".page");
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
  const left = Math.min(Math.max(8, rect.left - box.left - w / 2), box.width - w - 8);
  let top = upward ? rect.top - box.top - h - 8 : rect.bottom - box.top + 8;
  // Keep it inside the visible part of the viewer.
  top = Math.min(Math.max(8, top), viewer.clientHeight - h - 8);
  selectionMenu.style.left = `${left + viewer.scrollLeft}px`;
  selectionMenu.style.top = `${top + viewer.scrollTop}px`;
}

function hideMenu() {
  selectionMenu.hidden = true;
}

function explainSelection(mode: ExplainMode) {
  const sel = selectedPassage();
  if (!sel) return;
  hideMenu();
  window.getSelection()?.removeAllRanges();
  void explainPassage(sel.page, sel.text, mode);
}

async function surrounding(page: number, passage: string): Promise<string> {
  const text = (await pages.text(page)).replace(/\s+/g, " ");
  const at = text.indexOf(passage.slice(0, 60));
  if (at < 0) return text.slice(0, PASSAGE_CONTEXT_CHARS * 2);
  return text.slice(Math.max(0, at - PASSAGE_CONTEXT_CHARS), at + passage.length + PASSAGE_CONTEXT_CHARS);
}

// ---------- Explanations ----------

interface Card {
  el: HTMLElement;
  prose: HTMLElement;
  status: HTMLElement;
  frame: HTMLIFrameElement | null;
  followup: HTMLFormElement;
  data: Partial<Explanation> & { id: string; page: number; passage: string };
  bookPath: string;
}

const cards = new Map<string, Card>();

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function updateCount() {
  const n = cardsEl.querySelectorAll(".card").length;
  countEl.textContent = n ? `(${n})` : "";
  cardsEmpty.hidden = n > 0;
}

function makeCard(data: Card["data"], bookPath: string): Card {
  const el = document.createElement("article");
  el.className = "card";

  const head = document.createElement("div");
  head.className = "card-head";
  const pageLink = document.createElement("button");
  pageLink.className = "page-link";
  pageLink.textContent = `p. ${data.page}`;
  pageLink.title = "Go to this page";
  pageLink.onclick = () => pages.goTo(data.page);
  const quote = document.createElement("span");
  quote.className = "quote";
  const label = data.question ?? data.passage;
  quote.textContent = label ? `“${label.length > 160 ? label.slice(0, 160) + "…" : label}”` : "Whole page";
  const del = document.createElement("button");
  del.className = "card-delete";
  del.textContent = "×";
  del.title = "Remove";
  del.onclick = () => {
    api.cancel(data.id);
    el.remove();
    cards.delete(data.id);
    if (data.html !== undefined) api.deleteExplanation(bookPath, data.id);
    updateCount();
  };
  head.append(pageLink, quote, del);

  const prose = document.createElement("div");
  prose.className = "prose";
  const status = document.createElement("div");
  status.className = "status";

  const followup = document.createElement("form");
  followup.className = "followup";
  followup.hidden = true;
  const input = document.createElement("input");
  input.placeholder = "Ask a follow-up…";
  const ask = document.createElement("button");
  ask.textContent = "Ask";
  followup.append(input, ask);
  followup.onsubmit = (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    input.value = "";
    askFollowup(card, q);
  };

  el.append(head, prose, status, followup);
  const card: Card = { el, prose, status, frame: null, followup, data, bookPath };
  cards.set(data.id, card);
  return card;
}

function showWidget(card: Card) {
  if (!card.data.html) return;
  card.frame?.remove();
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.title = "Visual explainer";
  frame.src = api.widgetUrl(card.data.id);
  card.status.before(frame);
  card.frame = frame;
}

function finishCard(card: Card) {
  card.prose.innerHTML = renderProse(card.data.prose ?? "");
  card.status.replaceChildren();
  card.status.className = "status";
  card.status.hidden = true;
  showWidget(card);
  card.followup.hidden = false;
}

function renderCards(explanations: Explanation[]) {
  for (const c of cards.values()) c.el.remove();
  cards.clear();
  for (const e of explanations) {
    const card = makeCard(e, book!.path);
    cardsEl.append(card.el);
    finishCard(card);
  }
  updateCount();
}

function setStatus(card: Card, text: string, opts: { error?: boolean; thinking?: boolean; stop?: boolean } = {}) {
  card.status.hidden = false;
  card.status.className = `status${opts.error ? " error" : ""}`;
  const label = document.createElement("span");
  label.textContent = text;
  if (opts.thinking) label.className = "thinking";
  const parts: HTMLElement[] = [label];
  if (opts.stop) {
    const stop = document.createElement("button");
    stop.textContent = "Stop";
    stop.onclick = () => api.cancel(card.data.id);
    parts.push(stop);
  }
  card.status.replaceChildren(...parts);
}

function start(card: Card, req: Omit<ExplainRequest, "id">) {
  cardsEl.prepend(card.el);
  cardsEl.scrollTop = 0;
  updateCount();
  setStatus(card, "Thinking", { thinking: true, stop: true });
  void api.explain({ ...req, id: card.data.id });
}

async function explainPassage(page: number, passage: string, mode: ExplainMode) {
  if (!book) return;
  const current = book;
  const context = passage ? await surrounding(page, passage) : (await pages.text(page)).slice(0, PAGE_CONTEXT_CHARS);
  if (book !== current) return;
  const card = makeCard({ id: newId(), page, passage, mode }, current.path);
  start(card, {
    mode,
    bookPath: current.path,
    bookTitle: current.title,
    page,
    pageCount: current.doc.numPages,
    passage,
    context,
  });
}

function askFollowup(parent: Card, question: string) {
  if (!book) return;
  const mode = parent.data.mode ?? "visual";
  const card = makeCard({ id: newId(), page: parent.data.page, passage: parent.data.passage, question, mode }, book.path);
  start(card, {
    mode,
    bookPath: book.path,
    bookTitle: book.title,
    page: parent.data.page,
    pageCount: book.doc.numPages,
    passage: parent.data.passage,
    context: "",
    question,
    parentId: parent.data.id,
  });
}

api.onExplainEvent((event: ExplainEvent) => {
  const card = cards.get(event.id);
  if (!card) return;
  if (event.type === "text") {
    const prose = /<explanation>([\s\S]*?)(<\/explanation>|$)/.exec(event.text)?.[1] ?? "";
    card.prose.innerHTML = renderProse(prose);
    const drawing = event.text.includes("<widget>");
    setStatus(card, drawing ? "Drawing" : "Writing", { thinking: true, stop: true });
  } else if (event.type === "error") {
    setStatus(card, event.message, { error: true });
  } else {
    const { prose, html, provider, model, resume, conversation } = event;
    Object.assign(card.data, { prose, html, provider, model, resume, conversation, createdAt: Date.now() });
    finishCard(card);
    void api.saveExplanation(card.bookPath, card.data as Explanation);
  }
});

// Messages from explainer frames: height changes and ask() follow-ups.
window.addEventListener("message", (e) => {
  for (const card of cards.values()) {
    if (!card.frame || e.source !== card.frame.contentWindow) continue;
    const msg = e.data as { type?: string; height?: number; question?: string };
    if (msg.type === "vr-height" && typeof msg.height === "number") {
      card.frame.style.height = `${Math.min(Math.max(msg.height, 40), 2400)}px`;
    } else if (msg.type === "vr-ask" && msg.question) {
      askFollowup(card, msg.question.slice(0, 500));
    }
    return;
  }
});

// ---------- Wiring ----------

$("open-btn").onclick = async () => {
  const picked = await api.openDialog();
  if (picked) await openBook(picked);
};
api.onOpenBook((path) => void openBook(path));

prevBtn.onclick = () => pages.goTo(pages.current - 1);
nextBtn.onclick = () => pages.goTo(pages.current + 1);
pageInput.onchange = () => pages.goTo(Number(pageInput.value));
$("zoom-in").onclick = () => setZoom(pages.zoomLevel + 0.25);
$("zoom-out").onclick = () => setZoom(pages.zoomLevel - 0.25);

// Options are "<provider>/<model>"; provider ids never contain a slash.
modelSelect.onchange = () => {
  const [provider, ...rest] = modelSelect.value.split("/");
  void api.saveSettings({ provider, model: rest.join("/") });
};

// Keep the selection alive when a menu button is pressed.
selectionMenu.onmousedown = (e) => e.preventDefault();
$("explain-text").onclick = () => explainSelection("text");
$("explain-visual").onclick = () => explainSelection("visual");
explainPageBtn.onclick = () => void explainPassage(pages.current, "", "visual");

document.addEventListener("mouseup", (e) => {
  if (selectionMenu.contains(e.target as Node)) return;
  setTimeout(() => {
    const sel = selectedPassage();
    if (sel) showMenu(sel.rect, sel.upward);
    else hideMenu();
  });
});

document.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
  if (!book) return;
  if (e.key === "ArrowRight") pages.goTo(pages.current + 1);
  else if (e.key === "ArrowLeft") pages.goTo(pages.current - 1);
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
  if (file && file.name.toLowerCase().endsWith(".pdf")) void openBook(api.pathForFile(file));
});

resizableSidebar(tocEl, $("toc-resizer"), {
  side: "left",
  min: 180,
  initial: 280,
  storageKey: "visual-reader:toc-width",
  other: () => $("panel"),
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
    if (book) pages.relayout();
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
void showRecents();
