import type { Server } from "node:http";

/** An express app, or anything else with node's `listen` overloads. */
interface Listenable {
  listen(port: number, host: string, listeningListener?: () => void): Server;
}

/**
 * Bind an ephemeral port on LOOPBACK ONLY, and resolve once the address is readable.
 *
 * Cold review I2 (reproduced live, not theorised): `app.listen(0)` with no host binds the
 * WILDCARD address. Node sets `SO_REUSEADDR`, so when another process already holds
 * `127.0.0.1:<that ephemeral port>` — a published container port is the everyday case on a
 * developer machine — the wildcard bind still SUCCEEDS, while the test's own
 * `fetch("http://127.0.0.1:<port>/…")` is routed to the MORE SPECIFIC loopback bind. The
 * test then talks to a stranger. The sighting: a full-suite run red in
 * `door-visibility.test.ts` with `HTTPParserError … 'SSH-2.0-OpenSSH_9.6p1'` — our HTTP
 * client parsing someone else's SSH banner. Binding loopback explicitly turns that
 * collision into a loud `EADDRINUSE`.
 *
 * WHY A HELPER RATHER THAN `app.listen(0, "127.0.0.1")` AT EACH SITE: passing a host makes
 * the bind ASYNCHRONOUS — node runs the address through `dns.lookup` first — so
 * `server.address()` is `null` on the next line, where every one of these call sites reads
 * the port. Swapping the argument in place silently breaks that read (`Cannot read
 * properties of null`). Awaiting `listening` is the whole difference, so it lives in one
 * place instead of being re-derived correctly-or-not at a hundred call sites.
 */
export function listenLoopback(app: Listenable): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server);
    });
    server.once("error", reject);
  });
}

/** `listenLoopback` plus the port, for the common `const { server, port } = …` read. */
export async function listenLoopbackPort(app: Listenable): Promise<{ server: Server; port: number }> {
  const server = await listenLoopback(app);
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("listenLoopback: server bound to a non-TCP address — expected an ephemeral TCP port");
  }
  return { server, port: addr.port };
}
