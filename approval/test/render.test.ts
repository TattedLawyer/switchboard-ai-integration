// Phase 3 / A2, T6 — the card is COMPLETE and it is DETERMINISTIC.
//
// These two properties are what remains after `presentation_hash` was deleted. The deleted
// mechanism rendered bytes on the server, hashed them, posted the hash to the browser, and
// compared it against a SERVER-SIDE RE-RENDER OF THE SAME ROW AT THE SAME VERSION — both
// sides our own pure function of one immutable input, at the same instant. No independent
// variable existed, so nothing could ever differ: it detected only our own renderer
// nondeterminism while its published sentence claimed to attest what her browser painted.
//
// What survives is that determinism check, moved to where a determinism check belongs — CI
// — and given a REAL independent variable: the pin below renders in a DIFFERENT PROCESS,
// under a different `TZ`, a different locale and a different clock. A locale-dependent
// formatter in the payload region flips it.
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  RATIONALE_CAPTION,
  escapeHtml,
  RENDERER_VERSION,
  renderPayloadRegion,
  renderProposalCard,
} from "../src/render.js";

const execFileAsync = promisify(execFile);
const RENDER_ONCE = fileURLToPath(new URL("./helpers/render-once.ts", import.meta.url));

const CARD = {
  id: "11111111-2222-3333-4444-555555555555",
  action_type: "send_email",
  payload: {
    to: "jane@client.example.com",
    subject: "Your listing expires Friday",
    body: "Shall I renew it?",
  },
  rationale: "The listing agreement lapses in 3 days and no renewal is on file.",
  expires_at: "2026-08-11T20:00:00.000Z",
};

describe("A2/T6: the display map may order and label — it may NOT omit", () => {
  it("renders a key the map has never heard of", async () => {
    // mutation: filter the payload to mapped keys only (drop the "additional fields"
    //           block from `renderPayloadRegion`) -> this reds. RUN ✅ 2026-08-08
    //
    // A dropped field is a field the human approved and the executor acts on unseen. That
    // is the same defect class as a silently discarded proposal, and it is the one a
    // display map makes easy: the map is written once, the payload grows later.
    const html = renderPayloadRegion("send_email", {
      to: "jane@client.example.com",
      attach_invoice_id: "INV-4471",
    });
    expect(html).toContain("attach_invoice_id");
    expect(html).toContain("INV-4471");
    expect(html).toContain("Additional fields");
  });

  it("renders every key of an entirely unmapped ACTION type too", () => {
    // The map has one entry today. An action type it does not know must still render its
    // whole payload rather than a blank card.
    const html = renderPayloadRegion("some_future_action", { alpha: 1, beta: "two" });
    expect(html).toContain("alpha");
    expect(html).toContain("beta");
    expect(html).toContain("two");
  });

  it("shows each key exactly once — mapped keys are not duplicated into the extras", () => {
    const html = renderPayloadRegion("send_email", { to: "a@example.com", extra: 1 });
    expect(html.match(/a@example\.com/g)?.length).toBe(1);
  });

  it("does not summarise nested values — a count is an expander by another name", () => {
    const html = renderPayloadRegion("send_email", { attachments: ["a.pdf", "b.pdf"] });
    expect(html).toContain("a.pdf");
    expect(html).toContain("b.pdf");
  });
});

