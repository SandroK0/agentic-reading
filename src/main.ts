import * as pdfjsLib from "pdfjs-dist";
import { TextLayer } from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";
import type { ExplainEvent, ExplainRequest, Explanation, ModelChoice, ReaderApi } from "../shared/types";
import { renderProse } from "./prose";
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
const pageEl = $("page");
const canvas = $<HTMLCanvasElement>("canvas");
const textLayerEl = $("text-layer");
const titleEl = $("title");
const nav = $("nav");
const pageInput = $<HTMLInputElement>("page-input");
const pageTotal = $("page-total");
const prevBtn = $<HTMLButtonElement>("prev");
const nextBtn = $<HTMLButtonElement>("next");
const zoomLabel = $("zoom-label");
const modelSelect = $<HTMLSelectElement>("model");
const explainFloat = $<HTMLButtonElement>("explain-float");
const explainPageBtn = $<HTMLButtonElement>("explain-page");
const cardsEl = $("cards");
const cardsEmpty = $("cards-empty");
const countEl = $("count");
const emptyEl = $("empty");
const recentsEl = $("recents");

interface Book {
  path: string;
  title: string;
  doc: pdfjsLib.PDFDocumentProxy;
}

let book: Book | null = null;
let currentPage = 1;
let zoom = 1;
let renderSeq = 0;
let renderTask: pdfjsLib.RenderTask | null = null;
let model: ModelChoice = "sonnet";
const pageText = new Map<number, string>();

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
  pageText.clear();

  titleEl.textContent = book.title;
  document.title = `${book.title} — Visual Reader`;
  pageTotal.textContent = `/ ${doc.numPages}`;
  pageInput.max = String(doc.numPages);
  nav.hidden = false;
  emptyEl.hidden = true;
  pageEl.hidden = false;
  explainPageBtn.disabled = false;

  const state = await api.bookState(path);
  renderCards(state.explanations);
  await renderPage(state.page);
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

// ---------- Rendering ----------

let savePageTimer: ReturnType<typeof setTimeout> | undefined;

async function renderPage(n: number) {
  if (!book) return;
  const { doc } = book;
  currentPage = Math.min(Math.max(1, Math.round(n) || 1), doc.numPages);
  const seq = ++renderSeq;
  pageInput.value = String(currentPage);
  prevBtn.disabled = currentPage <= 1;
  nextBtn.disabled = currentPage >= doc.numPages;
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  hideFloat();
  clearTimeout(savePageTimer);
  const path = book.path;
  savePageTimer = setTimeout(() => api.savePage(path, currentPage), 400);

  const page = await doc.getPage(currentPage);
  if (seq !== renderSeq) return;
  const base = page.getViewport({ scale: 1 });
  const fit = Math.max(200, viewer.clientWidth - 48) / base.width;
  const scale = Math.min(fit, 2.2) * zoom;
  const viewport = page.getViewport({ scale });
  const dpr = window.devicePixelRatio || 1;

  renderTask?.cancel();
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  pageEl.style.setProperty("--scale-factor", String(scale));
  pageEl.style.setProperty("--total-scale-factor", String(scale));
  renderTask = page.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
  try {
    await renderTask.promise;
  } catch (err) {
    if (err instanceof Error && err.name === "RenderingCancelledException") return;
    throw err;
  }
  if (seq !== renderSeq) return;

  const content = await page.getTextContent();
  if (seq !== renderSeq) return;
  textLayerEl.replaceChildren();
  await new TextLayer({ textContentSource: content, container: textLayerEl, viewport }).render();
  if (!pageText.has(currentPage)) {
    pageText.set(
      currentPage,
      content.items.map((i) => ("str" in i ? i.str + (i.hasEOL ? "\n" : "") : "")).join(""),
    );
  }
  viewer.scrollTop = 0;
}

// ---------- Selection ----------

function selectedPassage(): { text: string; rect: DOMRect } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !textLayerEl.contains(sel.anchorNode)) return null;
  const text = sel.toString().replace(/\s+/g, " ").trim();
  return text.length >= 2 ? { text, rect: sel.getRangeAt(0).getBoundingClientRect() } : null;
}

function showFloat(rect: DOMRect) {
  const box = viewer.getBoundingClientRect();
  explainFloat.hidden = false;
  const w = explainFloat.offsetWidth;
  const left = Math.min(Math.max(8, rect.left - box.left + rect.width / 2 - w / 2), box.width - w - 8);
  explainFloat.style.left = `${left + viewer.scrollLeft}px`;
  explainFloat.style.top = `${rect.bottom - box.top + viewer.scrollTop + 8}px`;
}

