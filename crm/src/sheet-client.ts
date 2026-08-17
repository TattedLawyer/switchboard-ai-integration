// The Google Sheets transport — service-account JWT auth and the two calls the sheet
// foundation needs, verified against the LIVE API (spike, 2026-08-17; the measured facts
// are recorded in migration 021's header).
//
// 🚨 NO DEPENDENCIES. Node built-ins only (`node:crypto` for RS256, global `fetch`).
// The googleapis client is ~30MB of surface for two endpoints; the spike proved the raw
// calls against a real sheet, so that is what ships.
//
// 🚨 CREDENTIALS ARE A FILE PATH, NEVER INLINE JSON. `SHEETS_SERVICE_ACCOUNT_KEY_FILE`
// names the key file on disk (mode 600, outside the repo). The key material is read at
// construction and held in memory only; nothing here logs it, returns it, or writes it —
// with one caveat stated because it is true: a MALFORMED key file makes `JSON.parse` throw
// a SyntaxError that quotes a few characters of the file's text in its message.
// When the variable is unset the transport DEGRADES OFF: `sheetTransportFromEnv` returns
// null and the caller must say so loudly — a silently-absent sheet integration is the
// silence-failure class this repo names as its worst.
//
// 🚨 DOCUMENT VISIBILITY on every ref write. Project-scoped metadata becomes invisible if
// the Cloud project ever changes, which the adoption pass would read as "she deleted every
// row". Measured ground: DOCUMENT-visibility metadata survives sorts and travels with its
// row; a duplicated tab carries values but no metadata.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

export const SHEETS_KEY_FILE_ENV = "SHEETS_SERVICE_ACCOUNT_KEY_FILE";

/** The developer-metadata key under which a row's ref lives. One constant, shared by the
 *  writer (here) and the reader (`readSnapshot`) — two spellings would be two identities. */
export const ROW_REF_METADATA_KEY = "switchboard.row_ref";

/** An HTTP failure from the Sheets API, after retries. `status` is what the health
 *  classifier keys on: 403/404 mean the service account lost access (Google answers 404
 *  for "exists but not shared with you"), everything else is unreachability. */
export class SheetApiError extends Error {
  constructor(
    public readonly status: number,
    body: string,
  ) {
    super(`sheets api ${status}: ${body.slice(0, 300)}`);
    this.name = "SheetApiError";
  }
}

export interface SheetRow {
  /** 0-based row index within the tab, header row included (index 0). */
  rowIndex: number;
  /** The DOCUMENT-visibility ref travelling with this row, or null when never minted. */
  ref: string | null;
  /** Rendered cell values, left to right. Trailing empty cells may be absent. */
  cells: string[];
}

export interface SheetTab {
  sheetId: number;
  title: string;
  rows: SheetRow[];
}

export interface SheetSnapshot {
  spreadsheetId: string;
  tabs: SheetTab[];
}

export interface RefWrite {
  sheetId: number;
  rowIndex: number;
  ref: string;
}

export interface SheetTransport {
  /** Whose access she must re-share when it is revoked — named in health surfaces. */
  serviceAccountEmail: string;
  /** ONE request: grid values AND row developer metadata (measured ground). */
  readSnapshot(spreadsheetId: string): Promise<SheetSnapshot>;
  /** Mint refs onto rows via batchUpdate createDeveloperMetadata, DOCUMENT visibility. */
  writeRowRefs(spreadsheetId: string, writes: readonly RefWrite[]): Promise<void>;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

/** values + row metadata in one request; nothing else crosses the wire. */
const SNAPSHOT_FIELDS =
  "sheets(properties(sheetId,title,index)," +
  "data(startRow,rowData(values(formattedValue))," +
  "rowMetadata(developerMetadata(metadataKey,metadataValue,visibility))))";

/** Bounded exponential backoff on 429/5xx — the two classes Google documents as
 *  retryable. Everything else throws immediately: a 403 retried is a 403 delayed. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 8_000;

/** Every fetch carries `AbortSignal.timeout` — a hung read used to block NOTHING while the
 *  scheduler fired the next tick regardless, which is exactly how adoption passes came to
 *  overlap. The signal also bounds the body read, so a stalled response cannot wedge a
 *  pass past the per-sheet advisory lock's usefulness. */
const FETCH_TIMEOUT_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const b64url = (o: unknown): string =>
  Buffer.from(JSON.stringify(o)).toString("base64url");

export class SheetClient implements SheetTransport {
  readonly serviceAccountEmail: string;
  private readonly key: ServiceAccountKey;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(keyFilePath: string) {
    // Throws loudly on a missing/garbled file — a transport that half-exists is worse
    // than one that refuses at construction. (A garbled file's JSON.parse error quotes a
    // few characters of the file's text — the header's stated caveat.)
    const parsed = JSON.parse(readFileSync(keyFilePath, "utf8")) as Partial<ServiceAccountKey>;
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error(
        `${keyFilePath} is not a service-account key file (client_email/private_key missing). ` +
          `Nothing from the file is echoed by this message on purpose.`,
      );
    }
    this.key = { client_email: parsed.client_email, private_key: parsed.private_key };
    this.serviceAccountEmail = parsed.client_email;
  }

