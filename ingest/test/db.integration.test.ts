import { describe, expect, it } from "vitest";
import { getPool } from "../src/db.js";

describe("db connection", () => {
  it("connects to postgres and selects 1", async () => {
    const pool = getPool();
    const res = await pool.query("select 1 as one");
    expect(res.rows[0].one).toBe(1);
    await pool.end();
  });
});
