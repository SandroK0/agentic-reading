import type { Annotations, Bookmark, Highlight as SavedHighlight } from "../shared/types";
import { textIndex, type TextIndex } from "./text-index";

/** Which kinds of mark the Notes tab lists. */
export type NotesFilter = "all" | "highlights" | "notes" | "bookmarks";

const FILTERS: { id: NotesFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "highlights", label: "Highlights" },
  { id: "notes", label: "Notes" },
  { id: "bookmarks", label: "Bookmarks" },
];

/** The CSS highlights the marks are painted with (see ::highlight(user-…) in style.css). */
const PAINT = { plain: "user-highlight", noted: "user-note" } as const;

const ICONS = {
  highlight: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 15l-4 4h6l1.5-1.5" /><path d="M14.5 4.5l5 5-7.5 7.5-5-5z" /></svg>',
  bookmark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h11v17l-5.5-4-5.5 4z" /></svg>',
};

export interface BookNotesOptions {
  list: HTMLElement;
  filters: HTMLElement;
  /** Shows how many marks the book has, on the Notes tab. */
  count: HTMLElement;
  exportButton: HTMLButtonElement;
  /** A page's (or EPUB section's) text, if it's drawn: PDF pages are only drawn near the view. */
  rootFor: (page: number) => Element | null;
  chapterTitle: (page: number) => string;
  /** "p. 14" for a highlight's page, or for a bookmark's position. */
  placeLabel: (page: number, fraction: number) => string;
  goToHighlight: (highlight: SavedHighlight, range: Range | null) => void;
  goToBookmark: (position: number) => void;
  explain: (highlight: SavedHighlight) => void;
  /** Shows the Notes tab (for a note you've just started). */
  showNotes: () => void;
  save: (annotations: Annotations) => void;
  exportMarkdown: (markdown: string) => void;
  /** After bookmarks change, for the toolbar button, the ribbon and the progress bar. */
  onBookmarksChanged: () => void;
  bookTitle: () => string;
}

/**
 * Highlights, notes and bookmarks for the open book: painting the highlights
 * on the page (in one colour; a highlight with a note is also underlined),
 * keeping them saved, and the Notes tab that lists them by chapter.
 *
 * A highlight is found again by its place in its page's text (see
 * Highlight in shared/types), so it works the same in a PDF's text layer,
 * which is redrawn as you scroll, and in an EPUB section in any layout.
 */
export class BookNotes {
  private highlights: SavedHighlight[] = [];
  private bookmarks: Bookmark[] = [];
  /** Where each highlight is drawn right now; missing while its page isn't. */
  private ranges = new Map<string, Range>();
  /** Text indexes by page root; a PDF page's root is new each time it's drawn, so these drop away with it. */
  private indexes = new WeakMap<Element, TextIndex>();
  private filter: NotesFilter = "all";
  /** The highlight whose note is being written, if any. */
  private editing: string | null = null;

  constructor(private opts: BookNotesOptions) {
    opts.filters.replaceChildren(
      ...FILTERS.map((f) => {
        const b = document.createElement("button");
        b.textContent = f.label;
        b.dataset.filter = f.id;
        b.setAttribute("aria-pressed", String(f.id === this.filter));
        b.onclick = () => {
          this.filter = f.id;
          for (const c of opts.filters.children) c.setAttribute("aria-pressed", String(c === b));
          this.render();
        };
        return b;
      }),
    );
    opts.exportButton.onclick = () => opts.exportMarkdown(this.markdown());
  }

  /** A new book and its saved marks (none for a book never marked up). */
  setBook(annotations: Annotations | undefined) {
    this.highlights = [...(annotations?.highlights ?? [])];
    this.bookmarks = [...(annotations?.bookmarks ?? [])];
    this.ranges.clear();
    this.editing = null;
    this.redraw();
    this.render();
    this.opts.onBookmarksChanged();
  }

  clear() {
    this.setBook(undefined);
  }

  // ---------- Highlights ----------

  /** Highlights a selection on `page`; returns the highlight it falls in instead, if there is one. Null if there's nothing to mark. */
  addHighlight(page: number, range: Range): SavedHighlight | null {
    const span = this.spanOf(page, range);
    if (!span) return null;
    const existing = this.highlightOver(page, span.start, span.end);
    if (existing) return existing;
    const highlight: SavedHighlight = { id: crypto.randomUUID(), page, ...span, createdAt: Date.now() };
    this.highlights.push(highlight);
    this.persist();
    this.redraw(page);
    this.render();
    return highlight;
  }

  /** The highlight a selection on `page` overlaps, if any (the selection menu offers to remove it). */
  highlightAt(page: number, range: Range): SavedHighlight | undefined {
    const span = this.spanOf(page, range);
    return span ? this.highlightOver(page, span.start, span.end) : undefined;
  }

  remove(id: string) {
    this.highlights = this.highlights.filter((h) => h.id !== id);
    this.bookmarks = this.bookmarks.filter((b) => b.id !== id);
    this.ranges.delete(id);
    if (this.editing === id) this.editing = null;
    this.persist();
    this.paint();
    this.render();
    this.opts.onBookmarksChanged();
  }

