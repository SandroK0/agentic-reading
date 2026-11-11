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
  /** Follow-up questions asked on this card, oldest first. The fields above track the latest turn's conversation. */
  followUps?: FollowUp[];
  /** Minimised to its header in the panel. */
  collapsed?: boolean;
}

/** A follow-up question and its answer, shown inside its explanation's card. */
export interface FollowUp {
  /** Also the widget id for its drawing. */
  id: string;
  question: string;
  prose: string;
  html: string;
  createdAt: number;
}

export interface BookState {
  page: number;
  /** What the library shows for the book, saved when it's opened. */
  info?: BookInfo;
  /** When the book was last opened, in ms since the epoch. */
  openedAt?: number;
  explanations: Explanation[];
  /** A table of contents written by the model, for PDFs that don't have one. */
  generatedContents?: GeneratedContents;
}

export interface BookInfo {
  title: string;
  kind: "pdf" | "epub";
  /** Pages in a PDF, sections in an EPUB. */
  pageCount: number;
}

/** A recent book as the library shows it. */
export interface LibraryBook {
  path: string;
  info?: BookInfo;
  page: number;
  explanationCount: number;
  openedAt?: number;
}

/** One line of a table of contents. `level` 1 is a chapter, 2 a section, 3 a subsection. */
export interface ContentsEntry {
  title: string;
  /** 1-based PDF page. */
  page: number;
  level: number;
}

export interface GeneratedContents {
  entries: ContentsEntry[];
  provider: string;
  model: string;
  createdAt: number;
}

/** What the model reads to build a table of contents, gathered from the PDF in the renderer. */
export interface ContentsSource {
  bookTitle: string;
  pageCount: number;
  /** Full text of the first pages, where a printed table of contents usually is. */
  frontPages: { page: number; text: string }[];
  /** Lines that look like headings, with their size relative to the body text. */
  headings: { page: number; size: number; text: string }[];
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
  /** Recent books, most recent first, with what the library shows for each. */
  library(): Promise<LibraryBook[]>;
  saveBookInfo(path: string, info: BookInfo): Promise<void>;
  bookState(path: string): Promise<BookState>;
  savePage(path: string, page: number): Promise<void>;
  saveExplanation(path: string, explanation: Explanation): Promise<void>;
  deleteExplanation(path: string, id: string): Promise<void>;
  settings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  providers(): Promise<ProviderInfo[]>;
  /** Builds and saves a table of contents for a book; rejects with a readable message. */
  generateContents(bookPath: string, source: ContentsSource): Promise<GeneratedContents>;
  cancelContents(bookPath: string): Promise<void>;
  removeContents(bookPath: string): Promise<void>;
  explain(request: ExplainRequest): Promise<void>;
  cancel(id: string): Promise<void>;
  onExplainEvent(listener: (event: ExplainEvent) => void): void;
  onOpenBook(listener: (path: string) => void): void;
  /** The OS, e.g. "darwin", for platform-specific layout. */
  platform: string;
  onFullscreen(listener: (fullscreen: boolean) => void): void;
  /** URL that serves an explainer's HTML inside a sandboxed frame, in the reader's theme and light/dark palette. */
  widgetUrl(id: string, theme: string, scheme: "light" | "dark"): string;
}
