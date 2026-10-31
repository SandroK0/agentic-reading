import type { ChatMessage } from "../../shared/types";

export type { ChatMessage };

/**
 * The one seam between the app and a language model. The explainer only ever
 * talks to an LlmProvider; each way of reaching a model (the Claude Code CLI
 * today, a local model or an API later) is one implementation of it,
 * registered in ./index.ts.
 */

export interface ModelOption {
  id: string;
  label: string;
}

export interface ChatRequest {
  system: string;
  /** The whole conversation so far, ending with the new user message. */
  messages: ChatMessage[];
  /** One of the provider's `models` ids. */
  model: string;
  /**
   * The provider's own handle on this conversation, from an earlier reply of
   * the same provider. A provider that can resume a conversation may use it
   * instead of resending `messages`; others ignore it.
   */
  resume?: string;
  /** Aborted when the reader presses Stop or quits. */
  signal: AbortSignal;
  /** Called with the full reply text so far, as it streams in. */
  onText: (textSoFar: string) => void;
}

export interface ChatResult {
  text: string;
  /** A handle the provider can resume this conversation from next time. */
  resume?: string;
}

export interface LlmProvider {
  /** Stable id, saved with settings and explanations. */
  readonly id: string;
  readonly label: string;
  readonly models: ModelOption[];
  readonly defaultModel: string;
  /** Runs one turn. Rejects with a readable Error, or an AbortError when stopped. */
  chat(request: ChatRequest): Promise<ChatResult>;
}

export function abortError(): Error {
  const err = new Error("Stopped.");
  err.name = "AbortError";
  return err;
}