function hideFloat() {
  explainFloat.hidden = true;
}

function surrounding(passage: string): string {
  const text = (pageText.get(currentPage) ?? "").replace(/\s+/g, " ");
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
  pageLink.onclick = () => renderPage(data.page);
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
  card.followup.hidden = !card.data.sessionId;
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

function start(card: Card, req: Omit<ExplainRequest, "id" | "model">) {
  cardsEl.prepend(card.el);
  cardsEl.scrollTop = 0;
  updateCount();
  setStatus(card, "Thinking", { thinking: true, stop: true });
  void api.explain({ ...req, id: card.data.id, model });
}

function explainPassage(passage: string) {
  if (!book) return;
  const page = currentPage;
  const card = makeCard({ id: newId(), page, passage }, book.path);
  start(card, {
    bookPath: book.path,
    bookTitle: book.title,
    page,
    pageCount: book.doc.numPages,
    passage,
    context: passage ? surrounding(passage) : (pageText.get(page) ?? "").slice(0, PAGE_CONTEXT_CHARS),
  });
}

function askFollowup(parent: Card, question: string) {
  if (!book || !parent.data.sessionId) return;
  const card = makeCard({ id: newId(), page: parent.data.page, passage: parent.data.passage, question }, book.path);
  start(card, {
    bookPath: book.path,
    bookTitle: book.title,
    page: parent.data.page,
    pageCount: book.doc.numPages,
    passage: parent.data.passage,
    context: "",
    question,
    sessionId: parent.data.sessionId,
  });
}

api.onExplainEvent((event: ExplainEvent) => {
  const card = cards.get(event.id);
  if (!card) return;
  if (event.type === "text") {
    const prose = /<explanation>([\s\S]*?)(<\/explanation>|$)/.exec(event.text)?.[1] ?? "";
    card.prose.innerHTML = renderProse(prose);
    const drawing = event.text.includes("<widget>");
    setStatus(card, drawing ? "Drawing the visual" : "Writing", { thinking: true, stop: true });
  } else if (event.type === "error") {
    setStatus(card, event.message, { error: true });
  } else {
    Object.assign(card.data, { prose: event.prose, html: event.html, sessionId: event.sessionId, createdAt: Date.now() });
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

prevBtn.onclick = () => renderPage(currentPage - 1);
nextBtn.onclick = () => renderPage(currentPage + 1);
pageInput.onchange = () => renderPage(Number(pageInput.value));
$("zoom-in").onclick = () => {
  zoom = Math.min(3, zoom + 0.25);
  void renderPage(currentPage);
};
$("zoom-out").onclick = () => {
  zoom = Math.max(0.5, zoom - 0.25);
  void renderPage(currentPage);
};

modelSelect.onchange = () => {
  model = modelSelect.value as ModelChoice;
  void api.saveSettings({ model });
};

explainFloat.onmousedown = (e) => e.preventDefault();
explainFloat.onclick = () => {
  const sel = selectedPassage();
  if (!sel) return;
  hideFloat();
  window.getSelection()?.removeAllRanges();
  explainPassage(sel.text);
};
explainPageBtn.onclick = () => explainPassage("");

document.addEventListener("mouseup", (e) => {
  if (explainFloat.contains(e.target as Node)) return;
  setTimeout(() => {
    const sel = selectedPassage();
    if (sel) showFloat(sel.rect);
    else hideFloat();
  });
});

document.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
  if (!book) return;
  if (e.key === "ArrowRight" || e.key === "PageDown") void renderPage(currentPage + 1);
  else if (e.key === "ArrowLeft" || e.key === "PageUp") void renderPage(currentPage - 1);
  else if (e.key.toLowerCase() === "e" && !e.metaKey && !e.ctrlKey) {
    const sel = selectedPassage();
    if (sel) {
      hideFloat();
      window.getSelection()?.removeAllRanges();
      explainPassage(sel.text);
    }
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

let lastWidth = 0;
new ResizeObserver(() => {
  if (Math.abs(viewer.clientWidth - lastWidth) < 4) return;
  lastWidth = viewer.clientWidth;
  if (book) void renderPage(currentPage);
}).observe(viewer);

void api.settings().then((s) => {
  model = s.model;
  modelSelect.value = s.model;
});
void showRecents();
