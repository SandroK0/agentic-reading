import type { ChatMessage, ExplainEvent, ExplainRequest, Explanation, ProviderInfo, Settings } from "../shared/types";
import { pickModel, type LlmProvider } from "./llm";
import { parseReply, systemPrompt, userPrompt } from "./prompt";

/**
 * Turns a reader's request into an explanation: builds the prompts, carries
 * the conversation for follow-ups, streams progress and parses the reply. It
 * works with any LlmProvider; which one runs comes from the settings.
 */
export class Explainer {
  private running = new Map<string, AbortController>();

  constructor(private providers: LlmProvider[]) {}

  catalog(): ProviderInfo[] {
    return this.providers.map(({ id, label, models }) => ({ id, label, models }));
  }

  async explain(req: ExplainRequest, settings: Settings, parent: Explanation | undefined, emit: (e: ExplainEvent) => void) {
    const { provider, model } = pickModel(this.providers, settings);
    const messages: ChatMessage[] = [...(parent?.conversation ?? []), { role: "user", content: userPrompt(req) }];
    // A resume handle only means something to the provider that issued it.
    const resume = parent && (parent.provider ?? "claude-cli") === provider.id ? (parent.resume ?? parent.sessionId) : undefined;

    const controller = new AbortController();
    this.running.set(req.id, controller);
    try {
      const result = await provider.chat({
        system: systemPrompt(req.mode),
        messages,
        model,
        resume,
        signal: controller.signal,
        onText: (text) => emit({ id: req.id, type: "text", text }),
      });
      const { prose, html } = parseReply(result.text, req.mode);
      emit({
        id: req.id,
        type: "done",
        prose,
        html,
        provider: provider.id,
        model,
        resume: result.resume,
        conversation: [...messages, { role: "assistant", content: result.text }],
      });
    } catch (err) {
      emit({ id: req.id, type: "error", message: (err as Error).message || "Something went wrong." });
    } finally {
      this.running.delete(req.id);
    }
  }

  cancel(id: string) {
    this.running.get(id)?.abort();
  }

  cancelAll() {
    for (const controller of this.running.values()) controller.abort();
  }
}
