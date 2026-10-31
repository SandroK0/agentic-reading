/** Types shared by the Electron main process, the preload and the renderer. */

export type ModelChoice = "sonnet" | "opus";

/** "text": a short written explanation. "visual": a brief caption plus a static drawing. */
export type ExplainMode = "text" | "visual";

export interface ExplainRequest {
  /** Client-generated id that ties streamed events to a card. */
  id: string;
  bookPath: string;
  bookTitle: string;
  page: number;
  pageCount: number;
  /** The selected passage; empty for questions about the whole page. */
  passage: string;
  /** Text around the passage (or the page text), for grounding. */
  context: string;
  /** A follow-up question; when set, `sessionId` continues the earlier chat. */
  question?: string;
  sessionId?: string;
  mode: ExplainMode;
  model: ModelChoice;
}

export type ExplainEvent =
  | { id: string; type: "text"; text: string }
  | { id: string; type: "done"; prose: string; html: string; sessionId: string }
  | { id: string; type: "error"; message: string };

export interface Explanation {
  id: string;
  page: number;
  passage: string;
  question?: string;
  /** Missing on explainers saved before modes existed; those were visual. */
  mode?: ExplainMode;
  prose: string;
  html: string;
  sessionId: string;
  createdAt: number;
}

export interface BookState {
  page: number;
  explanations: Explanation[];
}

export interface Settings {
  model: ModelChoice;
}

export interface ReaderApi {
  openDialog(): Promise<string | null>;
  pathForFile(file: File): string;
  readBook(path: string): Promise<Uint8Array>;
  recentBooks(): Promise<string[]>;
  bookState(path: string): Promise<BookState>;
  savePage(path: string, page: number): Promise<void>;
  saveExplanation(path: string, explanation: Explanation): Promise<void>;
  deleteExplanation(path: string, id: string): Promise<void>;
  settings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  explain(request: ExplainRequest): Promise<void>;
  cancel(id: string): Promise<void>;
  onExplainEvent(listener: (event: ExplainEvent) => void): void;
  onOpenBook(listener: (path: string) => void): void;
  /** URL that serves an explainer's HTML inside a sandboxed frame. */
  widgetUrl(id: string): string;
}
