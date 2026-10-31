import fs from "node:fs";
import path from "node:path";
import type { BookState, Explanation, GeneratedContents, Settings } from "../shared/types";

/** Small JSON store in the app's userData folder: recents, pages, explainers. */

interface State {
  recents: string[];
  books: Record<string, BookState>;
  settings: Settings;
}

const MAX_RECENTS = 12;

export class Store {
  private state: State;

  constructor(private file: string) {
    this.state = { recents: [], books: {}, settings: { provider: "claude-cli", model: "sonnet" } };
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      this.state = { ...this.state, ...saved, settings: { ...this.state.settings, ...saved.settings } };
    } catch {
      // first run, or an unreadable file: start fresh
    }
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  private book(bookPath: string): BookState {
    return (this.state.books[bookPath] ??= { page: 1, explanations: [] });
  }

  recents() {
    return this.state.recents.filter((p) => fs.existsSync(p));
  }

  touchRecent(bookPath: string) {
    this.state.recents = [bookPath, ...this.state.recents.filter((p) => p !== bookPath)].slice(0, MAX_RECENTS);
    this.save();
  }

  bookState(bookPath: string): BookState {
    return this.state.books[bookPath] ?? { page: 1, explanations: [] };
  }

  allExplanations(): Explanation[] {
    return Object.values(this.state.books).flatMap((b) => b.explanations);
  }

  savePage(bookPath: string, page: number) {
    this.book(bookPath).page = page;
    this.save();
  }

  saveExplanation(bookPath: string, explanation: Explanation) {
    const book = this.book(bookPath);
    book.explanations = [explanation, ...book.explanations.filter((e) => e.id !== explanation.id)];
    this.save();
  }

  deleteExplanation(bookPath: string, id: string) {
    const book = this.book(bookPath);
    book.explanations = book.explanations.filter((e) => e.id !== id);
    this.save();
  }

  saveGeneratedContents(bookPath: string, contents: GeneratedContents | null) {
    const book = this.book(bookPath);
    if (contents) book.generatedContents = contents;
    else delete book.generatedContents;
    this.save();
  }

  settings(): Settings {
    return this.state.settings;
  }

  saveSettings(settings: Settings) {
    this.state.settings = settings;
    this.save();
  }
}
