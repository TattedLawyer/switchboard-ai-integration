import express from "express";
import { createSourceApp, generateManifest, type EventScript } from "@switchboard/mock-core";

export function createBillingApp(opts: { webhookUrl: string; ledgerPath: string; seed?: number }): express.Express {
  const { customers, invoices } = generateManifest(opts.seed ?? 42).billing;
  // 5-slot cycle: customer.created, invoice.created, payment.succeeded, invoice.paid,
  // then alternating payment.failed / invoice.voided. All 16 customers covered by index 79.
  const script: EventScript = (i) => {
    const n = Math.floor(i / 5);
    const slot = i % 5;
    const inv = invoices[n % invoices.length];
    switch (slot) {
      case 0: return { event_type: "customer.created", data: customers[n % customers.length] as unknown as Record<string, unknown> };
      case 1: return { event_type: "invoice.created", data: { ...inv } };
      case 2: return { event_type: "payment.succeeded", data: { id: `DEMO-PAY-${String(n * 2 + 1).padStart(4, "0")}`, invoice_id: inv.id, customer_id: inv.customer_id, amount_cents: inv.amount_cents } };
      case 3: return { event_type: "invoice.paid", data: { ...inv } };
      default:
        return n % 2 === 0
          ? { event_type: "payment.failed", data: { id: `DEMO-PAY-${String(n * 2 + 2).padStart(4, "0")}`, invoice_id: inv.id, customer_id: inv.customer_id, amount_cents: inv.amount_cents } }
          : { event_type: "invoice.voided", data: { ...inv } };
    }
  };
  return createSourceApp({
    source: "billing", webhookUrl: opts.webhookUrl, ledgerPath: opts.ledgerPath, script,
    extraRoutes: (app) => {
      app.get("/customers", (_req, res) => res.json({ items: customers, total: customers.length }));
    },
  });
}
