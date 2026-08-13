// Email spike / Task 8 pins — the transport seam.
//
// NO NETWORK. Every case here runs against a stub transport handed to the factory. The one
// suite that opens a real SMTP conversation is `email-ethereal.test.ts`, and it is gated.
//
// 🚨 THE ALLOWLIST IS BOUND TO THE TRANSPORT, NOT ONLY TO `executeEmail`. Defence in depth,
// and deliberate: enforcing it at one call site makes fail-closed a property of that call
// site rather than of the thing that opens sockets. A later debug script that imports
// `smtpSender` to "just test SMTP" would otherwise reach any address at hand with no pin
// catching it. `executeEmail`'s check is the one that refuses BEFORE any connection opens;
// this one is the one that holds when someone forgets `executeEmail`.
import { describe, it, expect } from "vitest";
import { smtpSender, buildTransportOptions, type EmailSubmission } from "../src/email-transport.js";

const CONFIG = {
  host: "smtp.example.com",
  port: 587,
  user: "u",
  pass: "p",
  from: "marisol@example.com",
};
const ALLOW = ["ana@example.com"];
const MSG = { to: "ana@example.com", subject: "Following up", body: "Hi Ana" };

/** A stub in Nodemailer's shape: one `sendMail` returning an `info`. */
function stub(info: Record<string, unknown>, calls: unknown[] = []) {
  return {
    calls,
    transport: {
      sendMail: async (m: unknown) => {
        calls.push(m);
        return info;
      },
    },
  };
}

describe("Task 8: the transport seam maps Nodemailer's info to our own type", () => {
  it("carries messageId, accepted, rejected and response through", async () => {
    const s = stub({
      messageId: "<abc@relay>",
      accepted: ["ana@example.com"],
      rejected: [],
      response: "250 2.0.0 OK",
    });
    const send = smtpSender(CONFIG, ALLOW, s.transport);
    const out: EmailSubmission = await send(MSG);

    expect(out.messageId).toBe("<abc@relay>");
    expect(out.accepted).toEqual(["ana@example.com"]);
    expect(out.rejected).toEqual([]);
    expect(out.response).toBe("250 2.0.0 OK");
  });

  // 🚨 A NON-EMPTY `rejected` IS A FAILURE EVEN THOUGH NOTHING THREW. This is the state
  // that silently reports success: Nodemailer resolves, the CLI prints "submitted", and the
  // relay accepted the envelope for nobody.
  // mutation: ignore `info.rejected` -> red. RUN ✅ 2026-08-12
  //   Observed: `Tests  1 failed | 7 passed (8)`
  it("treats a rejected recipient as a failure even when nothing threw", async () => {
    const s = stub({
      messageId: "<abc@relay>",
      accepted: [],
      rejected: ["ana@example.com"],
      response: "550 no such user",
    });
    const send = smtpSender(CONFIG, ALLOW, s.transport);
    await expect(send(MSG)).rejects.toThrow(/rejected/i);
  });

  it("treats an empty accepted list as a failure too", async () => {
    const s = stub({ messageId: "<abc@relay>", accepted: [], rejected: [], response: "250" });
    const send = smtpSender(CONFIG, ALLOW, s.transport);
    await expect(send(MSG)).rejects.toThrow(/accepted/i);
  });
});

describe("Task 8: the transport is bound to the allowlist (defence in depth)", () => {
  // mutation: delete the factory's re-check -> red. RUN ✅ 2026-08-12
  //   Observed: `Tests  2 failed | 6 passed (8)` — the bypass pin and the fail-closed pin.
  it("refuses an off-allowlist recipient even when checkSendable is bypassed entirely", async () => {
    const s = stub({ messageId: "<x>", accepted: ["stranger@example.com"], rejected: [] });
    const send = smtpSender(CONFIG, ALLOW, s.transport);
    await expect(send({ ...MSG, to: "stranger@example.com" })).rejects.toThrow(/allowlist/i);
    // The socket-opening call was never made.
    expect(s.calls.length).toBe(0);
  });

  it("refuses everything when constructed with an empty allowlist (fail-closed)", async () => {
    const s = stub({ messageId: "<x>", accepted: ["ana@example.com"], rejected: [] });
    const send = smtpSender(CONFIG, [], s.transport);
    await expect(send(MSG)).rejects.toThrow(/allowlist/i);
    expect(s.calls.length).toBe(0);
  });

  it("refuses a CR/LF recipient at the transport too", async () => {
    const s = stub({ messageId: "<x>", accepted: [], rejected: [] });
    const send = smtpSender(CONFIG, ALLOW, s.transport);
    await expect(send({ ...MSG, to: "ana@example.com\r\nBcc: stranger@example.com" })).rejects.toThrow();
    expect(s.calls.length).toBe(0);
  });
});

describe("Task 8: the three timeouts are explicit, and they are real values", () => {
  // 🚨 ASSERTED ON THE VALUES THE FACTORY BUILT, NOT ON THE FILE'S CHARACTERS. A source-text
  // pin that only checks the three names APPEAR is passed by `connectionTimeout: 0`, which
  // means "no timeout at all" — a pin claiming something it does not check.
  // mutation: set `connectionTimeout: 0` -> red. RUN ✅ 2026-08-12
  //   Observed: `Tests  1 failed | 7 passed (8)`
  //     AssertionError: connectionTimeout > 0: expected +0 to be greater than +0
  //   A source-text pin would have stayed GREEN on this: the name still appears.
  it("passes finite, positive connection/greeting/socket timeouts", () => {
    const opts = buildTransportOptions(CONFIG);
    for (const k of ["connectionTimeout", "greetingTimeout", "socketTimeout"] as const) {
      expect(Number.isFinite(opts[k]), `${k} finite`).toBe(true);
      expect(opts[k], `${k} > 0`).toBeGreaterThan(0);
    }
  });

  it("does not enable a Nodemailer-level retry or queue", () => {
    const opts = buildTransportOptions(CONFIG) as Record<string, unknown>;
    expect(opts.pool ?? false).toBe(false);
  });
});
