import type { ExplainEvent, ExplainRequest, Explanation, FollowUp, ReaderApi } from "../shared/types";
import { renderProse } from "./prose";

/**
 * The explanation cards in the Explanations panel. Each card is a thread: the
 * explanation of a passage, then any follow-up questions and their answers,
 * in order. A card can be minimised to its header. Cards stream while the
 * model writes, save when a turn finishes, and keep their drawings in theme.
 */

type Thread = Partial<Explanation> & { id: string; page: number; passage: string };

interface Turn {
  id: string;
  el: HTMLElement;
  prose: HTMLElement;
  frame: HTMLIFrameElement | null;
}

interface Card {
  data: Thread;
  bookPath: string;
  el: HTMLElement;
  meta: HTMLElement;
  body: HTMLElement;
  turns: Turn[];
  status: HTMLElement;
  form: HTMLFormElement;
  input: HTMLInputElement;
  /** The turn the model is writing, if any; one at a time keeps the conversation in order. */
  pending: { turn: Turn; question?: string } | null;
}

export interface CardsOptions {
  api: ReaderApi;
  /** Scrolls the book to where an explanation's passage is (an empty passage means the whole page). */
  goTo: (page: number, passage: string) => void;
  /** How a page is named on a card: "p. 12" in a PDF, "§ 3" for an EPUB's third section. */
  pageLabel: (page: number) => { short: string; title: string };
  /** The reader's theme and the light/dark palette it's showing, which drawings copy. */
  look: () => { theme: string; scheme: "light" | "dark" };
  /** Called when an explanation starts, so the panel can make sure it's visible. */
  onStart: () => void;
  /** Book details for follow-up requests. */
  book: () => { path: string; title: string; pageCount: number } | null;
}

export class ExplanationCards {
  private cards = new Map<string, Card>();
  /** Card by the id of the turn being written, for routing stream events. */
  private byTurn = new Map<string, Card>();

  constructor(
    private container: HTMLElement,
    private empty: HTMLElement,
    private count: HTMLElement,
    private opts: CardsOptions,
  ) {}

  /** Shows a book's saved explanations, newest first. */
  show(bookPath: string, explanations: Explanation[]) {
    for (const card of this.cards.values()) card.el.remove();
    this.cards.clear();
    this.byTurn.clear();
    for (const e of explanations) {
      const card = this.makeCard(e, bookPath);
      this.addTurn(card, e.id, e.question, e.prose, e.html);
      for (const f of e.followUps ?? []) this.addTurn(card, f.id, f.question, f.prose, f.html);
      card.form.hidden = false;
      this.container.append(card.el);
    }
    this.updateCount();
  }

  /** Starts a new card explaining a passage (or a whole page when `passage` is empty). */
  explain(bookPath: string, req: Omit<ExplainRequest, "id">) {
    const id = newId();
    const card = this.makeCard({ id, page: req.page, passage: req.passage, question: req.question, mode: req.mode }, bookPath);
    this.container.prepend(card.el);
    this.container.scrollTop = 0;
    this.updateCount();
    const turn = this.addTurn(card, id, req.question);
    this.run(card, turn, { ...req, id });
  }

  onEvent(event: ExplainEvent) {
    const card = this.byTurn.get(event.id);
    const pending = card?.pending;
    if (!card || !pending || pending.turn.id !== event.id) return;
    if (event.type === "text") {
      const prose = /<explanation>([\s\S]*?)(<\/explanation>|<widget>|$)/.exec(event.text)?.[1] ?? "";
      pending.turn.prose.innerHTML = renderProse(prose);
      this.setStatus(card, event.text.includes("<widget>") ? "Drawing" : "Writing", { thinking: true, stop: true });
      return;
    }
    this.byTurn.delete(event.id);
    card.pending = null;
    card.input.disabled = false;
    if (event.type === "error") {
      this.setStatus(card, event.message, { error: true });
      if (pending.turn.id !== card.data.id) {
        // Drop the unanswered follow-up and hand its question back for another try.
        pending.turn.el.remove();
        card.turns = card.turns.filter((t) => t !== pending.turn);
        card.input.value = pending.question ?? "";
      }
      card.form.hidden = card.data.createdAt === undefined;
      return;
    }

    const { prose, html, provider, model, resume, conversation } = event;
    pending.turn.prose.innerHTML = renderProse(prose);
    this.showDrawing(pending.turn, html);
    if (pending.turn.id === card.data.id) {
      Object.assign(card.data, { prose, html, createdAt: Date.now() });
    } else {
      const followUp: FollowUp = { id: pending.turn.id, question: pending.question ?? "", prose, html, createdAt: Date.now() };
      card.data.followUps = [...(card.data.followUps ?? []), followUp];
    }
    // The thread's conversation and resume handle always track its latest turn.
    Object.assign(card.data, { provider, model, resume, conversation });
    this.clearStatus(card);
    card.form.hidden = false;
    this.updateMeta(card);
    this.save(card);
  }

