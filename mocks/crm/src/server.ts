import express from "express";
import { createSourceApp, generateManifest, type EventScript } from "@switchboard/mock-core";
import { generateSeed } from "./seed.js";

export function createCrmApp(opts: { webhookUrl: string; ledgerPath: string; seed?: number }): express.Express {
  const { companies, contacts, deals } = generateSeed(opts.seed);
  const { mergePairs } = generateManifest(opts.seed ?? 42).crm;

  // Deterministic, index-pure script covering companies, contacts, deals, and merges.
  // Company slots at i % 4 ∈ {0, 3} (two per cycle → all 22 covered by index 43);
  // positions 45–46 (non-company slots) are REPLACED by the two company.merged events,
  // so both merge participants have appeared as company.updated before their merge.
  const script: EventScript = (i) => {
    if (i === 45 || i === 46) {
      const p = mergePairs[i - 45];
      return { event_type: "company.merged", data: { from_id: p.from_id, to_id: p.to_id } };
    }
    const slot = i % 4;
    if (slot === 1) return { event_type: "contact.updated", data: contacts[Math.floor(i / 4) % contacts.length] as unknown as Record<string, unknown> };
    if (slot === 2) return { event_type: "deal.updated", data: deals[Math.floor(i / 4) % deals.length] as unknown as Record<string, unknown> };
    const cIdx = (Math.floor(i / 4) * 2 + (slot === 3 ? 1 : 0)) % companies.length;
    return { event_type: "company.updated", data: companies[cIdx] as unknown as Record<string, unknown> };
  };

  const paginate = <T>(items: T[], req: express.Request) => {
    const page = Math.max(1, Number(req.query.page ?? 1) || 1);
    const per = Math.min(100, Math.max(1, Number(req.query.per_page ?? 10) || 10));
    return { items: items.slice((page - 1) * per, page * per), page, total: items.length };
  };

  return createSourceApp({
    source: "crm",
    webhookUrl: opts.webhookUrl,
    ledgerPath: opts.ledgerPath,
    script,
    extraRoutes: (app) => {
      app.get("/companies", (req, res) => res.json(paginate(companies, req)));
      app.get("/deals", (req, res) => res.json(paginate(deals, req)));
    },
  });
}