  /** Opens a highlight's note for writing, in the Notes tab. */
  editNote(id: string) {
    this.editing = id;
    if (this.filter === "bookmarks") this.filter = "all";
    this.opts.showNotes();
    this.render();
    const box = this.opts.list.querySelector<HTMLTextAreaElement>(`[data-id="${CSS.escape(id)}"] textarea`);
    box?.scrollIntoView({ block: "nearest" });
    box?.focus();
  }

  /** Puts highlights back on the page: all of them, or those on one page (a PDF page that was just drawn). */
  redraw(page?: number) {
    for (const h of this.highlights) {
      if (page !== undefined && h.page !== page) continue;
      const root = this.opts.rootFor(h.page);
      const range = root ? this.locate(h, root) : null;
      if (range) this.ranges.set(h.id, range);
      else this.ranges.delete(h.id);
    }
    this.paint();
  }

  private paint() {
    if (!CSS.highlights) return;
    const plain: Range[] = [];
    const noted: Range[] = [];
    for (const h of this.highlights) {
      const range = this.ranges.get(h.id);
      if (range) (h.note ? noted : plain).push(range);
    }
    // Under search matches and the selection menu's own mark, so those still show over a highlight.
    for (const [name, ranges] of [[PAINT.plain, plain], [PAINT.noted, noted]] as const) {
      const paint = new Highlight(...ranges);
      paint.priority = -1;
      CSS.highlights.set(name, paint);
    }
  }

  private index(root: Element): TextIndex {
    let index = this.indexes.get(root);
    if (!index) this.indexes.set(root, (index = textIndex(root)));
    return index;
  }

  /** A selection as a stretch of its page's text, without spaces at its ends; null if it's under two characters. */
  private spanOf(page: number, range: Range): { start: number; end: number; text: string } | null {
    const root = this.opts.rootFor(page);
    if (!root) return null;
    const index = this.index(root);
    let start = index.offsetOf(range.startContainer, range.startOffset);
    let end = index.offsetOf(range.endContainer, range.endOffset);
    while (start < end && index.flat[start] === " ") start++;
    while (end > start && index.flat[end - 1] === " ") end--;
    return end - start < 2 ? null : { start, end, text: index.flat.slice(start, end) };
  }

  private highlightOver(page: number, start: number, end: number) {
    return this.highlights.find((h) => h.page === page && h.start < end && h.end > start);
  }

  /** Where a highlight is in a drawn page: its saved place, or (if that text has moved) the nearest copy of its words. */
  private locate(h: SavedHighlight, root: Element): Range | null {
    const index = this.index(root);
    if (index.flat.slice(h.start, h.end) === h.text) return index.range(h.start, h.end);
    let best = -1;
    for (let at = index.flat.indexOf(h.text); at >= 0; at = index.flat.indexOf(h.text, at + 1)) {
      if (best < 0 || Math.abs(at - h.start) < Math.abs(best - h.start)) best = at;
    }
    return best < 0 ? null : index.range(best, best + h.text.length);
  }

  // ---------- Bookmarks ----------

  /** The bookmark at the place you're reading, if there is one; `isHere` says whether a position is on screen. */
  bookmarkHere(isHere: (position: number) => boolean): Bookmark | undefined {
    return this.bookmarks.find((b) => isHere(b.position));
  }

  /** Bookmarks the place you're reading, or takes the bookmark there away. */
  toggleBookmark(position: number, isHere: (position: number) => boolean) {
    const here = this.bookmarkHere(isHere);
    if (here) {
      this.remove(here.id);
      return;
    }
    this.bookmarks.push({ id: crypto.randomUUID(), position, createdAt: Date.now() });
    this.persist();
    this.render();
    this.opts.onBookmarksChanged();
  }

  bookmarkPositions(): number[] {
    return this.bookmarks.map((b) => b.position);
  }

  private persist() {
    this.opts.save({ highlights: this.highlights, bookmarks: this.bookmarks });
  }

  // ---------- The Notes tab ----------

  /** Every mark in reading order, with what the list and the export need. */
  private items() {
    const fraction = (h: SavedHighlight) => {
      const root = this.opts.rootFor(h.page);
      const length = root ? this.index(root).flat.length : 0;
      return length ? h.start / length : 0;
    };
    return [
      ...this.highlights.map((h) => ({ kind: "highlight" as const, id: h.id, page: h.page, at: h.page + Math.min(0.999, fraction(h)), highlight: h })),
      ...this.bookmarks.map((b) => ({ kind: "bookmark" as const, id: b.id, page: Math.floor(b.position), at: b.position, bookmark: b })),
    ].sort((a, b) => a.at - b.at);
  }

