// Business-card capture — the on-ramp to the follow-up loop that already runs.
//
// THE USER STORY. The broker collects cards in the field and then the card is lost or the
// follow-up never happens. The loop half is ALREADY SOLVED: a contact created the intake
// way gets `next_due_at = now()`, the proposer claims it next cycle, she approves, the
// executor sends (crm/src/intake.ts). These routes are the missing first step: photograph
// the card at the handshake, CONFIRM the extracted fields, and the contact enters that
// loop before the card can be lost.
//
// TWO OWNER RULINGS, IMPLEMENTED NOT RELITIGATED:
//   1. SHE CONFIRMS BEFORE A CONTACT EXISTS. Extraction is imperfect and a wrong email is
//      outreach to a stranger. `/cards/extract` renders a form; `/cards/create` stores the
//      CONFIRMED FORM FIELDS ONLY — nothing is carried from extraction past her eyes.
//   2. 🚨 THE PHOTO IS NEVER PERSISTED. The image lives in this process's memory for the
//      duration of ONE request (`/cards/extract`), is handed to the extraction seam, and
//      is gone when the response is written. No disk write, no database column, no session
//      stash, no log line with bytes in it. She keeps the photo on her phone if she wants.
//
// SAME DOOR, SAME DEFENCES AS /queue AND /decide, by construction (the knowledge.ts
// pattern): registered FROM `registerHumanRoutes` with the very middleware instances the
// decision surface uses — sessionMw, the Fetch-Metadata guard, csrf-sync's synchronizer
// token, requireLogin — and BEFORE human.ts's CSRF error handler, so a stale token here
// earns the same "Not recorded" page.
//
// WHY THESE ROUTES WRITE `crm.contacts` AS `switchboard_approval`: capture is a HUMAN
// surface, and the only web-facing role is the approval role. Intake's CLI path runs as
// the migration owner and cannot be a phone workflow. Migration 025 grants the approval
// role exactly the columns this file writes and reads — nothing else changed hands, and
// `switchboard_agent` still holds NOTHING anywhere in `crm`.
//
// THE INSERTS BELOW DELIBERATELY DUPLICATE `crm/src/intake.ts` (addContact/addNumber) —
// the house cross-workspace idiom is deliberate duplication with a keep-in-sync note
// (approval/test/canonical.test.ts V15; crm/src/sheet-columns.ts:9 precedent), because
// 69ad456 closed cross-workspace src imports. 🚨 KEEP IN SYNC: if intake.ts changes what
// a capture means (columns, `next_due_at = now()`, E.164 dedupe, ordinal = entry order),
// this file must follow. The properties themselves are pinned in card-capture.test.ts C4.
import express from "express";
import type pg from "pg";
import { escapeHtml } from "./render.js";
import type { HumanSurfaceKit } from "./knowledge.js";
import { stubExtractCard, type CardFields, type ExtractCard } from "./card-extract.js";
import { isCardPhoneError, normalizeCardPhone } from "./card-phone.js";

export type { ExtractCard } from "./card-extract.js";

/** The upload ceiling. JUDGMENT number, reasoning on record: a modern phone camera JPEG
 *  (12–48 MP) lands between ~2 and ~8 MB; HEIC is smaller. 10 MB accepts effectively any
 *  phone photo while bounding what one request may hold in RAM — the image is deliberately
 *  memory-resident (ruling 2: it must never touch disk), so the limit IS the memory bound.
 *  The express.raw limit is set one megabyte higher because it measures the whole
 *  multipart envelope, not just the file. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const RAW_BODY_LIMIT = MAX_PHOTO_BYTES + 1024 * 1024;

/** How many phone inputs the confirmation form carries. Cards rarely show more than two
 *  numbers; three inputs cover the card plus one she adds by hand. Extraction overflow
 *  beyond this is SHOWN in a notice, never silently dropped. */
export const PHONE_FIELDS = 3;

