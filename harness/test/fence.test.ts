// Core loop / T14 pins.
//
// 🚨 THE REAL DELIVERABLE OF T14 IS THE FENCE, not the HTML. Every "temporary" operator
// surface in this industry became permanent by being imported once.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHarness, HarnessRefused, LOOPBACK } from "../src/server.js";
import {
  renderTouch,
  SUMMARY_BANNER_PREFIX,
  NO_TRANSCRIPT_NOTE,
  IDENTITY_UNVERIFIED_LABEL,
  type TouchView,
} from "../src/render.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* sourceFiles(p);
    else if (p.endsWith(".ts")) yield p;
  }
}

describe("T14: nothing in the product imports the harness", () => {
  // mutation: add `import { renderTouch } from "../../harness/src/render.js";` to
  //           `crm/src/reconcile.ts` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 7 passed (8)`
  //     AssertionError: expected [ 'crm/src/reconcile.ts' ] to deeply equal []
  //
  // This is what stops a throwaway accreting into a dependency. The harness may read the
  // product; the product may never read the harness.
  it("has no reference to harness/ from crm, approval, ingest or agent src", () => {
    const offenders: string[] = [];
    for (const ws of ["crm", "approval", "ingest", "agent"]) {
      for (const file of sourceFiles(join(ROOT, ws, "src"))) {
        const src = readFileSync(file, "utf8");
        if (/from\s+["'][^"']*harness\//.test(src) || /require\(["'][^"']*harness\//.test(src)) {
          offenders.push(file.slice(ROOT.length + 1));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("T14: the bind address IS the access control", () => {
  // mutation: allow a non-loopback host — drop the `LOOPBACK.has(host)` refusal -> red.
  //           RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 7 passed (8)`
  //     AssertionError: expected function to throw an error, but it didn't
  //
  // No auth, no session. A tool like that is safe only while it is unreachable, so the
  // refusal is fail-closed and happens BEFORE any socket is opened.
  it("refuses 0.0.0.0", () => {
    expect(() =>
      createHarness({ host: "0.0.0.0", databaseUrl: "postgres://x/y", nodeEnv: "test" }),
    ).toThrow(HarnessRefused);
    expect(LOOPBACK.has("127.0.0.1")).toBe(true);
  });

  // mutation: drop the `NODE_ENV=production` refusal -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 7 passed (8)`
  //     AssertionError: expected function to throw an error, but it didn't
  it("refuses to boot under NODE_ENV=production", () => {
    expect(() =>
      createHarness({ databaseUrl: "postgres://x/y", nodeEnv: "production" }),
    ).toThrow(HarnessRefused);
  });
});

const BASE: TouchView = {
  touchId: "t1",
  displayName: "Ana Reyes",
  disposition: "answered",
  identityUnverified: false,
  summary: "Wants a 2BR near Alabang, budget around 5M, moving in Q4.",
  summaryState: "generated",
  transcriptEmailSentAt: new Date("2026-08-09T02:00:00Z"),
  transcriptDelivery: "sent",
  answers: [{ prompt: "What budget range?", value: "around 5, maybe 6" }],
};

describe("T14: a summary never renders bare", () => {
  // mutation: render `t.summary` without the banner -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 7 passed (8)`
  //     AssertionError: expected '<h2>Ana Reyes</h2>\n<p>outcome: answe…' to contain
  //                     'generated summary — full record email…'
  //
  // The summary is GENERATED, and there is NO STORED TRANSCRIPT to check it against. The
  // pointer to the email that holds the real record is the only bridge and it is
  // un-retrofittable.
  it("carries the generated-not-verbatim banner and the transcript pointer", () => {
    const html = renderTouch(BASE);
    expect(html).toContain(SUMMARY_BANNER_PREFIX);
    expect(html).toContain("2026-08-09");
    expect(html).toContain(NO_TRANSCRIPT_NOTE);
  });

  it("says a failed summary FAILED, rather than showing nothing", () => {
    const html = renderTouch({ ...BASE, summary: null, summaryState: "failed" });
    expect(html).toContain(SUMMARY_BANNER_PREFIX);
    expect(html).toMatch(/summarising FAILED/);
  });
});

describe("T14: an identity-unverified touch is labelled everywhere it appears", () => {
  // mutation: render an identity-unverified touch identically to a verified one — drop the
  //           label -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 7 passed (8)`
  //     AssertionError: expected 1 to be 2   — the label survived over the ANSWERS and
  //     vanished from the summary block, which is exactly the half-labelled render this pin
  //     counts occurrences to catch.
  //
  // These answers are from THAT NUMBER, not from THAT PERSON. She must not be misled about
  // provenance — and the label repeats over the ANSWERS as well as the summary, because the
  // two are read separately and either alone can mislead.
  it("labels both the summary block and the answer list", () => {
    const html = renderTouch({ ...BASE, displayName: null, identityUnverified: true });
    const occurrences = html.split(IDENTITY_UNVERIFIED_LABEL).length - 1;
    expect(occurrences).toBe(2);
    expect(renderTouch(BASE)).not.toContain(IDENTITY_UNVERIFIED_LABEL);
  });

  it("escapes what the prospect said — it is untrusted text in an HTML context", () => {
    const html = renderTouch({
      ...BASE,
      answers: [{ prompt: "Budget?", value: "<script>alert(1)</script>" }],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("T14: the README says it is disposable and when to delete it", () => {
  // mutation: remove DISPOSABLE (or the deletion criterion) from harness/README.md -> red.
  //           RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 7 passed (8)`
  //     AssertionError: expected '# temporary operator harness…' to contain 'DISPOSABLE'
  it("contains DISPOSABLE and a deletion criterion", () => {
    const readme = readFileSync(join(ROOT, "harness", "README.md"), "utf8");
    expect(readme).toContain("DISPOSABLE");
    expect(readme).toMatch(/deletion criterion/i);
    expect(readme).toMatch(/Delete this directory/i);
  });
});
