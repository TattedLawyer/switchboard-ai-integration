#!/usr/bin/env bash
set -euo pipefail
f="out/monday-report.md"
[[ -s "$f" ]] || { echo "FAIL: $f missing or empty"; exit 1; }
grep -q "DEMO-C-" "$f" || { echo "FAIL: no DEMO-C- company ids in report"; exit 1; }
grep -q "# Monday Revenue-Risk Report" "$f" || { echo "FAIL: missing report header"; exit 1; }
echo "PASS: end-to-end demo produced a valid report"
