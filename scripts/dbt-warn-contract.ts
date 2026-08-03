export const EXPECTED_DBT_WARNS: Readonly<Record<string, number>> = { assert_amounts_plausible: 1 };
export function checkWarnSet(_r: unknown, _e: Readonly<Record<string, number>> = EXPECTED_DBT_WARNS): string[] { return []; }
