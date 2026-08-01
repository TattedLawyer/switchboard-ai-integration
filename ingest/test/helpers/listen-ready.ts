import type { Server } from "node:http";
import type express from "express";

// F-1b rider (register: stripefeed CLI flake, 2026-08-01 sighting): `app.listen(0)`
// hands back a bound port, but under full-suite load the first fetch against it can
// still die (`fetch failed`, no assertion reached) — a boot race that failed a green
// run with an infrastructure error. This helper converts that race into either a
// ready mock or a LOUD, named failure: after listen, it probes with a bounded retry
// (any HTTP response, 404 included, proves accept works; only connection-level
// failures retry). Deliberately test-harness-only — the CONNECTOR's no-retry posture
// on connection failure is contract behavior (the service interval is its retry), and
// production code gains nothing from masking boot races that only test harnesses have.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function listenReady(
  app: express.Express,
  opts: { attempts?: number; probePath?: string } = {},
): Promise<{ server: Server; baseUrl: string }> {
  const { attempts = 10, probePath = "/" } = opts;
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await fetch(`${baseUrl}${probePath}`, { signal: AbortSignal.timeout(2000) });
      return { server, baseUrl }; // any response proves the socket accepts
    } catch (err) {
      lastErr = err;
      await sleep(25 * (i + 1));
    }
  }
  server.close();
  throw new Error(
    `mock server never accepted a connection on ${baseUrl} after ${attempts} attempts — ` +
      `boot race exhausted its retry budget (last error: ${(lastErr as Error)?.message})`,
  );
}
