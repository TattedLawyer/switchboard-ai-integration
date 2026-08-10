// Core loop / T7 pins — the execution-time gates.
import { describe, it, expect } from "vitest";
import { gateExecution, isWithinWindow, localTime } from "../src/gates.js";

const WINDOW = { windowStart: "09:00:00", windowEnd: "18:00:00", timezone: "Asia/Manila" };

// Manila is UTC+8 and has no DST.
//   02:00Z = 10:00 Manila  -> inside
//   14:00Z = 22:00 Manila  -> outside
//   23:00Z = 07:00 Manila (next day) -> outside
const INSIDE_MANILA = new Date("2026-08-11T02:00:00Z");
const OUTSIDE_MANILA = new Date("2026-08-11T14:00:00Z");

describe("T7: a call approved inside the window and executed outside is REFUSED", () => {
  // mutation: move the check to proposal creation — `gateExecution` reading `i.approvedAt`
  //           instead of `i.now` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  2 failed | 4 passed (6)` —
  //     AssertionError: expected true to be false   (executed at 22:00 Manila, permitted)
  //     AssertionError: expected false to be true   (and the reverse case refused, which is
  //                                                  the same bug wearing the other face)
  //   Approval on Tuesday does not make a Thursday call permitted. A window checked when
  //   the card is created describes when the AGENT was thinking, not when the phone rings —
  //   and the gap between those two moments is exactly as long as the human takes to
  //   decide, which is the entire point of the approval spine.
  it("reads NOW, not the moment the human approved", () => {
    const r = gateExecution({
      channel: "call",
      approvedAt: INSIDE_MANILA,
      now: OUTSIDE_MANILA,
      window: WINDOW,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/outreach window/);
  });

  it("permits the same call when NOW is inside the window", () => {
    expect(
      gateExecution({
        channel: "call",
        approvedAt: OUTSIDE_MANILA,
        now: INSIDE_MANILA,
        window: WINDOW,
      }).allowed,
    ).toBe(true);
  });
});

describe("T7: the window is HERS, evaluated in Asia/Manila", () => {
  // mutation: hardcode UTC — `localTime(at, "UTC")` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  5 failed | 1 passed (6)` — the timezone is load-bearing almost
  //   everywhere in this file:
  //     AssertionError: expected '02:00' to be '10:00'
  //     AssertionError: expected '23:00' to be '07:00'
  //     AssertionError: expected '10:00' to be '18:00'
  //     AssertionError: expected true to be false
  //     AssertionError: expected false to be true
  //   The suite runs with TZ=UTC (crm/vitest.config.ts) precisely so the server locale
  //   DISAGREES with hers. A suite running in Manila would pass a UTC-hardcoded gate by
  //   coincidence, which is a green test certifying nothing.
  it("converts through the IANA zone, not the process locale", () => {
    expect(process.env.TZ).toBe("UTC");
    expect(localTime(INSIDE_MANILA, "Asia/Manila")).toBe("10:00");
    expect(localTime(INSIDE_MANILA, "UTC")).toBe("02:00");
    expect(isWithinWindow(INSIDE_MANILA, WINDOW)).toBe(true);
  });

  it("refuses 07:00 Manila even though it is 23:00 the previous day in UTC", () => {
    const early = new Date("2026-08-10T23:00:00Z"); // 07:00 Manila on the 11th
    expect(localTime(early, "Asia/Manila")).toBe("07:00");
    expect(isWithinWindow(early, WINDOW)).toBe(false);
  });

  it("treats the end of the window as exclusive", () => {
    const at1800 = new Date("2026-08-11T10:00:00Z"); // 18:00 Manila
    expect(localTime(at1800, "Asia/Manila")).toBe("18:00");
    expect(isWithinWindow(at1800, WINDOW)).toBe(false);
  });
});

describe("T7: the window does not gate an email", () => {
  // mutation: apply the window to both channels — drop the `if (channel === "email")`
  //           early return -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 5 passed (6)`
  //     AssertionError: expected false to be true // Object.is equality
  //   An outreach window is a rule about when a stranger's PHONE may ring. Applying it to
  //   an email suppresses a message for eighteen hours for no reason anybody could state —
  //   and it is one of the two reasons `both` resolves to TWO proposals rather than one
  //   composite (§5.3): the channels have different execution-time gates.
  it("sends at 22:00 Manila", () => {
    expect(
      gateExecution({
        channel: "email",
        approvedAt: INSIDE_MANILA,
        now: OUTSIDE_MANILA,
        window: WINDOW,
      }).allowed,
    ).toBe(true);
  });
});
