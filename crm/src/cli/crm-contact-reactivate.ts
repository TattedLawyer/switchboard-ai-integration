// Operator CLI — revisit a passed-on lead. Owner role (015:493-495 idiom).
//
// The close pass sets `next_due_at = NULL` on a rejected contact (the "stop and surface"
// marker), and NULL is never claimed. This re-arms an EXISTING contact so it is due again.
//
// 🚨 RE-ADDING THE CONTACT DOES NOT WORK — `crm-contact-add` INSERTs a NEW contact (new id,
// its own history, rotation and answers), orphaning the original. This CLI updates the
// existing row in place, which is the only correct revisit.
//
// Usage: node --import tsx src/cli/crm-contact-reactivate.ts --contact <uuid>
import { getOwnerPool } from "../db.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

async function main(): Promise<void> {
  const pool = getOwnerPool();
  try {
    const contact = arg("contact");
    if (!contact) {
      console.error("--contact <uuid> is required");
      await pool.end();
      process.exit(1);
    }
    // `active = true` too, so this also revives a stood-down contact if a deactivate path is
    // ever added; harmless on an already-active one.
    const r = await pool.query<{ id: string; display_name: string | null }>(
      `update crm.contacts set next_due_at = now(), active = true, updated_at = now()
        where id = $1 returning id, display_name`,
      [contact],
    );
    if (r.rowCount !== 1) {
      console.error(`no such contact: ${contact}`);
      await pool.end();
      process.exit(1);
    }
    console.log(
      `reactivated ${r.rows[0].id} (${r.rows[0].display_name ?? "no name on file"}) — due now; ` +
        `the next cycle will propose for it again.`,
    );
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error("crm-contact-reactivate failed:", err);
    await pool.end();
    process.exit(1);
  }
}

main();
