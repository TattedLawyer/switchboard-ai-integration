import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { eventSchema as fromServer } from "../src/server.js";
import { eventSchema as fromLeaf } from "../src/event-schema.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");

// Step 0 pin: the event schema exists ONCE, in the leaf module, and every door uses that
// one object. The duplication this replaces was structurally forced by an import cycle
// (see event-schema.ts header); this test is what stops it re-forming.
describe("event schema unification", () => {
  it("server re-exports the exact leaf schema object", () => {
    expect(fromServer).toBe(fromLeaf);
  });

  it("the schema shape is defined in exactly one src file", () => {
    const files = readdirSync(SRC, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts"));
    const defining = files.filter((f) =>
      readFileSync(join(SRC, f), "utf8").includes("occurred_at: z")
    );
    expect(defining).toEqual(["event-schema.ts"]);
  });

  it("both doors reject the same payload (behavioral)", () => {
    const bad = { event_id: "evt-1", event_type: "deal.updated", occurred_at: "not-a-date", data: {} };
    // The webhook door and the replay door both run this same safeParse (replay via
    // replayQuarantined). One object, one verdict.
    expect(fromLeaf.safeParse(bad).success).toBe(false);
  });
});
