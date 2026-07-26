import express from "express";
import { createSourceApp, generateManifest, type EventScript } from "@switchboard/mock-core";

export function createSupportApp(opts: { webhookUrl: string; ledgerPath: string; seed?: number }): express.Express {
  const { requesters, tickets } = generateManifest(opts.seed ?? 42).support;
  const byId = new Map(requesters.map((r) => [r.id, r]));
  // 4-slot cycle: ticket.created, ticket.updated, ticket.solved, csat.recorded.
  // All 14 requesters covered by the first 14 tickets (index 55).
  const script: EventScript = (i) => {
    const n = Math.floor(i / 4);
    const t = tickets[n % tickets.length];
    const r = byId.get(t.requester_id)!;
    const ticketData = { ...t, requester_email: r.email, requester_name: r.name, company_name: r.company_name, domain: r.domain } as unknown as Record<string, unknown>;
    switch (i % 4) {
      case 0: return { event_type: "ticket.created", data: ticketData };
      case 1: return { event_type: "ticket.updated", data: ticketData };
      case 2: return { event_type: "ticket.solved", data: ticketData };
      default: return { event_type: "csat.recorded", data: { id: `DEMO-CS-${String(n + 1).padStart(4, "0")}`, ticket_id: t.id, score: (n % 5) + 1 } };
    }
  };
  return createSourceApp({
    source: "support", webhookUrl: opts.webhookUrl, ledgerPath: opts.ledgerPath, script,
    extraRoutes: (app) => {
      app.get("/requesters", (_req, res) => res.json({ items: requesters, total: requesters.length }));
    },
  });
}
