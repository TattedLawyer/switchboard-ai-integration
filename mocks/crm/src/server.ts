import express from "express";
import { createSourceApp, type EventScript } from "@switchboard/mock-core";
import { generateSeed } from "./seed.js";

export function createCrmApp(opts: { webhookUrl: string; ledgerPath: string; seed?: number }): express.Express {
  const { companies, deals } = generateSeed(opts.seed);

  // Phase 1 behavior preserved exactly: alternate company.updated / deal.updated.
  const script: EventScript = (i) => {
    const useCompany = i % 2 === 0;
    const entityIdx = Math.floor(i / 2);
    return {
      event_type: useCompany ? "company.updated" : "deal.updated",
      data: (useCompany
        ? companies[entityIdx % companies.length]
        : deals[entityIdx % deals.length]) as unknown as Record<string, unknown>,
    };
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