  /** Height reports and ask() follow-ups from drawings, in whichever window the panel is. */
  onFrameMessage(e: MessageEvent) {
    for (const card of this.cards.values()) {
      const turn = card.turns.find((t) => t.frame && e.source === t.frame.contentWindow);
      if (!turn) continue;
      const msg = e.data as { type?: string; height?: number; question?: string };
      if (msg.type === "vr-height" && typeof msg.height === "number") {
        turn.frame!.style.height = `${Math.min(Math.max(msg.height, 40), 2400)}px`;
      } else if (msg.type === "vr-ask" && msg.question) {
        this.followUp(card, msg.question.slice(0, 500));
      }
      return;
    }
  }

  /** Re-renders every drawing, e.g. in a new theme. */
  refreshDrawings() {
    for (const card of this.cards.values()) {
      for (const turn of card.turns) if (turn.frame) turn.frame.src = this.drawingUrl(turn.id);
    }
  }

  /** Minimises every card, or expands them all when they're all minimised already. */
  toggleAll() {
    const collapse = [...this.cards.values()].some((c) => !c.data.collapsed);
    for (const card of this.cards.values()) this.setCollapsed(card, collapse);
  }

  private followUp(card: Card, question: string) {
    const book = this.opts.book();
    if (!book || card.pending) return;
    const id = newId();
    this.setCollapsed(card, false);
    const turn = this.addTurn(card, id, question);
    turn.el.scrollIntoView({ block: "nearest" });
    this.run(
      card,
      turn,
      {
        id,
        mode: card.data.mode ?? "visual",
        bookPath: book.path,
        bookTitle: book.title,
        page: card.data.page,
        pageCount: book.pageCount,
        passage: card.data.passage,
        context: "",
        question,
        parentId: card.data.id,
      },
      question,
    );
  }

  private run(card: Card, turn: Turn, req: ExplainRequest, question?: string) {
    card.pending = { turn, question };
    this.byTurn.set(turn.id, card);
    card.input.disabled = true;
    card.form.hidden = true;
    this.setStatus(card, "Thinking", { thinking: true, stop: true });
    this.opts.onStart();
    void this.opts.api.explain(req);
  }

  private makeCard(data: Thread, bookPath: string): Card {
    const el = document.createElement("article");
    el.className = "card";

    const head = document.createElement("div");
    head.className = "card-head";
    const pageLink = document.createElement("button");
    pageLink.className = "page-link";
    const label = this.opts.pageLabel(data.page);
    pageLink.textContent = label.short;
    pageLink.title = label.title;
    pageLink.onclick = () => this.opts.goTo(data.page, data.passage);
    const summary = document.createElement("button");
    summary.className = "card-summary";
    summary.title = "Minimise or expand";
    const quote = document.createElement("span");
    quote.className = "quote";
    const passage = data.passage;
    quote.textContent = passage ? `“${passage.length > 160 ? passage.slice(0, 160) + "…" : passage}”` : "Whole page";
    const meta = document.createElement("span");
    meta.className = "card-meta";
    summary.append(quote, meta);
    const toggle = document.createElement("button");
    toggle.className = "card-toggle";
    toggle.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>';
    const del = document.createElement("button");
    del.className = "card-delete";
    del.textContent = "×";
    del.title = "Remove";
    head.append(pageLink, summary, toggle, del);

    const body = document.createElement("div");
    body.className = "card-body";
    const status = document.createElement("div");
    status.className = "status";
    status.hidden = true;
    const form = document.createElement("form");
    form.className = "followup";
    form.hidden = true;
    const input = document.createElement("input");
    input.placeholder = "Ask a follow-up…";
    const ask = document.createElement("button");
    ask.textContent = "Ask";
    form.append(input, ask);
    body.append(status, form);
    el.append(head, body);

    const card: Card = { data, bookPath, el, meta, body, turns: [], status, form, input, pending: null };
    summary.onclick = toggle.onclick = () => this.setCollapsed(card, !card.data.collapsed);
    del.onclick = () => this.remove(card);
    form.onsubmit = (e) => {
      e.preventDefault();
      const question = input.value.trim();
      if (!question) return;
      input.value = "";
      this.followUp(card, question);
    };
    this.cards.set(data.id, card);
    this.applyCollapsed(card);
    this.updateMeta(card);
    return card;
  }

