import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicLlm, TemplateLlm } from "../src/host/llm.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function stubClient(create: (...args: unknown[]) => Promise<unknown>) {
  return { messages: { create } } as unknown as ConstructorParameters<typeof AnthropicLlm>[0];
}

describe("AnthropicLlm operational envelope", () => {
  it("falls back to TemplateLlm output when the API call rejects, and logs a structured fallback line", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = stubClient(() => Promise.reject(new Error("api exploded")));
    const llm = new AnthropicLlm(client);

    const prompt = "weekly numbers: 42 deals";
    const result = await llm.complete(prompt); // must resolve, never throw

    const template = await new TemplateLlm().complete(prompt);
    expect(result).toBe(template);

    // One structured line: {llm:"template-fallback", input_tokens:0, output_tokens:0, duration_ms}
    const structured = warnSpy.mock.calls
      .map((args) => {
        try {
          return JSON.parse(String(args[0]));
        } catch {
          return null;
        }
      })
      .filter((o): o is Record<string, unknown> => o !== null && o.llm === "template-fallback");
    expect(structured).toHaveLength(1);
    expect(structured[0].input_tokens).toBe(0);
    expect(structured[0].output_tokens).toBe(0);
    expect(typeof structured[0].duration_ms).toBe("number");
  });

  it("returns API text and logs a structured anthropic line with usage on success", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const client = stubClient(() =>
      Promise.resolve({
        content: [{ type: "text", text: "narrative report" }],
        usage: { input_tokens: 123, output_tokens: 45 },
      }),
    );
    const llm = new AnthropicLlm(client);

    const result = await llm.complete("prompt");
    expect(result).toBe("narrative report");

    const structured = logSpy.mock.calls
      .map((args) => {
        try {
          return JSON.parse(String(args[0]));
        } catch {
          return null;
        }
      })
      .filter((o): o is Record<string, unknown> => o !== null && o.llm === "anthropic");
    expect(structured).toHaveLength(1);
    expect(structured[0].input_tokens).toBe(123);
    expect(structured[0].output_tokens).toBe(45);
    expect(typeof structured[0].duration_ms).toBe("number");
  });

  it("passes a timeout signal to the API call", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const create = vi.fn(() =>
      Promise.resolve({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const llm = new AnthropicLlm(stubClient(create));
    await llm.complete("prompt");
    expect(create).toHaveBeenCalledTimes(1);
    const options = create.mock.calls[0][1] as { signal?: AbortSignal } | undefined;
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });
});
