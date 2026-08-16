// The approval service, booted WITH a real login-link sender — the composition root for
// A0b's human surface. Same relative-import exemption as `executor-loop.ts`,
// `ci-fixture.ts`, `verify-identity.ts` and `drive-execute.ts`: 69ad456 closed
// cross-workspace src imports on purpose, and the composition root is the one thing that
// must cross, so it lives outside both tsconfigs.
//
// WHY THIS EXISTS. `approval/src/main.ts` cannot import the SMTP seam
// (`crm/src/email-transport.ts` — the ONE file allowed to open a socket to a mail relay),
// so run bare it refuses to enable the human surface unless ALLOW_DEV_SECRETS=1 prints
// links to the terminal. This script is the deployment shape for a real mailbox: it wires
// the Postmark transport into `main()` as the magic-link sender and changes nothing else.
//
// 🚨 FAIL-CLOSED, NOT STUBBED. The executor daemon degrades to a stub sender because a
// rehearsal of the SEND path is useful. A login path may not rehearse: a login page whose
// links silently go nowhere is a lockout wearing a success page. So a missing or partial
// SMTP configuration here is a boot refusal naming the variables, never a stub.
//
// 🚨 THE ALLOWLIST GOVERNS LOGIN MAIL TOO. `smtpSender` re-checks
// SWITCHBOARD_EMAIL_ALLOWLIST immediately before opening the socket, so the approver's
// own address must be ON the allowlist or her sign-in link is refused (loudly, as a 503
// on the request page's error path — never silently). That is the right default for a
// system whose whole posture is "this deployment can reach exactly the mailboxes the
// operator listed".
import { main } from "../approval/src/main.js";
import { smtpSender } from "../crm/src/email-transport.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is required — the composition root refuses to boot the human surface ` +
        "without a working relay, because a login link that silently goes nowhere is a " +
        "lockout that looks like a bug.",
    );
  }
  return v;
}

const allowlist = (process.env.SWITCHBOARD_EMAIL_ALLOWLIST ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (allowlist.length === 0) {
  throw new Error(
    "SWITCHBOARD_EMAIL_ALLOWLIST is empty — every sign-in link would be refused at the " +
      "socket. Add the approver's address.",
  );
}

const send = smtpSender(
  {
    host: required("SMTP_HOST"),
    port: Number(process.env.SMTP_PORT ?? 587),
    user: required("SMTP_USER"),
    pass: required("SMTP_PASS"),
    from: required("SMTP_FROM"),
    // Postmark routes to a named Message Stream by header. Omitting it is NOT an error —
    // it silently uses the default `outbound` stream, which is a wrong-destination
    // failure that reports success.
    ...(process.env.POSTMARK_MESSAGE_STREAM
      ? { headers: { "X-PM-Message-Stream": process.env.POSTMARK_MESSAGE_STREAM } }
      : {}),
  },
  allowlist,
);

main({
  sendLoginLink: async (to, url) => {
    await send({
      to,
      subject: "Your Switchboard sign-in link",
      body:
        "Use this link to sign in to the approval queue:\n\n" +
        `${url}\n\n` +
        "It works exactly once and expires in 15 minutes. If you did not request it, " +
        "you can ignore this email — nothing happens until the link is used.",
    });
  },
}).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