// ── The extractor seam's composition hook ────────────────────────────────────────────────
// Per-app injection without threading a parameter through `registerHumanRoutes` (whose
// options the parallel surfaces share): the composition root — scripts/, or a test —
// provides the real extractor against the app instance; absent, the stub answers and the
// form does the whole job. Typed, deliberately not `app.set()`: a WeakMap keyed on the
// app cannot collide with anything else and dies with the app.
const extractors = new WeakMap<express.Express, ExtractCard>();

export function provideCardExtractor(
  app: express.Express,
  extract: ExtractCard | undefined,
): void {
  if (extract === undefined) extractors.delete(app);
  else extractors.set(app, extract);
}

// ── Multipart parsing ────────────────────────────────────────────────────────────────────
// Hand-rolled for exactly ONE shape — a browser form with text fields and one file — and
// nothing else, because `approval/` ships no multipart library (express 5's body parsers
// stop at json/urlencoded/raw/text) and buying busboy/multer for one bounded form is a
// dependency this repo would have to provenance-audit for a job forty lines cover. The
// body arrives via `express.raw` (which enforces the size limit BEFORE these lines run)
// and is split on the boundary with Buffer.indexOf — binary-safe, no string round-trips
// of image bytes.

export interface ParsedMultipart {
  fields: Record<string, string>;
  /** The first file part, if any. Bytes are a view into the request buffer — they live
   *  exactly as long as the request does. */
  file: { fieldName: string; filename: string; mimeType: string; bytes: Buffer } | null;
}

export function parseMultipart(body: Buffer, contentType: string): ParsedMultipart {
  const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!bm) throw new Error("multipart body without a boundary parameter");
  const boundary = Buffer.from(`--${(bm[1] ?? bm[2]).trim()}`, "ascii");
  const CRLF = Buffer.from("\r\n", "ascii");

  const fields: Record<string, string> = {};
  let file: ParsedMultipart["file"] = null;

  let at = body.indexOf(boundary);
  if (at === -1) throw new Error("multipart body does not contain its own boundary");
  at += boundary.length;
  for (;;) {
    // After a boundary: `--` closes the stream, CRLF opens a part.
    if (body.subarray(at, at + 2).toString("ascii") === "--") break;
    if (!body.subarray(at, at + 2).equals(CRLF)) {
      throw new Error("malformed multipart: boundary not followed by CRLF or terminator");
    }
    at += 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n", "ascii"), at);
    if (headerEnd === -1) throw new Error("malformed multipart: part without header block");
    const headers = body.subarray(at, headerEnd).toString("utf8");
    const partStart = headerEnd + 4;
    const partEnd = body.indexOf(Buffer.concat([CRLF, boundary]), partStart);
    if (partEnd === -1) throw new Error("malformed multipart: part without closing boundary");
    const content = body.subarray(partStart, partEnd);

    const disp = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(headers);
    const nameM = disp ? /name="([^"]*)"/.exec(disp[1]) : null;
    const fileM = disp ? /filename="([^"]*)"/.exec(disp[1]) : null;
    const typeM = /content-type:\s*([^\r\n;]+)/i.exec(headers);
    if (nameM) {
      if (fileM) {
        // First file wins; a second file in a one-photo form is ignored as a field, not
        // silently stored.
        if (file === null && fileM[1] !== "") {
          file = {
            fieldName: nameM[1],
            filename: fileM[1],
            mimeType: (typeM?.[1] ?? "application/octet-stream").trim().toLowerCase(),
            bytes: Buffer.from(content), // copy: the raw body buffer may be pooled
          };
        }
      } else {
        fields[nameM[1]] = content.toString("utf8");
      }
    }
    at = partEnd + 2 + boundary.length;
  }
  return { fields, file };
}

// ── Registration ─────────────────────────────────────────────────────────────────────────

export interface CardCaptureOptions {
  tenantId: string;
}

