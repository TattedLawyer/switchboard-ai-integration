import Anthropic from "@anthropic-ai/sdk";

export interface LlmClient {
  complete(prompt: string): Promise<string>;
}

export class TemplateLlm implements LlmClient {
  async complete(prompt: string): Promise<string> {
    return `_(deterministic template — set ANTHROPIC_API_KEY for narrative)_\n\n${prompt}`;
  }
}

// 30s hard ceiling per LLM call — the Monday report must always generate, so a hung or
// slow API call falls back to the deterministic template rather than blocking the run.
const LLM_TIMEOUT_MS = 30_000;

export class AnthropicLlm implements LlmClient {
  private client: Anthropic;
  private fallback = new TemplateLlm();

  // Client is injectable for testability (stub clients in tests); defaults to the real SDK.
  constructor(client: Anthropic = new Anthropic()) {
    this.client = client;
  }

  async complete(prompt: string): Promise<string> {
    const started = Date.now();
    try {
      // verify current model id before Phase 3 live runs
      const msg = await this.client.messages.create(
        {
          model: "claude-sonnet-5",
          max_tokens: 1024,
          system: [
            {
              type: "text",
              text: "You write terse operational reports for a B2B ops team. Data is synthetic demo data.",
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [{ role: "user", content: prompt }],
        },
        { signal: AbortSignal.timeout(LLM_TIMEOUT_MS) },
      );
      console.log(
        JSON.stringify({
          llm: "anthropic",
          input_tokens: msg.usage?.input_tokens ?? 0,
          output_tokens: msg.usage?.output_tokens ?? 0,
          duration_ms: Date.now() - started,
        }),
      );
      return msg.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("\n");
    } catch (err) {
      // ANY failure (timeout, API error, network) degrades to the template — never throw.
      console.warn(`anthropic call failed, falling back to template: ${err instanceof Error ? err.message : String(err)}`);
      const result = await this.fallback.complete(prompt);
      console.warn(
        JSON.stringify({
          llm: "template-fallback",
          input_tokens: 0,
          output_tokens: 0,
          duration_ms: Date.now() - started,
        }),
      );
      return result;
    }
  }
}

export function pickLlm(): LlmClient {
  return process.env.ANTHROPIC_API_KEY ? new AnthropicLlm() : new TemplateLlm();
}
