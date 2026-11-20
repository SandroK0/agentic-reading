import type { EpubPosition, EpubView } from "./epub";
import { partsOf } from "./dom";

/** A contents entry flattened to where it starts, for naming the chapter at a point in the book. */
export interface ChapterStart {
  section: number;
  title: string;
  /** Top-level entries get a mark on the progress bar; deeper ones only name the place. */
  topLevel: boolean;
}

/**
 * The footer under an EPUB: where you are and how much of the chapter is
 * left, a progress bar to scrub through the book by, and a "Back to" button
 * after a jump.
 *
 * Page numbers appear once the EPUB view has counted the whole book's pages
 * (paginated only); until then, and when scrolling, the bar is measured in
 * characters and places are named by their chapter.
 */
export class BookProgress {
  private chapters: ChapterStart[] = [];
  /** Where you were before the last jump. */
  private backTo: EpubPosition | null = null;
  private dragging = false;

  private readonly scrubber: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly thumb: HTMLElement;
  private readonly ticks: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly pagesLabel: HTMLElement;
  private readonly leftLabel: HTMLElement;
  private readonly back: HTMLButtonElement;
  private readonly backLabel: HTMLElement;

  constructor(
    private footer: HTMLElement,
    private epub: EpubView,
    /** Goes to a point in the book from the progress bar; `remember` asks main to note where you were first. */
    private onScrub: (section: number, within: number, remember: boolean) => void,
  ) {
    const part = partsOf(footer);
    this.scrubber = part("scrubber");
    this.fill = part("scrubber-fill");
    this.thumb = part("scrubber-thumb");
    this.ticks = part("scrubber-ticks");
    this.tip = part("scrubber-tip");
    this.pagesLabel = part("epub-pages");
    this.leftLabel = part("epub-left");
    this.back = part<HTMLButtonElement>("back-pill");
    this.backLabel = part("back-label");

    this.back.onclick = () => {
      if (this.backTo === null) return;
      const at = this.backTo;
      this.clearBack();
      this.epub.goTo(Math.floor(at), { fraction: at % 1 });
    };

    const fractionAt = (e: PointerEvent) => {
      const box = this.scrubber.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    };
    this.scrubber.addEventListener("pointermove", (e) => {
      const f = fractionAt(e);
      this.showTip(f);
      if (this.dragging) this.showAt(f);
    });
    this.scrubber.addEventListener("pointerleave", () => {
      if (!this.dragging) this.tip.hidden = true;
    });
    this.scrubber.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      this.scrubber.classList.add("dragging");
      this.scrubber.setPointerCapture(e.pointerId);
      this.showAt(fractionAt(e));
    });
    this.scrubber.addEventListener("pointerup", (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.scrubber.classList.remove("dragging");
      this.tip.hidden = true;
      const { section, within } = this.epub.locate(fractionAt(e));
      this.onScrub(section, within, true);
    });
    // On the bar, ← → step through chapter starts instead of turning a page. Like page turns, they don't leave a "Back to".
    this.scrubber.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      e.stopPropagation();
      const current = this.epub.current;
      const starts = [...new Set(this.chapters.map((c) => c.section))].sort((a, b) => a - b);
      const target = e.key === "ArrowRight" ? starts.find((s) => s > current) : [...starts].reverse().find((s) => s < current);
      if (target) this.onScrub(target, 0, false);
    });
  }

  /** A new book: its chapters, and no jump to go back from yet. */
  setBook(chapters: ChapterStart[] | null) {
    this.chapters = chapters ?? [];
    this.footer.hidden = !chapters;
    this.clearBack();
    this.drawTicks();
    this.update();
  }

  /** Call before a jump (contents, search, an explanation card, the progress bar), so you can come back. */
  noteJump() {
    this.backTo = this.epub.position();
  }

  /** After the view moves: the bar, the labels, and whether a "Back to" is worth showing. */
  update() {
    if (this.footer.hidden) return;
    const current = this.epub.current;
    const p = this.epub.progress(this.chapterEnd(current));
    if (!this.dragging) this.showAt(p.fraction);
    this.scrubber.setAttribute("aria-valuenow", String(Math.round(p.fraction * 100)));
    this.scrubber.setAttribute("aria-valuetext", `${Math.round(p.fraction * 100)}%, ${this.chapterTitle(current)}`);
    if (p.pages && p.total) {
      this.pagesLabel.textContent = p.pages[0] === p.pages[1] ? `Page ${p.pages[0]} of ${p.total}` : `Pages ${p.pages[0]}–${p.pages[1]} of ${p.total}`;
    } else {
      this.pagesLabel.textContent = `${Math.round(p.fraction * 100)}%`;
    }
    const unit = this.epub.paged ? "page" : "screen";
    const left = p.leftInChapter;
    this.leftLabel.textContent = left === 0 ? "Last page in chapter" : `${left} ${unit}${left === 1 ? "" : "s"} left in chapter`;
    // Back is offered until you return, or until you've wandered back to where you were anyway.
    const backHere = this.backTo !== null && Math.floor(this.backTo) === current && Math.abs(this.backTo - this.epub.position()) < 0.05;
    this.back.hidden = this.backTo === null || backHere;
    if (this.backTo !== null) this.backLabel.textContent = `Back to ${this.placeName(this.backTo)}`;
  }

  /** The page count changed (the whole book was counted, or a setting changed it): redraw the marks and labels. */
  pagesCounted() {
    this.drawTicks();
    this.update();
  }

  /** The chapter a section belongs to, by name (for search results and the bar's tooltip). */
  chapterTitle(section: number): string {
    return this.chapterAt(section)?.title ?? `Section ${section}`;
  }

  private clearBack() {
    this.backTo = null;
    this.back.hidden = true;
  }

  private showAt(fraction: number) {
    this.fill.style.width = `${fraction * 100}%`;
    this.thumb.style.left = `${fraction * 100}%`;
  }

  private showTip(fraction: number) {
    const { section, page } = this.epub.locate(fraction);
    const chapter = document.createElement("b");
    chapter.textContent = this.chapterTitle(section);
    const where = document.createElement("span");
    where.textContent = page ? `p. ${page}` : `${Math.round(fraction * 100)}%`;
    this.tip.replaceChildren(chapter, where);
    this.tip.style.left = `${fraction * 100}%`;
    this.tip.hidden = false;
  }

  private drawTicks() {
    const starts = this.epub.sectionStarts();
    this.ticks.replaceChildren(
      ...this.chapters
        .filter((c) => c.topLevel && (starts[c.section - 1] ?? 0) > 0)
        .map((c) => {
          const tick = document.createElement("i");
          tick.style.left = `${starts[c.section - 1] * 100}%`;
          return tick;
        }),
    );
  }

  /** The deepest contents entry starting at or before `section`. */
  private chapterAt(section: number): ChapterStart | undefined {
    let best: ChapterStart | undefined;
    for (const c of this.chapters) if (c.section <= section && (!best || c.section >= best.section)) best = c;
    return best;
  }

  /** The section the next chapter starts at, so "left in chapter" counts the whole chapter, not just this file of it. */
  private chapterEnd(section: number): number {
    const next = this.chapters.map((c) => c.section).filter((s) => s > section);
    return next.length ? Math.min(...next) : Number.MAX_SAFE_INTEGER;
  }

  /** A position as people say it: "p. 14" once pages are counted, otherwise its chapter. */
  private placeName(position: EpubPosition) {
    const page = this.epub.pageAt(position);
    return page ? `p. ${page}` : this.chapterTitle(Math.floor(position));
  }
}