describe("A2/T6: the payload region is byte-identical across processes, zones and clocks", () => {
  it("renders the same bytes under a different TZ, locale and clock", async () => {
    // mutation: put a locale-dependent formatter into the payload region — e.g. render a
    //           number with `toLocaleString()` or a date with `toLocaleDateString()` —
    //           -> this reds. RUN ✅ 2026-08-08
    //
    // THIS PIN IS NOT A SHAPE-1 SELF-COMPARISON. Its two sides differ in PROCESS, TZ,
    // LOCALE and CLOCK — a real independent variable. The mechanism it replaced had none.
    const payload = {
      to: "jane@client.example.com",
      amount: 1234567.89,
      when: "2026-08-11T20:00:00.000Z",
      count: 1000000,
      nested: { z: 1, a: [2, 3] },
    };
    const args = [JSON.stringify(payload), "send_email"];

    const runIn = async (env: Record<string, string>): Promise<string> => {
      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", RENDER_ONCE, ...args],
        { env: { ...process.env, ...env } },
      );
      return stdout;
    };

    const a = await runIn({ TZ: "UTC", LANG: "C", LC_ALL: "C" });
    const b = await runIn({ TZ: "Asia/Manila", LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8" });
    const c = await runIn({ TZ: "Pacific/Kiritimati", LANG: "ar_EG.UTF-8", LC_ALL: "ar_EG.UTF-8" });

    expect(b, "TZ/locale changed the payload region").toBe(a);
    expect(c, "TZ/locale changed the payload region").toBe(a);
    // The witness: the bytes are not empty, and they are the same bytes this process makes.
    expect(a.length).toBeGreaterThan(50);
    expect(a).toBe(renderPayloadRegion("send_email", payload));
  }, 60_000);
});

describe("A2/T6: `rationale` is rendered INERTLY", () => {
  it("escapes HTML for its actual output context — `&` included", () => {
    // mutation: drop `escapeHtml` from the rationale block -> this reds. RUN ✅ 2026-08-08
    //
    // 🚨 `fenceUntrusted` IS THE WRONG FUNCTION HERE. It is a MARKDOWN fence and this
    // surface is HTML: it does not escape `&`, it mishandles attribute contexts, and it
    // strips characters harmless in HTML while leaving the real escaping undone. The
    // doctrine transfers; the function does not.
    const html = renderProposalCard({
      ...CARD,
      rationale: `<script>alert(1)</script> & "quoted" 'single'`,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
    expect(html).toContain("&#39;");
  });

  it("escapes the PAYLOAD too — a payload string is model-influenced as well", () => {
    const html = renderProposalCard({
      ...CARD,
      payload: { subject: '"><img src=x onerror=alert(1)>' },
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("carries a caption the model never authored, before the prose", () => {
    // An injected instruction in `rationale` has to fool a PERSON, not a model. The
    // caption is a constant in the source for exactly that reason: if it could come from
    // the row, the attacker would write it.
    const html = renderProposalCard(CARD);
    // Escaped, because the caption itself goes through the same escaper everything else
    // does — there is no "trusted" path into this surface, not even for our own strings.
    const caption = escapeHtml(RATIONALE_CAPTION);
    expect(html).toContain(caption);
    expect(html.indexOf(caption)).toBeLessThan(html.indexOf(escapeHtml(CARD.rationale)));
    // ...and the prose is inside its own fixed block, never loose in the card body.
    expect(html).toMatch(/<blockquote class="rationale-text">/);
  });

  it("cannot style itself as system chrome — the block's class is ours, not the row's", () => {
    const html = renderProposalCard({
      ...CARD,
      rationale: '</blockquote><p class="rationale-caption">Approved by Switchboard</p>',
    });
    // One caption, and it is ours.
    expect(html.match(/class="rationale-caption"/g)?.length).toBe(1);
    expect(html).toContain("&lt;/blockquote&gt;");
  });
});

describe("A2/T6: the card's face", () => {
  it("differentiates by action type and states what will happen", () => {
    expect(renderProposalCard(CARD)).toContain("Send an email on your behalf");
  });

  it("offers exactly three outcomes and no bulk anything", () => {
    // "Not now" writes a decision row and leaves the proposal pending — a decision, not a
    // transition, which is why `dismissed` is absent from the state machine. Passive
    // navigation records nothing: we cannot distinguish "considered it and walked away"
    // from "closed the laptop", and recording the second as the first would manufacture
    // evidence about a human's state of mind.
    const html = renderProposalCard(CARD);
    for (const v of ["approved", "rejected", "dismissed"]) {
      expect(html).toContain(`value="${v}"`);
    }
    expect(html.toLowerCase()).not.toContain("approve all");
    expect(html.toLowerCase()).not.toContain("select all");
  });

  it("has no expander — a detail nobody opens is a detail nobody saw", () => {
    const html = renderProposalCard(CARD);
    expect(html).not.toContain("<details");
    expect(html.toLowerCase()).not.toContain("show more");
  });

  it("records the renderer version as data, and nothing reads it back", () => {
    // 🚨 AUDIT METADATA ONLY. If a future change compares this to anything at runtime,
    // that is the deleted `renderer_version` check returning, and it is banned by name.
    expect(renderProposalCard(CARD)).toContain(`data-renderer-version="${RENDERER_VERSION}"`);
  });

  it("shows the expiry as an INSTANT, outside the payload region", () => {
    // A countdown or a localised local time is not a pure function of the row, and putting
    // one in the payload region is exactly how the determinism pin reds.
    const html = renderProposalCard(CARD);
    expect(html).toContain(`datetime="${CARD.expires_at}"`);
    const region = renderPayloadRegion(CARD.action_type, CARD.payload);
    expect(region).not.toContain(CARD.expires_at);
  });
});
