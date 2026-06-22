/* Server-owned provider resolution.
 *
 * Reads ONLY the server environment — never any client-supplied input. Returns
 * the Anthropic adapter, or throws `ai_unavailable` when no API key is
 * configured. The deterministic fake provider is NEVER selectable here; test
 * substitution happens only by passing a provider argument into the
 * orchestration from the verification harness. */

import { AiError, type ExperienceAiProvider } from "./provider";
import { AnthropicProvider } from "./anthropic-adapter";
import { INTERPRET_MODEL } from "./models";

export function resolveProvider(): ExperienceAiProvider {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    throw new AiError(
      "ai_unavailable",
      503,
      "AI is not configured (ANTHROPIC_API_KEY is not set).",
    );
  }
  return new AnthropicProvider(key, INTERPRET_MODEL);
}