  /** RS256 self-signed JWT → access token, cached until 60s before expiry. */
  private async accessToken(): Promise<string> {
    const nowS = Math.floor(Date.now() / 1000);
    if (this.token && this.token.expiresAt - 60 > nowS) return this.token.value;
    const claim = {
      iss: this.key.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: nowS,
      exp: nowS + 3600,
    };
    const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claim)}`;
    const sig = createSign("RSA-SHA256").update(unsigned).sign(this.key.private_key, "base64url");
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${sig}`,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!res.ok || !body.access_token) {
      throw new SheetApiError(res.status, "token exchange failed (key body not echoed)");
    }
    this.token = { value: body.access_token, expiresAt: nowS + (body.expires_in ?? 3600) };
    return this.token.value;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    let lastStatus = 0;
    let lastBody = "";
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
        await sleep(backoff + Math.floor(Math.random() * 100));
      }
      const token = await this.accessToken();
      let res: Response;
      try {
        res = await fetch(`${API_BASE}/${path}`, {
          ...init,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...(init.headers ?? {}),
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        // Network-level failure (DNS, refused, reset): retryable, bounded by the loop.
        lastStatus = 0;
        lastBody = err instanceof Error ? err.message : String(err);
        continue;
      }
      const text = await res.text();
      if (res.ok) return text === "" ? null : (JSON.parse(text) as unknown);
      lastStatus = res.status;
      lastBody = text;
      if (!RETRYABLE.has(res.status)) break; // 403/404/400: retrying cannot help
    }
    throw new SheetApiError(lastStatus, lastBody);
  }

  async readSnapshot(spreadsheetId: string): Promise<SheetSnapshot> {
    const raw = (await this.request(
      `${encodeURIComponent(spreadsheetId)}?includeGridData=true&fields=${encodeURIComponent(SNAPSHOT_FIELDS)}`,
    )) as {
      sheets?: Array<{
        properties?: { sheetId?: number; title?: string; index?: number };
        data?: Array<{
          startRow?: number;
          rowData?: Array<{ values?: Array<{ formattedValue?: string }> }>;
          rowMetadata?: Array<{
            developerMetadata?: Array<{ metadataKey?: string; metadataValue?: string }>;
          }>;
        }>;
      }>;
    };

    const tabs: SheetTab[] = [];
    for (const sheet of raw.sheets ?? []) {
      const rowsByIndex = new Map<number, SheetRow>();
      for (const grid of sheet.data ?? []) {
        const start = grid.startRow ?? 0;
        const rowData = grid.rowData ?? [];
        const rowMeta = grid.rowMetadata ?? [];
        const n = Math.max(rowData.length, rowMeta.length);
        for (let i = 0; i < n; i++) {
          const rowIndex = start + i;
          const cells = (rowData[i]?.values ?? []).map((v) => v.formattedValue ?? "");
          const ref =
            rowMeta[i]?.developerMetadata?.find((m) => m.metadataKey === ROW_REF_METADATA_KEY)
              ?.metadataValue ?? null;
          rowsByIndex.set(rowIndex, { rowIndex, ref, cells });
        }
      }
      tabs.push({
        sheetId: sheet.properties?.sheetId ?? 0,
        title: sheet.properties?.title ?? "",
        rows: [...rowsByIndex.values()].sort((a, b) => a.rowIndex - b.rowIndex),
      });
    }
    return { spreadsheetId, tabs };
  }

  async writeRowRefs(spreadsheetId: string, writes: readonly RefWrite[]): Promise<void> {
    if (writes.length === 0) return;
    await this.request(`${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: writes.map((w) => ({
          createDeveloperMetadata: {
            developerMetadata: {
              metadataKey: ROW_REF_METADATA_KEY,
              metadataValue: w.ref,
              location: {
                dimensionRange: {
                  sheetId: w.sheetId,
                  dimension: "ROWS",
                  startIndex: w.rowIndex,
                  endIndex: w.rowIndex + 1,
                },
              },
              // 🚨 DOCUMENT, never PROJECT — see the header.
              visibility: "DOCUMENT",
            },
          },
        })),
      }),
    });
  }
}

/**
 * The boot seam. Null means "not configured": the caller MUST log that loudly and run
 * with the sheet integration OFF — never throw the daemon down, never pretend the sheet
 * was read. A set-but-unreadable key file throws here, at boot, where it is fixable.
 */
export function sheetTransportFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SheetTransport | null {
  const path = env[SHEETS_KEY_FILE_ENV];
  if (path === undefined || path === "") return null;
  return new SheetClient(path);
}
