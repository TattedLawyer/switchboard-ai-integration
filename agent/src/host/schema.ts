// process.env.DBT_SCHEMA is not user input (it's operator-controlled config), but it is
// interpolated unquoted into SQL identifier position in mcp/server.ts and host/report.ts,
// so validate it strictly rather than trust it — cheap insurance against a misconfigured
// or compromised environment turning into SQL injection.
const VALID_SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

export function readDbtSchema(): string {
  const schema = process.env.DBT_SCHEMA ?? "public_analytics";
  if (!VALID_SCHEMA_RE.test(schema)) {
    throw new Error(
      `invalid DBT_SCHEMA "${schema}": must match ${VALID_SCHEMA_RE} (lowercase identifier)`,
    );
  }
  return schema;
}
