import { ClaudeCliProvider } from "./claude-cli";
import type { LlmProvider } from "./provider";

export type { ChatMessage, LlmProvider, ModelOption } from "./provider";

/**
 * Every way the app can reach a model. To support another one (a local model,
 * an API), implement LlmProvider in its own file and add it here; the
 * explainer and the UI pick it up from this list.
 */
export function createProviders(opts: { workDir: string }): LlmProvider[] {
  return [new ClaudeCliProvider(opts.workDir)];
}
