// Email spike — the vendor seam. The ONLY file in this repo that can open a socket to a
// mail relay.
//
// 🚨 THE ALLOWLIST IS A CONSTRUCTOR ARGUMENT AND IS RE-CHECKED IMMEDIATELY BEFORE
// `sendMail`. `executeEmail` already calls `checkSendable` — earlier, before any connection
// opens, which is the check that matters for "a refusal burns nothing". This one is
// redundant ON PURPOSE: without it, fail-closed is a property of ONE CALL SITE rather than
// of the thing that opens sockets, and a later debug script importing `smtpSender` to "just
// test SMTP" would reach whatever address was at hand with no pin catching it. The
// redundancy is the feature.
//
// 🚨 THIS FILE DECLARES DURATIONS; IT NEVER COMPARES AGAINST A CLOCK. The three timeouts
// below are Nodemailer's own values, stated explicitly so they are visible and reviewable
// rather than implicit defaults. They are the only durations anywhere on the email path,
// and the no-timer pin (`no-timers.test.ts`) is what keeps it that way.
//
// 🚨 NOTHING HERE MEANS "DELIVERED". `EmailSubmission` records what the relay ACCEPTED.
// Delivery is knowable only asynchronously, from a bounce feed this system does not poll.
import nodemailer from "nodemailer";

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

/** What we learned from handing the relay a message. NOT a delivery receipt. */
export interface EmailSubmission {
  /** The relay's id for the submission. Recorded as the execution's vendor reference. */
  messageId: string;
  /** Recipients the relay took responsibility for. */
  accepted: string[];
  /** Recipients it refused. Non-empty is a FAILURE even though nothing threw. */
  rejected: string[];
  /** The raw final SMTP response line, for the operator's report. */
  response: string;
}

export type SendEmail = (msg: EmailMessage) => Promise<EmailSubmission>;

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** The confirmed sender signature. A relay will refuse an unconfirmed one, loudly. */
  from: string;
  /**
   * Relay-specific headers, verbatim.
   *
   * 🚨 EXISTS FOR ONE DOCUMENTED REASON: Postmark routes a message to a named Message Stream
   * via `X-PM-Message-Stream: <stream-id>`, and OMITTING it is not an error — the message
   * silently goes out through the default `outbound` transactional stream instead. That is a
   * wrong-destination failure that reports success, so the header is passed explicitly
   * rather than left to a default nobody chose.
   *
   * NOT a general extension point for caller-supplied text. Values are refused if they carry
   * CR/LF, for the same reason the recipient and subject are: a newline here is header
   * injection, and this is the one file that can open a socket.
   */
  headers?: Readonly<Record<string, string>>;
}

/** Nodemailer's own documented values, restated so they are reviewable here rather than
 *  implicit. Declared, never compared against a clock. */
const CONNECTION_TIMEOUT_MS = 120_000;
const GREETING_TIMEOUT_MS = 30_000;
const SOCKET_TIMEOUT_MS = 600_000;

export interface TransportOptions {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  /** No pool: no queue, no vendor-level retry. One send, one answer. */
  pool: false;
}

/** Exported so the pin can inspect the options the factory BUILT, rather than the file's
 *  characters — `connectionTimeout: 0` passes a source-text pin and means "no timeout". */
export function buildTransportOptions(config: SmtpConfig): TransportOptions {
  return {
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    pool: false,
  };
}

/** Minimal structural view of what this module needs from a Nodemailer transport, so a stub
 *  can stand in without the tests reaching for `any`. */
export interface MailTransport {
  sendMail: (m: {
    from: string;
    to: string;
    subject: string;
    text: string;
    headers?: Record<string, string>;
  }) => Promise<unknown>;
}

/**
 * Build the one function that can put a message on the wire.
 *
 * @param config    relay host/port/credentials and the confirmed From address
 * @param allowlist the recipients this deployment may reach — RE-CHECKED before `sendMail`
 * @param transport injected in tests; the real Nodemailer transport otherwise
 */
export function smtpSender(
  config: SmtpConfig,
  allowlist: readonly string[],
  transport?: MailTransport,
): SendEmail {
  const permitted = allowlist
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.length > 0);

  const tx: MailTransport =
    transport ?? (nodemailer.createTransport(buildTransportOptions(config)) as MailTransport);

  return async (msg: EmailMessage): Promise<EmailSubmission> => {
    // 🚨 THE RE-CHECK, before anything opens. Fail-closed on an empty list.
    if (permitted.length === 0) {
      throw new Error(
        "the recipient allowlist is empty, so this transport may reach nobody (fail-closed)",
      );
    }
    if (/[\r\n]/.test(msg.to) || /[\r\n]/.test(msg.subject)) {
      throw new Error("the recipient or subject contains a carriage return or newline");
    }
    if (!permitted.includes(msg.to.toLowerCase())) {
      throw new Error(`recipient ${msg.to} is not on the allowlist`);
    }
    // Same CR/LF refusal as the recipient and subject above, applied to header values: a
    // newline in a header is injection, and this file is the only one that opens a socket.
    for (const [k, v] of Object.entries(config.headers ?? {})) {
      if (/[\r\n]/.test(k) || /[\r\n]/.test(v)) {
        throw new Error(`header ${JSON.stringify(k)} contains a carriage return or newline`);
      }
    }

    const info = (await tx.sendMail({
      from: config.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.body,
      ...(config.headers ? { headers: { ...config.headers } } : {}),
    })) as {
      messageId?: string;
      accepted?: unknown[];
      rejected?: unknown[];
      response?: string;
    };

    const accepted = (info.accepted ?? []).map(String);
    const rejected = (info.rejected ?? []).map(String);

    // 🚨 THE STATE THAT SILENTLY REPORTS SUCCESS. Nodemailer resolves, nothing throws, and
    // the relay accepted the envelope for NOBODY. Surfaced as a failure.
    if (rejected.length > 0) {
      throw new Error(
        `the relay rejected ${rejected.join(", ")} — ${info.response ?? "no response"}`,
      );
    }
    if (accepted.length === 0) {
      throw new Error(
        `the relay accepted no recipient — ${info.response ?? "no response"}`,
      );
    }

    return {
      messageId: String(info.messageId ?? ""),
      accepted,
      rejected,
      response: String(info.response ?? ""),
    };
  };
}
