import type { PDFDocumentProxy } from "pdfjs-dist";
import type { ContentsSource } from "../shared/types";

/**
 * Gathers what the model needs to write a table of contents: the full text
 * of the first pages, where a printed contents page usually is, and the
 * heading-like lines on every page. Headings are told apart from body text by
 * font size, or by looking like "Chapter 3" or "2.1 Something".
 */

const FRONT_PAGES = 25;
const FRONT_PAGE_CHARS = 3000;
const MAX_LINE_CHARS = 120;
const HEADINGS_PER_PAGE = 4;
const MAX_HEADINGS = 2500;
/** A line this much larger than the body text counts as a heading. */
const HEADING_SIZE = 1.2;
const NUMBERED = /^(chapter|part|section|appendix|lecture|unit|book)\b|^\d+(\.\d+){0,2}\.?\s+\p{Lu}/iu;

interface Line {
  page: number;
  /** PDF y of the baseline; larger is higher up the page. */
  y: number;
  size: number;
  text: string;
}

export async function collectContentsSource(
  doc: PDFDocumentProxy,
  bookTitle: string,
  onProgress: (page: number) => void,
  signal: AbortSignal,
): Promise<ContentsSource> {
  const frontPages: ContentsSource["frontPages"] = [];
  const lines: Line[] = [];
  // Font sizes weighted by how much text uses them; the most used one is the body text.
  const sizeUse = new Map<number, number>();

  for (let n = 1; n <= doc.numPages; n++) {
    if (signal.aborted) throw new DOMException("Stopped.", "AbortError");
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const byLine = new Map<number, { y: number; size: number; parts: { x: number; str: string }[] }>();
    let pageText = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      pageText += item.str + (item.hasEOL ? "\n" : "");
      const text = item.str.trim();
      if (!text) continue;
      const [a, b, c, d, x, y] = item.transform as number[];
      const size = Math.round(Math.max(Math.hypot(a, b), Math.hypot(c, d)) * 2) / 2;
      sizeUse.set(size, (sizeUse.get(size) ?? 0) + text.length);
      const key = Math.round(y / 2);
      const line = byLine.get(key) ?? { y, size: 0, parts: [] };
      line.size = Math.max(line.size, size);
      line.parts.push({ x, str: item.str });
      byLine.set(key, line);
    }
    if (n <= FRONT_PAGES) frontPages.push({ page: n, text: pageText.slice(0, FRONT_PAGE_CHARS) });
    for (const line of byLine.values()) {
      const text = line.parts
        .sort((p, q) => p.x - q.x)
        .map((p) => p.str)
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (text.length >= 2 && text.length <= MAX_LINE_CHARS) lines.push({ page: n, y: line.y, size: line.size, text });
    }
    page.cleanup();
    if (n % 10 === 0) onProgress(n);
  }

  const body = [...sizeUse.entries()].sort((p, q) => q[1] - p[1])[0]?.[0] ?? 10;
  const candidates = lines
    .map((l) => ({ ...l, size: l.size / body }))
    .filter((l) => l.size >= HEADING_SIZE || (l.size >= 1 && NUMBERED.test(l.text)));

  // Keep the biggest few per page, then the biggest overall if there are still too many.
  const perPage = new Map<number, Line[]>();
  for (const l of candidates) perPage.set(l.page, [...(perPage.get(l.page) ?? []), l]);
  let headings = [...perPage.values()].flatMap((ls) => ls.sort((p, q) => q.size - p.size).slice(0, HEADINGS_PER_PAGE));
  if (headings.length > MAX_HEADINGS) {
    headings = headings.sort((p, q) => q.size - p.size).slice(0, MAX_HEADINGS);
  }
  headings.sort((p, q) => p.page - q.page || q.y - p.y);

  return {
    bookTitle,
    pageCount: doc.numPages,
    frontPages,
    headings: headings.map((h) => ({ page: h.page, size: Math.round(h.size * 10) / 10, text: h.text })),
  };
}
