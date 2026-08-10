// Core loop / T7 — the execution-time gates.
//
// 🚨 EVALUATED IN THE EXECUTOR, NEVER AT PROPOSAL TIME. Approval on Tuesday does not make a
// Thursday call permitted. A window checked when the card is created is a window that
// describes when the AGENT was thinking, not when the phone rings — and the gap between
// those two moments is exactly as long as the human takes to decide, which is the whole
// point of the approval spine.
//
// THE WINDOW GOVERNS CALLS AND NOTHING ELSE. An outreach window is a rule about when a
// stranger's phone may ring; it is meaningless for an email, which the recipient opens when
// they choose. Applying it to both would suppress an email for eighteen hours for no reason
// anybody could state — and this is one of the two reasons `both` resolves to TWO proposals
// rather than one composite (§5.3): the channels have different execution-time gates.
//
// Manila has no DST, so the window is a plain wall-clock comparison in her timezone. That is
// a property of the deployment, not of the code, and the code does not assume it: the
// conversion goes through the IANA zone every time.
export interface OutreachWindow {
  /** 'HH:MM' or 'HH:MM:SS' — Postgres `time` renders the latter. */
  windowStart: string;
  windowEnd: string;
  /** IANA zone. Defaults to Asia/Manila in 016, but is never assumed here. */
  timezone: string;
}

const hhmm = (t: string): string => t.slice(0, 5);

/** Wall-clock time at `at`, in `timezone`, as 'HH:MM'. */
export function localTime(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}

export function isWithinWindow(at: Date, w: OutreachWindow): boolean {
  const now = localTime(at, w.timezone);
  const start = hhmm(w.windowStart);
  const end = hhmm(w.windowEnd);
  // A window that wraps midnight is not a thing she has asked for, and inventing semantics
  // for one would be a guess. Start < end is the only shape 016 admits in practice.
  return now >= start && now < end;
}

export interface GateInput {
  channel: "call" | "email";
  /** When the human approved. Present so the gate can be seen NOT to use it. */
  approvedAt: Date;
  /** NOW — the moment the phone would ring. This is what the gate reads. */
  now: Date;
  window: OutreachWindow;
}

export interface GateResult {
  allowed: boolean;
  reason?: string;
}

export function gateExecution(i: GateInput): GateResult {
  if (i.channel === "email") return { allowed: true };
  // 🚨 `i.now`, NOT `i.approvedAt`.
  if (!isWithinWindow(i.now, i.window)) {
    return {
      allowed: false,
      reason:
        `outside the outreach window ${hhmm(i.window.windowStart)}–${hhmm(i.window.windowEnd)} ` +
        `${i.window.timezone} (it is ${localTime(i.now, i.window.timezone)} there). ` +
        `The approval stands; the call does not happen now.`,
    };
  }
  void i.approvedAt;
  return { allowed: true };
}
