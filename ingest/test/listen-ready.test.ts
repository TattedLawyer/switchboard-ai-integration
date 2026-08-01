import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import express from "express";
import { listenReady } from "./helpers/listen-ready.js";

// Both directions of the F-1b harness rider, deterministically (the live flake was a
// load race; these pins exercise the helper's contract, not the weather):
//   · healthy mock → ready, even when the app answers 404 (any response = accepting);
//   · a server that never accepts → the retry budget exhausts into a LOUD, named
//     failure instead of a bare `fetch failed` mid-assertion.

describe("listenReady — the mock-boot race, converted to ready-or-loud", () => {
  it("a healthy app resolves ready; a 404 response counts (accept is what is probed)", async () => {
    const app = express(); // no routes: every probe answers 404
    const { server, baseUrl } = await listenReady(app);
    try {
      expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const res = await fetch(baseUrl + "/");
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("a port that never accepts exhausts the bounded retries and fails BY NAME — never a bare fetch error deep in an assertion", async () => {
    // Deterministic dead port: bind a real server, remember its port, close it, then
    // hand listenReady a stub whose "server" claims that (now-closed) port.
    const holder = createServer();
    await new Promise<void>((r) => holder.listen(0, "127.0.0.1", r));
    const port = (holder.address() as { port: number }).port;
    await new Promise<void>((r) => holder.close(() => r()));

    const deadApp = {
      listen: (): Server =>
        ({
          address: () => ({ port }),
          close: () => undefined,
        }) as unknown as Server,
    } as unknown as express.Express;

    await expect(listenReady(deadApp, { attempts: 3 })).rejects.toThrow(
      /never accepted a connection .* after 3 attempts — boot race exhausted/,
    );
  });
});