  /** Redraws the list (also after page numbers change, since labels show them). */
  render() {
    const all = this.items();
    this.opts.count.textContent = all.length ? String(all.length) : "";
    const shown = all.filter((item) =>
      this.filter === "all" ? true
      : this.filter === "bookmarks" ? item.kind === "bookmark"
      : this.filter === "notes" ? item.kind === "highlight" && (!!item.highlight.note || item.id === this.editing)
      : item.kind === "highlight",
    );
    this.opts.exportButton.disabled = !all.length;
    if (!shown.length) {
      const empty = document.createElement("p");
      empty.className = "muted hint";
      empty.textContent = all.length
        ? "Nothing of this kind yet."
        : "Select a passage and choose Highlight or Note, or bookmark a page with ⌘D. Your marks collect here.";
      this.opts.list.replaceChildren(empty);
      return;
    }
    const rows: HTMLElement[] = [];
    let chapter: string | null = null;
    for (const item of shown) {
      const title = this.opts.chapterTitle(item.page);
      if (title !== chapter) {
        chapter = title;
        const h = document.createElement("div");
        h.className = "note-chapter";
        h.textContent = title;
        rows.push(h);
      }
      rows.push(item.kind === "highlight" ? this.highlightRow(item.highlight, item.at) : this.bookmarkRow(item.bookmark));
    }
    this.opts.list.replaceChildren(...rows);
  }

  private highlightRow(h: SavedHighlight, at: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "note-item";
    row.dataset.id = h.id;
    const head = document.createElement("div");
    head.className = "note-head";
    head.innerHTML = ICONS.highlight;
    const quote = document.createElement("button");
    quote.className = "note-quote";
    quote.textContent = `“${h.text}”`;
    quote.title = "Go to this passage";
    quote.onclick = () => this.opts.goToHighlight(h, this.ranges.get(h.id) ?? null);
    const where = document.createElement("span");
    where.className = "note-where";
    where.textContent = this.opts.placeLabel(h.page, at % 1);
    head.append(quote, where);
    row.append(head);

    if (this.editing === h.id) {
      const box = document.createElement("textarea");
      box.className = "note-editor";
      box.placeholder = "Write a note";
      box.setAttribute("aria-label", "Note");
      box.value = h.note ?? "";
      box.rows = 3;
      // Saved as you type (a moment after you stop), not only when you leave the box: the window can lose focus first.
      let saveTimer: ReturnType<typeof setTimeout> | undefined;
      const keep = () => {
        clearTimeout(saveTimer);
        const note = box.value.trim() || undefined;
        if (note === h.note) return;
        h.note = note;
        this.persist();
        this.paint();
      };
      box.oninput = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(keep, 400);
      };
      const finish = () => {
        keep();
        this.editing = null;
        this.render();
      };
      box.onblur = finish;
      box.onkeydown = (e) => {
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          box.blur();
        }
      };
      row.append(box);
    } else if (h.note) {
      const note = document.createElement("p");
      note.className = "note-text";
      note.textContent = h.note;
      row.append(note);
    }

    const actions = document.createElement("div");
    actions.className = "note-actions";
    const button = (label: string, onClick: () => void, cls = "") => {
      const b = document.createElement("button");
      b.textContent = label;
      if (cls) b.className = cls;
      // Keep the note box's focus until the click lands, so its blur doesn't redraw the list out from under it.
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = onClick;
      return b;
    };
    if (this.editing !== h.id) actions.append(button(h.note ? "Edit note" : "Add note", () => this.editNote(h.id)));
    actions.append(button("Explain", () => this.opts.explain(h)), button("Delete", () => this.remove(h.id), "danger"));
    row.append(actions);
    return row;
  }

  private bookmarkRow(b: Bookmark): HTMLElement {
    const row = document.createElement("div");
    row.className = "note-item bookmark";
    row.dataset.id = b.id;
    const head = document.createElement("div");
    head.className = "note-head";
    head.innerHTML = ICONS.bookmark;
    const go = document.createElement("button");
    go.className = "note-quote";
    go.textContent = "Bookmark";
    go.title = "Go to this bookmark";
    go.onclick = () => this.opts.goToBookmark(b.position);
    const where = document.createElement("span");
    where.className = "note-where";
    where.textContent = this.opts.placeLabel(Math.floor(b.position), b.position % 1);
    const remove = document.createElement("button");
    remove.className = "icon-btn note-remove";
    remove.title = "Remove bookmark";
    remove.setAttribute("aria-label", "Remove bookmark");
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" /></svg>';
    remove.onclick = () => this.remove(b.id);
    head.append(go, where, remove);
    row.append(head);
    return row;
  }

  /** Everything, by chapter, as Markdown: bookmarks as lines, highlights as quotes with their notes under them. */
  private markdown(): string {
    const lines = [`# ${this.opts.bookTitle()}`, "", "Highlights, notes and bookmarks.", ""];
    let chapter: string | null = null;
    for (const item of this.items()) {
      const title = this.opts.chapterTitle(item.page);
      if (title !== chapter) {
        chapter = title;
        lines.push(`## ${title}`, "");
      }
      const place = this.opts.placeLabel(item.page, item.at % 1);
      if (item.kind === "bookmark") {
        lines.push(`- Bookmark, ${place}`, "");
      } else {
        lines.push(`> ${item.highlight.text}`, ">", `> — ${place}`, "");
        if (item.highlight.note) lines.push(item.highlight.note, "");
      }
    }
    return lines.join("\n");
  }
}
