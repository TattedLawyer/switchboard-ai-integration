import Anthropic from "@anthropic-ai/sdk";

export interface LlmClient {
  complete(prompt: string): Promise<string>;
}

export class TemplateLlm implements LlmClient {
  async complete(prompt: string): Promise<string> {
    return `_(deterministic template — set ANTHROPIC_API_KEY for narrative)_\n\n${prompt}`;
  }
}

export class AnthropicLlm implements LlmClient {
  private client = new Anthropic();
  async complete(prompt: string): Promise<string> {
    // verify current model id before Phase 3 live runs
    const msg = await this.client.messages.create({
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
    });
    return msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n");
  }
}

export function pickLlm(): LlmClient {
  return process.env.ANTHROPIC_API_KEY ? new AnthropicLlm() : new TemplateLlm();
}
