import type { Settings } from "../../shared/types";
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

/** The provider and model the settings ask for, falling back to defaults when a setting no longer exists. */
export function pickModel(providers: LlmProvider[], settings: Settings): { provider: LlmProvider; model: string } {
  const provider = providers.find((p) => p.id === settings.provider) ?? providers[0];
  const model = provider.models.some((m) => m.id === settings.model) ? settings.model : provider.defaultModel;
  return { provider, model };
}
