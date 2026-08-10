// The DISPOSABLE operator harness. See README.md — the real deliverable is the fence.
import { createServer, type Server } from "node:http";
import pg from "pg";
import { renderTouch, type TouchView } from "./render.js";

export const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export class HarnessRefused extends Error {}

export interface HarnessOptions {
  host?: string;
  port?: number;
  databaseUrl: string;
  nodeEnv?: string;
}

/**
 * 🚨 TWO REFUSALS, BOTH FAIL-CLOSED AND BOTH BEFORE ANY SOCKET IS OPENED.
 *
 * A throwaway tool with no auth and no session is safe only while it is unreachable. The
 * bind address IS the access control, so a non-loopback host is refused rather than warned
 * about; and `NODE_ENV=production` is refused outright, because the one scenario worth
 * engineering against is somebody starting this on a real host "just to look".
 */
export function createHarness(opts: HarnessOptions): Server {
  const host = opts.host ?? "127.0.0.1";
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV;
  if (nodeEnv === "production") {
    throw new HarnessRefused(
      "the operator harness refuses to boot under NODE_ENV=production. It has no auth, no " +
        "session and no CSS, and it is scheduled for deletion — see harness/README.md.",
    );
  }
  if (!LOOPBACK.has(host)) {
    throw new HarnessRefused(
      `the operator harness binds loopback only; refused host ${JSON.stringify(host)}. ` +
        "The bind address IS the access control here.",
    );
  }

  const pool = new pg.Pool({ connectionString: opts.databaseUrl });
  pool.on("error", (err) => console.error("[harness] pool error:", err));

  return createServer((req, res) => {
    void (async () => {
      try {
        const rows = await loadTouches(pool);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<h1>Follow-up loop — DISPOSABLE harness</h1>\n` +
            rows.map(renderTouch).join("\n<hr>\n"),
        );
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(String(err));
      }
      void req;
    })();
  });
}

export async function loadTouches(db: pg.Pool): Promise<TouchView[]> {
  const t = await db.query<{
    id: string;
    display_name: string | null;
    disposition: string | null;
    identity_unverified: boolean;
    summary: string | null;
    summary_state: "generated" | "failed" | null;
    transcript_email_sent_at: Date | null;
    transcript_delivery: "pending" | "sent" | "failed" | null;
  }>(
    `select t.id, c.display_name, t.disposition, t.identity_unverified, t.summary,
            t.summary_state, t.transcript_email_sent_at, t.transcript_delivery
       from crm.touches t join crm.contacts c on c.id = t.contact_id
      order by t.occurred_at desc limit 50`,
  );
  const out: TouchView[] = [];
  for (const row of t.rows) {
    const a = await db.query<{ prompt_text: string; value: string }>(
      `select q.prompt_text, a.value from crm.answers a
         join crm.questions q on q.id = a.question_id
        where a.touch_id = $1 order by a.at`,
      [row.id],
    );
    out.push({
      touchId: row.id,
      displayName: row.display_name,
      disposition: row.disposition,
      identityUnverified: row.identity_unverified,
      summary: row.summary,
      summaryState: row.summary_state,
      transcriptEmailSentAt: row.transcript_email_sent_at,
      transcriptDelivery: row.transcript_delivery,
      answers: a.rows.map((x) => ({ prompt: x.prompt_text, value: x.value })),
    });
  }
  return out;
}

if (process.argv[1]?.endsWith("server.ts")) {
  const url = process.env.DATABASE_URL;
  if (url === undefined) throw new Error("DATABASE_URL is required");
  createHarness({ databaseUrl: url }).listen(8791, "127.0.0.1", () => {
    console.log("[harness] http://127.0.0.1:8791 — DISPOSABLE, see harness/README.md");
  });
}
