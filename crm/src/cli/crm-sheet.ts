// Operator CLI — link / unlink / status / one-shot adopt for the client's Google Sheet.
// OWNER role, like every operator CLI (016 §I-3): link and unlink write `crm.linked_sheets`
// and `crm.contacts`, which `switchboard_crm` correctly cannot.
//
// The linking UI is out of scope by owner decision; this is the operator's hands until it
// exists. Swap = `unlink` then `link` — one linked sheet at a time is enforced by
// `linked_sheets_one_active`, so linking over a live link refuses with 23505.
//
// Usage:
//   node --import tsx src/cli/crm-sheet.ts link   <tenantId> <spreadsheetId> [label]
//   node --import tsx src/cli/crm-sheet.ts unlink <tenantId>
//   node --import tsx src/cli/crm-sheet.ts status <tenantId>
//   node --import tsx src/cli/crm-sheet.ts adopt  <tenantId>
import { getOwnerPool } from "../db.js";
import {
  linkSheet,
  unlinkSheet,
  runSheetAdoptionAll,
  sheetHealth,
  sheetHealthLines,
} from "../sheet-adopt.js";
import { sheetTransportFromEnv, SHEETS_KEY_FILE_ENV } from "../sheet-client.js";

async function main(): Promise<void> {
  const [cmd, tenantId, ...rest] = process.argv.slice(2);
  if (!cmd || !tenantId) {
    console.error("usage: crm-sheet <link|unlink|status|adopt> <tenantId> [args]");
    process.exit(2);
  }
  const pool = getOwnerPool();
  try {
    switch (cmd) {
      case "link": {
        const [spreadsheetId, label] = rest;
        if (!spreadsheetId) throw new Error("link requires a spreadsheetId");
        const r = await linkSheet(pool, tenantId, spreadsheetId, label ?? null);
        console.log(
          r.relinked
            ? `relinked ${spreadsheetId} — SAME linked_sheets row ${r.linkedSheetId}; ` +
                `existing contacts keep their identity, the next adoption pass reactivates them`
            : `linked ${spreadsheetId} as ${r.linkedSheetId}; the next adoption pass imports it`,
        );
        break;
      }
      case "unlink": {
        const r = await unlinkSheet(pool, tenantId);
        console.log(
          `unlinked ${r.linkedSheetId}: ${r.contactsDeactivated} contact(s) deactivated ` +
            `(clocks killed), ${r.followUpsClosed} open follow-up(s) closed — blocked ones included`,
        );
        break;
      }
      case "status": {
        const health = await sheetHealth(pool, tenantId);
        if (health.length === 0) console.log("no linked sheet");
        for (const h of health) for (const l of sheetHealthLines(h)) console.log(l);
        break;
      }
      case "adopt": {
        const transport = sheetTransportFromEnv();
        if (transport === null) {
          throw new Error(`${SHEETS_KEY_FILE_ENV} is not set — cannot reach the sheet`);
        }
        for (const r of await runSheetAdoptionAll(pool, transport)) {
          console.log(`${r.spreadsheetId}: ${r.detail}`);
          for (const e of r.rowErrors) console.error(`  row ${e.rowIndex}: ${e.error}`);
        }
        break;
      }
      default:
        throw new Error(`unknown command: ${cmd}`);
    }
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error("crm-sheet failed:", err instanceof Error ? err.message : err);
    await pool.end();
    process.exit(1);
  }
}

main();
