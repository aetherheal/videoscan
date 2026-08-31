import { env } from "../config/env.js";
import { AnthropicProvider } from "./anthropic.js";
import { CodexCliProvider } from "./codex-cli.js";
import type { LlmProvider } from "./types.js";

// The judge and bilingual summary share VIDEOSCAN_MODEL on Anthropic. Catalog
// stays on its lower-cost Anthropic model; Codex intentionally uses one CLI
// model across all three calls.
export function providerFor(kind: "judge" | "catalog"): LlmProvider {
  const settings = env();
  if (settings.provider === "codex") {
    return new CodexCliProvider({
      model: settings.codexModel,
      timeoutMs: settings.codexTimeoutMs,
    });
  }

  if (!settings.anthropicApiKey) {
    // env() already guarantees this. Keeping the narrow here makes the
    // provider construction safe if Env is extended later.
    throw new Error("ANTHROPIC_API_KEY is not set.");
  }
  return new AnthropicProvider({
    apiKey: settings.anthropicApiKey,
    model: kind === "catalog" ? settings.catalogModel : settings.model,
  });
}

export type { LlmProvider } from "./types.js";
