/** Types shared by the Electron main process, the preload and the renderer. */

/** One turn of a conversation with the model, kept so follow-ups work with any provider. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** What the model menu offers: each provider and its models. */
export interface ProviderInfo {
  id: string;
  label: string;
  models: { id: string; label: string }[];
}

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
  /** The reader's own question about the passage; with `parentId`, a follow-up in that conversation. */
  question?: string;
  parentId?: string;
  mode: ExplainMode;
}

export type ExplainEvent =
  | { id: string; type: "text"; text: string }
  | {
      id: string;
      type: "done";
      prose: string;
      html: string;
      provider: string;
      model: string;
      resume?: string;
      conversation: ChatMessage[];
    }
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
  /** Which provider and model wrote it. Missing on older saves, which came from the Claude CLI. */
  provider?: string;
  model?: string;
  /** The provider's handle for resuming the conversation, if it has one. */
  resume?: string;
  /** The conversation up to and including this reply. Missing on older saves. */
  conversation?: ChatMessage[];
  /** Claude CLI session id from older saves; superseded by `resume`. */
  sessionId?: string;
  createdAt: number;
}

export interface BookState {
  page: number;
  explanations: Explanation[];
}

export interface Settings {
  provider: string;
  model: string;
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
  providers(): Promise<ProviderInfo[]>;
  explain(request: ExplainRequest): Promise<void>;
  cancel(id: string): Promise<void>;
  onExplainEvent(listener: (event: ExplainEvent) => void): void;
  onOpenBook(listener: (path: string) => void): void;
  /** URL that serves an explainer's HTML inside a sandboxed frame. */
  widgetUrl(id: string): string;
}
