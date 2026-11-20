import { textIndex, type EpubView } from "./epub";
import { closeWhenDismissed } from "./popover";
import { partsOf } from "./dom";

/** Results stop here; a word that common isn't worth paging through one by one. */
const MAX_HITS = 500;
const SNIPPET_CHARS = 40;

interface Hit {
  section: number;
  range: Range;
  before: string;
  match: string;
  after: string;
}

/**
 * Search in an EPUB (⌘F): every match in the book, listed by chapter with a
 * little of the text around it, and marked on the page. Enter and Shift+Enter
 * step through them; each one jumps there. Closing the panel clears the marks.
 */
export class BookSearch {
  private hits: Hit[] = [];
  private currentHit = -1;
  /** Each section's text, indexed on the first search in a book. */
  private indexes: ReturnType<typeof textIndex>[] | null = null;
  /** The first result you go to in a search remembers where you were reading; the ones after it don't. */
  private jumped = false;
  /** The query the results are for, so Return can tell whether to search again first. */
  private lastQuery = "";
  private timer: ReturnType<typeof setTimeout> | undefined;

  private readonly input: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly results: HTMLElement;

  constructor(
    private anchor: HTMLElement,
    private button: HTMLButtonElement,
    private panel: HTMLElement,
    private epub: EpubView,
    private opts: {
      chapterTitle: (section: number) => string;
      /** Goes to a result; main remembers where you were first when `first`. */
      onJump: (section: number, range: Range, first: boolean) => void;
    },
  ) {
    const part = partsOf(panel);
    this.input = part<HTMLInputElement>("search-input");
    this.count = part("search-count");
    this.summary = part("search-summary");
    this.results = part("search-results");

    button.onclick = () => this.setOpen(panel.hidden);
    closeWhenDismissed(panel, button, () => !panel.hidden, () => this.setOpen(false));
    this.input.oninput = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.run(this.input.value), 150);
    };
    this.input.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      clearTimeout(this.timer);
      if (this.input.value !== this.lastQuery) this.run(this.input.value);
      this.step(e.shiftKey ? -1 : 1);
    };
    part("search-prev").onclick = () => this.step(-1);
    part("search-next").onclick = () => this.step(1);
  }

  /** Shows the search button for an EPUB; a new book (or none) starts with no search. */
  setBook(available: boolean) {
    this.anchor.hidden = !available;
    this.indexes = null;
    this.input.value = "";
    this.run("");
    this.setOpen(false);
  }

  /** Opens the panel with the box focused and its text selected, as ⌘F does. */
  open() {
    if (this.anchor.hidden) return;
    this.setOpen(true);
  }

  private setOpen(open: boolean) {
    this.panel.hidden = !open;
    this.button.setAttribute("aria-expanded", String(open));
    this.button.setAttribute("aria-pressed", String(open));
    if (open) {
      this.jumped = false;
      this.input.focus();
      this.input.select();
      this.mark();
    } else {
      CSS.highlights?.delete("search-hit");
      CSS.highlights?.delete("search-current");
    }
  }

  private run(query: string) {
    this.lastQuery = query;
    const needle = query.replace(/\s+/g, " ").trim().toLowerCase();
    this.hits = [];
    this.currentHit = -1;
    if (needle.length >= 2) {
      this.indexes ??= this.epub.sections.map((s) => textIndex(s));
      outer: for (const [i, index] of this.indexes.entries()) {
        const haystack = index.flat.toLowerCase();
        for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
          if (this.hits.length >= MAX_HITS) break outer;
          const end = at + needle.length;
          this.hits.push({
            section: i + 1,
            range: index.range(at, end),
            before: (at > SNIPPET_CHARS ? "…" : "") + index.flat.slice(Math.max(0, at - SNIPPET_CHARS), at).trimStart(),
            match: index.flat.slice(at, end),
            after: index.flat.slice(end, end + SNIPPET_CHARS).trimEnd() + (end + SNIPPET_CHARS < index.flat.length ? "…" : ""),
          });
        }
      }
    }
    this.renderResults(needle.length >= 2);
    this.mark();
  }

  /** Goes to the next (1) or previous (-1) result, wrapping round the book. */
  private step(by: 1 | -1) {
    if (!this.hits.length) return;
    // The first step goes to the first result after where you're reading, not the book's first.
    if (this.currentHit < 0) {
      const after = this.hits.findIndex((h) => h.section >= this.epub.current);
      this.select(by === 1 ? Math.max(0, after) : (after <= 0 ? this.hits.length : after) - 1);
    } else {
      this.select((this.currentHit + by + this.hits.length) % this.hits.length);
    }
  }

  private select(i: number) {
    this.currentHit = i;
    const hit = this.hits[i];
    this.opts.onJump(hit.section, hit.range, !this.jumped);
    this.jumped = true;
    this.count.textContent = `${i + 1} of ${this.hits.length}`;
    for (const row of this.results.querySelectorAll(".search-result")) {
      row.setAttribute("aria-current", String(Number((row as HTMLElement).dataset.hit) === i));
    }
    this.results.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
    this.mark();
  }

  /** Marks every match in the book, and the one you're on more strongly. */
  private mark() {
    if (!CSS.highlights || this.panel.hidden) return;
    CSS.highlights.set("search-hit", new Highlight(...this.hits.map((h) => h.range)));
    const current = this.hits[this.currentHit];
    if (current) CSS.highlights.set("search-current", new Highlight(current.range));
    else CSS.highlights.delete("search-current");
  }

  private renderResults(searched: boolean) {
    const n = this.hits.length;
    const howMany = `${n}${n >= MAX_HITS ? "+" : ""}`;
    this.count.textContent = n ? howMany : "";
    const chapters = new Set(this.hits.map((h) => this.opts.chapterTitle(h.section)));
    this.summary.textContent = !searched ? "" : n ? `${howMany} result${n === 1 ? "" : "s"} in ${chapters.size} chapter${chapters.size === 1 ? "" : "s"}` : "No results";
    const rows: HTMLElement[] = [];
    let heading: string | null = null;
    this.hits.forEach((hit, i) => {
      const title = this.opts.chapterTitle(hit.section);
      if (title !== heading) {
        heading = title;
        const h = document.createElement("div");
        h.className = "search-chapter";
        h.textContent = title;
        rows.push(h);
      }
      const row = document.createElement("button");
      row.className = "search-result";
      row.dataset.hit = String(i);
      const text = document.createElement("span");
      const match = document.createElement("b");
      match.textContent = hit.match;
      text.append(hit.before, match, hit.after);
      row.append(text);
      row.onclick = () => this.select(i);
      rows.push(row);
    });
    this.results.replaceChildren(...rows);
    this.results.hidden = !rows.length;
  }
}
