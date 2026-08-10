// Operator CLI — add a number to a contact. Owner role, same idiom as crm-contact-add.
//
// Usage:
//   node --import tsx src/cli/crm-number-add.ts --contact <uuid> --number "0917-123-4567" \
//        [--label "office"] [--region PH]
//
// A number that cannot be read is REFUSED with a message she can act on, because a stored
// number nobody can dial is a silent loss with a row attached. A number already on this
// contact in another format is a NO-OP that says so — and keeps the first form she typed.
import { getOwnerPool } from "../db.js";
import { addNumber, isAddNumberError } from "../intake.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

async function main(): Promise<void> {
  const pool = getOwnerPool();
  try {
    const contact = arg("contact");
    const number = arg("number");
    if (!contact || !number) {
      console.error("--contact <uuid> and --number <text> are both required");
      await pool.end();
      process.exit(1);
    }
    const r = await addNumber(pool, contact, number, {
      label: arg("label") ?? null,
      region: arg("region"),
    });
    if (isAddNumberError(r)) {
      console.error(r.error);
      await pool.end();
      process.exit(1);
    }
    if (r.alreadyPresent) {
      console.log(
        `already on this contact as ${r.e164} (entered as "${r.phoneRaw}") — nothing added. ` +
          `The same line in two formats is one number, and dial order stays as you set it.`,
      );
    } else {
      console.log(`added ${r.e164} at dial position ${r.ordinal}`);
    }
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error("crm-number-add failed:", err);
    await pool.end();
    process.exit(1);
  }
}

main();
