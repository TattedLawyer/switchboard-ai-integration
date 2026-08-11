// The harness's only real logic: saying out loud what the stored data is and is not.
//
// 🚨 TWO SENTENCES THIS SURFACE MAY NEVER OMIT, and both are pinned:
//   · A SUMMARY IS GENERATED, NOT VERBATIM, and there is NO STORED TRANSCRIPT to check it
//     against. The pointer to the email that holds the real record is the only bridge, and
//     it is un-retrofittable — if it is not rendered, nothing else can supply it.
//   · ANSWERS FROM AN IDENTITY-UNVERIFIED TOUCH CAME FROM THAT NUMBER, NOT FROM THAT PERSON.
//     A nameless call is a legitimate call whose answers we store deliberately; rendering
//     them identically to verified ones would mislead her about provenance, which is worse
//     than not showing them.
//
// No CSS. Plain HTML. This is a window, not a product.
export const SUMMARY_BANNER_PREFIX = "generated summary — full record emailed";
export const NO_TRANSCRIPT_NOTE =
  "no transcript is stored anywhere; this summary cannot be checked against one";
export const IDENTITY_UNVERIFIED_LABEL =
  "IDENTITY UNVERIFIED — these answers came from this NUMBER, not from a confirmed person";
// 🚨 Minor 2: a PERMANENTLY-FAILED transcript must not render identically to one not yet
// attempted. On the surface built to tell her what the record IS and is NOT, "coming" and
// "gone for ever" are the one distinction §9 says must be visible, and they were both
// collapsing to "(not yet sent)". `transcript_delivery` carries the fact; render it.
export const TRANSCRIPT_LOST_NOTE =
  "TRANSCRIPT LOST — the email send failed and there is no stored copy to resend";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface TouchView {
  touchId: string;
  displayName: string | null;
  disposition: string | null;
  identityUnverified: boolean;
  summary: string | null;
  summaryState: "generated" | "failed" | null;
  transcriptEmailSentAt: Date | null;
  transcriptDelivery: "pending" | "sent" | "failed" | null;
  answers: Array<{ prompt: string; value: string }>;
}

export function renderTouch(t: TouchView): string {
  const parts: string[] = [];
  parts.push(`<h2>${escapeHtml(t.displayName ?? "(no name on file)")}</h2>`);
  parts.push(`<p>outcome: ${escapeHtml(t.disposition ?? "in progress")}</p>`);

  if (t.identityUnverified) {
    parts.push(`<p><strong>${escapeHtml(IDENTITY_UNVERIFIED_LABEL)}</strong></p>`);
  }

  // THE BANNER IS UNCONDITIONAL on a summary being rendered — including the failed case,
  // where the absence of a summary must not read as "the call had nothing to say".
  if (t.summaryState === "failed") {
    parts.push(
      `<p><em>${escapeHtml(SUMMARY_BANNER_PREFIX)} ` +
        `${escapeHtml(fmtDate(t.transcriptEmailSentAt))} · ${escapeHtml(NO_TRANSCRIPT_NOTE)}</em></p>`,
    );
    parts.push(`<p>summarising FAILED for this call — the emailed transcript is the record.</p>`);
  } else if (t.summary !== null) {
    parts.push(
      `<p><em>${escapeHtml(SUMMARY_BANNER_PREFIX)} ` +
        `${escapeHtml(fmtDate(t.transcriptEmailSentAt))} · ${escapeHtml(NO_TRANSCRIPT_NOTE)}</em></p>`,
    );
    parts.push(`<p>${escapeHtml(t.summary)}</p>`);
  }

  // The delivery fact, whenever a transcript was owed. `failed` is not `pending`: one is a
  // record gone for ever, the other is a record still coming.
  if (t.transcriptDelivery === "failed") {
    parts.push(`<p><strong>${escapeHtml(TRANSCRIPT_LOST_NOTE)}</strong></p>`);
  } else if (t.transcriptDelivery === "pending") {
    parts.push(`<p><em>transcript not yet delivered</em></p>`);
  }

  if (t.answers.length > 0) {
    // The label repeats over the ANSWERS as well as the summary: the two are read
    // separately and either one alone can mislead.
    if (t.identityUnverified) {
      parts.push(`<p><strong>${escapeHtml(IDENTITY_UNVERIFIED_LABEL)}</strong></p>`);
    }
    parts.push("<dl>");
    for (const a of t.answers) {
      parts.push(`<dt>${escapeHtml(a.prompt)}</dt><dd>${escapeHtml(a.value)}</dd>`);
    }
    parts.push("</dl>");
  }
  return parts.join("\n");
}

function fmtDate(d: Date | null): string {
  return d === null ? "(not yet sent)" : d.toISOString().slice(0, 10);
}