  private addTurn(card: Card, id: string, question?: string, prose?: string, html?: string): Turn {
    const el = document.createElement("section");
    el.className = "turn";
    if (question) {
      const asked = document.createElement("p");
      asked.className = "card-question";
      asked.textContent = question;
      el.append(asked);
    }
    const proseEl = document.createElement("div");
    proseEl.className = "prose";
    if (prose !== undefined) proseEl.innerHTML = renderProse(prose);
    el.append(proseEl);
    card.status.before(el);
    const turn: Turn = { id, el, prose: proseEl, frame: null };
    card.turns.push(turn);
    if (html) this.showDrawing(turn, html);
    return turn;
  }

  private showDrawing(turn: Turn, html: string) {
    if (!html) return;
    turn.frame?.remove();
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.title = "Visual explainer";
    frame.src = this.drawingUrl(turn.id);
    turn.el.append(frame);
    turn.frame = frame;
  }

  private drawingUrl(id: string) {
    const { theme, scheme } = this.opts.look();
    return this.opts.api.widgetUrl(id, theme, scheme);
  }

  private setCollapsed(card: Card, collapsed: boolean) {
    if (!!card.data.collapsed === collapsed) return;
    card.data.collapsed = collapsed;
    this.applyCollapsed(card);
    this.save(card);
  }

  private applyCollapsed(card: Card) {
    const collapsed = !!card.data.collapsed;
    card.el.classList.toggle("collapsed", collapsed);
    const toggle = card.el.querySelector<HTMLButtonElement>(".card-toggle")!;
    toggle.title = collapsed ? "Expand" : "Minimise";
    toggle.setAttribute("aria-expanded", String(!collapsed));
  }

  /** A short note shown on a minimised card, like "Why so slow? · 2 follow-ups". */
  private updateMeta(card: Card) {
    const n = card.data.followUps?.length ?? 0;
    const parts = [card.data.question, n ? `${n} follow-up${n === 1 ? "" : "s"}` : ""].filter(Boolean);
    card.meta.textContent = parts.join(" · ");
  }

  private remove(card: Card) {
    if (card.pending) this.opts.api.cancel(card.pending.turn.id);
    card.el.remove();
    this.cards.delete(card.data.id);
    if (card.data.createdAt !== undefined) void this.opts.api.deleteExplanation(card.bookPath, card.data.id);
    this.updateCount();
  }

  /** Saves the card once its first turn has finished; before that there's nothing worth keeping. */
  private save(card: Card) {
    if (card.data.createdAt === undefined) return;
    void this.opts.api.saveExplanation(card.bookPath, card.data as Explanation);
  }

  private setStatus(card: Card, text: string, opts: { error?: boolean; thinking?: boolean; stop?: boolean } = {}) {
    card.status.hidden = false;
    card.status.className = `status${opts.error ? " error" : ""}`;
    const label = document.createElement("span");
    label.textContent = text;
    if (opts.thinking) label.className = "thinking";
    const parts: HTMLElement[] = [label];
    const pending = card.pending;
    if (opts.stop && pending) {
      const stop = document.createElement("button");
      stop.textContent = "Stop";
      stop.onclick = () => this.opts.api.cancel(pending.turn.id);
      parts.push(stop);
    }
    card.status.replaceChildren(...parts);
  }

  private clearStatus(card: Card) {
    card.status.replaceChildren();
    card.status.className = "status";
    card.status.hidden = true;
  }

  private updateCount() {
    const n = this.cards.size;
    this.count.textContent = n ? `(${n})` : "";
    this.empty.hidden = n > 0;
  }
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