export function registerCardCaptureRoutes(
  app: express.Express,
  pool: pg.Pool,
  opts: CardCaptureOptions,
  kit: HumanSurfaceKit,
): void {
  const { sessionMw, fetchMetadataGuard, form, csrfSynchronisedProtection, requireLogin } = kit;

  // The raw-body stage for the photo POST. Size is enforced HERE, by express.raw, before
  // a byte of parsing; the refusal below turns its 413 into words.
  const rawBody = express.raw({ type: "multipart/form-data", limit: RAW_BODY_LIMIT });
  const rawBodyErrors = (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void => {
    if (err && typeof err === "object" && (err as { type?: string }).type === "entity.too.large") {
      res
        .status(413)
        .type("html")
        .send(
          kit.page(
            "Photo too large",
            "<h1>That photo is too large</h1><p>The limit is 10 MB, which any phone " +
              "camera photo fits inside. Nothing was stored. Retake the photo at a normal " +
              "size, or <a href='/cards/manual'>type the details by hand</a>.</p>",
          ),
        );
      return;
    }
    next(err);
  };

  /** Turns the raw multipart buffer into `req.body` (text fields — the CSRF token rides
   *  here) and `res.locals.cardPhoto`. The photo's bytes exist ONLY on `res.locals` of
   *  this one request — never on the session, never on disk (ruling 2). */
  const multipartForm = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void => {
    const ct = req.get("content-type") ?? "";
    if (!ct.toLowerCase().startsWith("multipart/form-data")) {
      res
        .status(415)
        .type("html")
        .send(
          kit.page(
            "Not a photo upload",
            "<h1>Nothing was captured</h1><p>This route expects the photo form from " +
              "<a href='/cards'>/cards</a> (a multipart upload). Nothing was stored.</p>",
          ),
        );
      return;
    }
    if (!Buffer.isBuffer(req.body)) {
      res
        .status(400)
        .type("html")
        .send(
          kit.page(
            "Empty upload",
            "<h1>Nothing arrived</h1><p>The upload carried no body. Nothing was stored. " +
              "Go back to <a href='/cards'>/cards</a> and try again.</p>",
          ),
        );
      return;
    }
    try {
      const parsed = parseMultipart(req.body, ct);
      req.body = parsed.fields;
      res.locals.cardPhoto = parsed.file;
    } catch (err) {
      res
        .status(400)
        .type("html")
        .send(
          kit.page(
            "Upload unreadable",
            "<h1>The upload could not be read</h1><p>The form data was malformed: " +
              `${escapeHtml(err instanceof Error ? err.message : String(err))}. Nothing ` +
              "was stored. Go back to <a href='/cards'>/cards</a> and try again.</p>",
          ),
        );
      return;
    }
    next();
  };

  // ── GET /cards — the capture page ──────────────────────────────────────────────────────
  app.get(
    "/cards",
    sessionMw,
    requireLogin("page"),
    (req: express.Request, res: express.Response) => {
      res
        .status(200)
        .type("html")
        .send(
          kit.page(
            "Capture a card",
            "<h1>Capture a business card</h1>" +
              "<p>Photograph the card. You will see everything that was read and can " +
              "correct it BEFORE anything is saved — nothing is stored until you confirm. " +
              "The photo itself is never kept.</p>" +
              "<form method='post' action='/cards/extract' enctype='multipart/form-data'>" +
              kit.csrfField(req) +
              // `capture='environment'` opens the rear camera directly on a phone;
              // `accept='image/*'` keeps the picker to images. Both are hints the server
              // does not trust — the POST re-checks type and size.
              "<label>Card photo<br>" +
              "<input type='file' name='photo' accept='image/*' capture='environment' required>" +
              "</label> <button>Read the card</button></form>" +
              "<p>No photo, or no camera? <a href='/cards/manual'>Type the details instead</a>.</p>",
          ),
        );
    },
  );

  // ── GET /cards/manual — the same confirmation form, empty ──────────────────────────────
  app.get(
    "/cards/manual",
    sessionMw,
    requireLogin("page"),
    (req: express.Request, res: express.Response) => {
      res.status(200).type("html").send(
        kit.page("New contact", confirmFormBody(kit.csrfField(req), emptyValues(), [])),
      );
    },
  );

  // ── POST /cards/extract — photo in, confirmation form out. The image dies here. ───────
  app.post(
    "/cards/extract",
    sessionMw,
    fetchMetadataGuard,
    rawBody,
    rawBodyErrors,
    multipartForm,
    csrfSynchronisedProtection,
    requireLogin("action"),
    async (req: express.Request, res: express.Response) => {
      const photo = res.locals.cardPhoto as ParsedMultipart["file"];
      if (photo === null || photo.fieldName !== "photo") {
        res
          .status(400)
          .type("html")
          .send(
            kit.page(
              "No photo",
              "<h1>No photo arrived</h1><p>The form posted without a card photo. Nothing " +
                "was stored. Go back to <a href='/cards'>/cards</a>, or " +
                "<a href='/cards/manual'>type the details by hand</a>.</p>",
            ),
          );
        return;
      }
      if (!photo.mimeType.startsWith("image/")) {
        // C9: a non-image is refused with words, before any extractor sees it.
        res
          .status(415)
          .type("html")
          .send(
            kit.page(
              "Not an image",
              `<h1>That file is not an image</h1><p>It arrived as <code>${escapeHtml(photo.mimeType)}</code>. ` +
                "Only a photo of the card can be read. Nothing was stored. Go back to " +
                "<a href='/cards'>/cards</a> and photograph the card, or " +
                "<a href='/cards/manual'>type the details by hand</a>.</p>",
            ),
          );
        return;
      }
      if (photo.bytes.length > MAX_PHOTO_BYTES) {
        res
          .status(413)
          .type("html")
          .send(
            kit.page(
              "Photo too large",
              "<h1>That photo is too large</h1><p>The limit is 10 MB. Nothing was " +
                "stored. Retake it at a normal size, or " +
                "<a href='/cards/manual'>type the details by hand</a>.</p>",
            ),
          );
        return;
      }

      const extract = extractors.get(app) ?? stubExtractCard;
      let extracted: CardFields;
      const notices: string[] = [];
      try {
        // THE ONLY LINE THE IMAGE CROSSES. The seam gets the bytes for this one call;
        // nothing below this point touches them, and no reference outlives the response.
        extracted = await extract({ bytes: photo.bytes, mimeType: photo.mimeType });
      } catch (err) {
        // C6: a broken extractor costs her NOTHING but the pre-fill. Loud on the page
        // (a silent empty form would read as "the card was blank"), loud in the log,
        // and the manual form still does the whole job.
        console.error("[approval] card extraction failed:", err);
        extracted = { name: null, company: null, email: null, phones: [], raw: null };
        notices.push(
          "Card reading FAILED — this is a system fault, not a blank card: " +
            `${err instanceof Error ? err.message : String(err)}. ` +
            "Nothing is lost: type the details below and save as usual.",
        );
      }
      // HONESTY PASS over what extraction claims to have read: a phone the normaliser
      // cannot parse is NAMED as unreadable (and left in the field for her to fix), and
      // an email that is not shaped like one is NAMED as a problem — never silently
      // pre-filled as if it were fine, never silently dropped (C7).
      for (const p of extracted.phones) {
        const n = normalizeCardPhone(p);
        if (isCardPhoneError(n)) {
          notices.push(
            `A phone number on the card is UNREADABLE as extracted: ${n.error}. It is ` +
              "left in its field — check it against the card and fix it before saving.",
          );
        }
      }
      if (extracted.email !== null && extracted.email !== "" && !EMAIL_SHAPE.test(extracted.email)) {
        notices.push(
          `The extracted email "${extracted.email}" does not look like an email address — ` +
            "check it against the card before saving; a wrong address emails a stranger.",
        );
      }
      res
        .status(200)
        .type("html")
        .send(
          kit.page(
            "Confirm the card",
            confirmFormBody(kit.csrfField(req), extracted, notices),
          ),
        );
    },
  );

  // ── POST /cards/create — HER confirmed fields become the contact ───────────────────────
  // 🚨 RULING 1 IS STRUCTURAL HERE: this handler reads the POSTED FORM FIELDS and nothing
  // else. There is no extraction state to reach for — the extract request died with its
  // response — so what she saw and edited is, by construction, all that can be stored.
  app.post(
    "/cards/create",
    sessionMw,
    fetchMetadataGuard,
    form,
    csrfSynchronisedProtection,
    requireLogin("action"),
    async (req: express.Request, res: express.Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const text = (k: string): string => (typeof body[k] === "string" ? (body[k] as string) : "");
      const name = text("name").trim();
      const company = text("company").trim();
      const email = text("email").trim();
      const note = text("note").trim();
      // Entry order is DIAL ORDER (intake.ts: ordinal = the order she entered them).
      const phonesTyped = Array.from({ length: PHONE_FIELDS }, (_, i) => text(`phone${i + 1}`))
        .map((p) => p.trim())
        .filter((p) => p !== "");

      // Validation and honesty: problems are SHOWN with her values preserved, never
      // silently discarded and never guessed around. Refusing an unreadable phone is
      // intake doctrine ("storing a number nobody can dial is not a capture, it is a
      // silent loss with a row attached"); everything else is accepted incomplete —
      // a lost lead is the failure this product exists to prevent.
      const problems: string[] = [];
      if (email !== "" && !EMAIL_SHAPE.test(email)) {
        problems.push(
          `"${email}" does not look like an email address. Fix it, or clear the field ` +
            "and add the address later — a missing address surfaces as a blocked " +
            "follow-up you can see; a wrong one emails a stranger.",
        );
      }
      const normalized: Array<{ e164: string; raw: string; region: string }> = [];
      for (const p of phonesTyped) {
        const n = normalizeCardPhone(p);
        if (isCardPhoneError(n)) {
          problems.push(
            `A phone number is UNREADABLE: ${n.error}. Fix it or clear the field — it ` +
              "was not stored, and it was not guessed at.",
          );
        } else {
          normalized.push(n);
        }
      }
      if (problems.length > 0) {
        res
          .status(422)
          .type("html")
          .send(
            kit.page(
              "Fix before saving",
              confirmFormBody(
                kit.csrfField(req),
                { name, company, email, phones: phonesTyped, raw: null },
                problems,
                note,
              ),
            ),
          );
        return;
      }

      // Channel derivation. Neither email nor phone: 'email' WITH a null address, on
      // purpose — intake doctrine §5.4: the gap surfaces as a blocked follow-up she can
      // see and fix. 'none' would exempt the contact from the loop silently, which is
      // the exact product failure ("never follows up") rebuilt as a default.
      const hasEmail = email !== "";
      const hasPhone = normalized.length > 0;
      const channel = hasEmail && hasPhone ? "both" : hasPhone ? "call" : "email";

      const client = await pool.connect();
      try {
        await client.query("begin");
        // KEEP IN SYNC with crm/src/intake.ts addContact: `next_due_at = now()` IS the
        // product — a newly captured lead is due immediately, so the next proposer cycle
        // claims it and the first follow-up actually happens. follow_up_interval_days is
        // not in the column list: NULL means "hers, at due-computation time" (due.ts),
        // and migration 025 makes writing it impossible from this role.
        const ins = await client.query<{ id: string }>(
          `insert into crm.contacts
             (tenant_id, display_name, email_address, channel, source, source_detail,
              looking_for, next_due_at)
           values ($1, $2, $3, $4, 'event', $5, $6, now())
           returning id`,
          [
            opts.tenantId,
            name === "" ? null : name,
            email === "" ? null : email,
            channel,
            company === "" ? `business card` : `business card — ${company}`,
            note === "" ? null : note,
          ],
        );
        const contactId = ins.rows[0].id;
        // KEEP IN SYNC with intake.ts addNumber: dedupe on E.164 (never on the raw
        // text), first raw form wins, ordinal = entry order = dial order.
        const seen = new Set<string>();
        let ordinal = 0;
        for (const n of normalized) {
          if (seen.has(n.e164)) continue;
          seen.add(n.e164);
          await client.query(
            `insert into crm.phone_numbers (contact_id, phone_e164, phone_raw, phone_region, ordinal)
             values ($1, $2, $3, $4, $5)`,
            [contactId, n.e164, n.raw, n.region, ordinal],
          );
          ordinal += 1;
        }
        await client.query("commit");
        res.redirect(303, `/cards/created/${contactId}`);
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        // LOUD, never a redirect — a redirect on failure discards her capture silently
        // (the /decide `fail` discipline).
        console.error("[approval] card capture insert failed:", err);
        res
          .status(503)
          .type("html")
          .send(
            kit.page(
              "Not recorded",
              "<h1>Not recorded</h1><p>The contact could not be stored: " +
                `<code>${escapeHtml(err instanceof Error ? err.message : String(err))}</code>. ` +
                "Go back and try again — nothing was saved.</p>",
            ),
          );
      } finally {
        client.release();
      }
    },
  );

  // ── GET /cards/created/:id — what was stored, READ BACK FROM THE ROW ───────────────────
  // Computed, never generated (read-from-source doctrine): every value on this page is a
  // column of the row just written, `next_due_at` included.
  app.get(
    "/cards/created/:id",
    sessionMw,
    requireLogin("page"),
    async (req: express.Request, res: express.Response) => {
      // express 5 types a param as string | string[] (repeatable segments); this route's
      // single segment is a string, and anything else fails the UUID gate below anyway.
      const id = typeof req.params.id === "string" ? req.params.id : "";
      const notFound = (): void => {
        res
          .status(404)
          .type("html")
          .send(
            kit.page(
              "Not found",
              "<h1>No such capture</h1><p>No contact with that id exists for this " +
                "tenant. If you just saved one, its link came from the save itself — " +
                "start again from <a href='/cards'>/cards</a>.</p>",
            ),
          );
      };
      if (!UUID_RE.test(id)) {
        notFound();
        return;
      }
      try {
        const c = await pool.query(
          `select id, display_name, email_address, channel, source_detail, looking_for,
                  next_due_at
             from crm.contacts where id = $1 and tenant_id = $2`,
          [id, opts.tenantId],
        );
        if (c.rowCount !== 1) {
          notFound();
          return;
        }
        const row = c.rows[0] as {
          display_name: string | null;
          email_address: string | null;
          channel: string;
          source_detail: string | null;
          looking_for: string | null;
          next_due_at: Date | null;
        };
        const phones = await pool.query<{ phone_raw: string; phone_e164: string }>(
          `select phone_raw, phone_e164 from crm.phone_numbers
            where contact_id = $1 order by ordinal`,
          [id],
        );
        const line = (label: string, value: string | null): string =>
          value === null || value === ""
            ? ""
            : `<p>${escapeHtml(label)}: <strong>${escapeHtml(value)}</strong></p>`;
        const phoneLines = phones.rows
          .map(
            (p) =>
              `<li>${escapeHtml(p.phone_raw)} (dials <code>${escapeHtml(p.phone_e164)}</code>)</li>`,
          )
          .join("");
        const due =
          row.next_due_at === null
            ? // A capture without a due date would be a contact OUTSIDE the loop — say so
              // rather than render calm (the no-silence doctrine).
              "<p><strong>⚠ This contact has NO next-due date — it will never be " +
              "proposed. That is a defect; tell your operator.</strong></p>"
            : `<p>Follow-up due: <strong>${escapeHtml(new Date(row.next_due_at).toISOString())}</strong> — ` +
              "due immediately, so the next follow-up cycle proposes the first touch " +
              "and you approve it from the <a href='/queue'>queue</a>.</p>";
        res
          .status(200)
          .type("html")
          .send(
            kit.page(
              "Contact saved",
              "<h1>Saved — follow-up loop engaged</h1>" +
                line("Name", row.display_name) +
                line("Email", row.email_address) +
                line("Channel", row.channel) +
                line("From", row.source_detail) +
                line("Note", row.looking_for) +
                (phoneLines === "" ? "" : `<p>Phones:</p><ul>${phoneLines}</ul>`) +
                due +
                "<p><a href='/cards'>Capture another card</a></p>",
            ),
          );
      } catch (err) {
        console.error("[approval] created-contact read failed:", err);
        res
          .status(503)
          .type("html")
          .send(
            kit.page(
              "Unavailable",
              "<h1>The contact could not be read</h1><p>This is NOT a missing contact: " +
                `<code>${escapeHtml(err instanceof Error ? err.message : String(err))}</code></p>`,
            ),
          );
      }
    },
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Conservative email shape: one @, no whitespace, a dot somewhere in the domain. Not a
 *  deliverability oracle — the loop's own bounce handling owns that — just the honesty
 *  bar: a string this refuses is shown to her as a problem, never stored silently. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── The confirmation form ────────────────────────────────────────────────────────────────

function emptyValues(): CardFields {
  return { name: null, company: null, email: null, phones: [], raw: null };
}

/** One form, three ways in (extracted, extraction-failed, manual), so they cannot drift.
 *  Every value is escaped on the way into the markup and EDITABLE in the markup — nothing
 *  the extractor said is auto-accepted or hidden (ruling 1: what she sees is all there is). */
function confirmFormBody(
  csrf: string,
  values: CardFields,
  notices: string[],
  note = "",
): string {
  const input = (name: string, label: string, value: string | null, type = "text"): string =>
    `<label>${escapeHtml(label)}<br><input type='${type}' name='${name}' ` +
    `value='${escapeHtml(value ?? "")}'></label><br>`;

  const phoneInputs = Array.from({ length: PHONE_FIELDS }, (_, i) =>
    input(`phone${i + 1}`, i === 0 ? "Phone" : `Phone ${i + 1}`, values.phones[i] ?? null, "tel"),
  ).join("");
  const overflow = values.phones.slice(PHONE_FIELDS);
  const overflowNote =
    overflow.length > 0
      ? [
          `The card showed ${overflow.length} more phone number(s) than this form holds: ` +
            `${overflow.join(", ")}. Copy any you want into a phone field — they are NOT ` +
            "carried silently.",
        ]
      : [];

  const noticeHtml = [...notices, ...overflowNote]
    .map((n) => `<p><strong>${escapeHtml(n)}</strong></p>`)
    .join("");

  const rawBlock =
    values.raw !== null && values.raw !== ""
      ? "<details><summary>Everything read off the card</summary><pre>" +
        escapeHtml(values.raw) +
        "</pre></details>"
      : "";

  return (
    "<h1>Confirm before saving</h1>" +
    noticeHtml +
    "<p>Check every field against the card — reading is imperfect, and a wrong email " +
    "means writing to a stranger. Nothing is stored until you press save. The photo " +
    "is not kept.</p>" +
    "<form method='post' action='/cards/create'>" +
    csrf +
    input("name", "Name", values.name) +
    input("company", "Company", values.company) +
    input("email", "Email", values.email) +
    phoneInputs +
    "<label>Note (where you met, what they were looking for)<br>" +
    `<textarea name='note' rows='2'>${escapeHtml(note)}</textarea></label><br>` +
    "<button>Save — follow-up starts now</button></form>" +
    rawBlock
  );
}
