import type { ContentsEntry, ContentsSource, GeneratedContents, Settings } from "../shared/types";
import { pickModel, type LlmProvider } from "./llm";

/**
 * Builds a table of contents for a PDF that has none. The model reads the
 * book's front pages (for a printed contents page) and the heading-like lines
 * found on every page, and answers with entries keyed to PDF page numbers.
 * The reply is checked here, so callers only ever see well-formed entries.
 */

const SYSTEM_PROMPT = `You build the table of contents for a book from text extracted from its PDF.

# Output format (strict)
Reply with exactly this and nothing else:

<contents>
[{"title": "Chapter title", "page": 12, "level": 1}, ...]
</contents>

# Rules
- "page" is the PDF page number, the N in the [p N] markers you are given. Never use the printed page number.
- If the front pages contain the book's own printed table of contents, follow it: its titles, order and nesting. Printed page numbers usually differ from PDF page numbers by an offset (front matter, roman numerals, inserts). Work out the offset by matching printed entries to the headings list, check it at several points through the book, and allow it to change where the headings show it does.
- With no printed contents, build it from the headings list.
- Levels follow the book's own hierarchy, three at most. Level 1 is its largest division: parts when chapters are grouped into parts (then chapters are level 2 and sections level 3, and finer subsections are left out), otherwise chapters (then sections level 2, subsections level 3 only when they help). Never put a chapter at the same level as the part that contains it.
- Titles as the book writes them, with chapter or section numbers kept, cleaned of dot leaders, page numbers and running headers.
- Reading order, with pages never going backwards. Include front and back matter (Preface, Appendix, Index) only when they are real headings.
- Aim for a useful sidebar: every chapter, and their main sections. At most about 400 entries.`;

const MAX_ENTRIES = 600;

export class ContentsGenerator {
  private running = new Map<string, AbortController>();

  constructor(private providers: LlmProvider[]) {}

  async generate(bookPath: string, source: ContentsSource, settings: Settings): Promise<GeneratedContents> {
    const { provider, model } = pickModel(this.providers, settings);
    this.running.get(bookPath)?.abort();
    const controller = new AbortController();
    this.running.set(bookPath, controller);
    try {
      const { text } = await provider.chat({
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt(source) }],
        model,
        signal: controller.signal,
        onText: () => {},
      });
      const entries = parseEntries(text, source.pageCount);
      if (!entries.length) throw new Error("Couldn't find any chapters or headings in this book.");
      return { entries, provider: provider.id, model, createdAt: Date.now() };
    } finally {
      if (this.running.get(bookPath) === controller) this.running.delete(bookPath);
    }
  }

  cancel(bookPath: string) {
    this.running.get(bookPath)?.abort();
  }

  cancelAll() {
    for (const controller of this.running.values()) controller.abort();
  }
}

function userPrompt(source: ContentsSource): string {
  return [
    `Book: "${source.bookTitle}" (${source.pageCount} PDF pages)`,
    "",
    "<front-pages>",
    ...source.frontPages.map((p) => `[p ${p.page}]\n${p.text}`),
    "</front-pages>",
    "",
    "<headings>",
    "Lines set larger than the body text, or that look like chapter and section headings. Size is relative to the body text.",
    ...source.headings.map((h) => `[p ${h.page}] (×${h.size.toFixed(1)}) ${h.text}`),
    "</headings>",
  ].join("\n");
}

/** Pulls the JSON list out of a reply and keeps only entries that make sense for this book. */
export function parseEntries(text: string, pageCount: number): ContentsEntry[] {
  const body = /<contents>([\s\S]*?)(<\/contents>|$)/.exec(text)?.[1] ?? text;
  const json = body.slice(body.indexOf("["), body.lastIndexOf("]") + 1);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("The model's answer wasn't a readable table of contents. Try again.");
  }
  if (!Array.isArray(raw)) return [];
  const entries: ContentsEntry[] = [];
  for (const item of raw) {
    const { title, page, level } = (item ?? {}) as Record<string, unknown>;
    if (typeof title !== "string" || !title.trim()) continue;
    const p = Math.round(Number(page));
    if (!Number.isFinite(p) || p < 1 || p > pageCount) continue;
    const l = Math.min(3, Math.max(1, Math.round(Number(level)) || 1));
    entries.push({ title: title.trim().slice(0, 200), page: p, level: l });
    if (entries.length >= MAX_ENTRIES) break;
  }
  // Pages never go backwards, or "current section" highlighting breaks; the sort is stable,
  // so entries on the same page keep the model's order.
  return entries.sort((a, b) => a.page - b.page);
}
