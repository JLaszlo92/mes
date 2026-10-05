#!/usr/bin/env bash
# Generates the dependency evidence for a release: a CycloneDX SBOM, a license
# summary and the audit result. Run from the repo root, ideally right before
# cutting a release. Needs network (npx, license lookups); takes ~5 minutes.
#
#   ops/security/sbom.sh [output-dir]      default: ./sbom-out (git-ignored)
#
# Exit codes: 0 = done, 1 = tool failure, 2 = a disallowed license or a
# vulnerability was found (the files are still written).
set -euo pipefail

OUT="${1:-sbom-out}"
CDXGEN="${CDXGEN:-npx --yes @cyclonedx/cdxgen@latest}"
mkdir -p "$OUT"

[[ -f pnpm-lock.yaml ]] || { echo "Run this from the repo root (pnpm-lock.yaml not found)" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
[[ $(id -u) -eq 0 ]] && echo "Note: running as root; cdxgen will warn about it. Prefer a normal user." >&2

echo "== SBOM"
$CDXGEN -t js --profile license-compliance -o "$OUT/sbom.cdx.json" . >"$OUT/cdxgen.log" 2>&1 \
  || { echo "cdxgen failed, see $OUT/cdxgen.log" >&2; exit 1; }
[[ -s $OUT/sbom.cdx.json ]] || { echo "SBOM is empty" >&2; exit 1; }

# Reviewed manually: the SBOM tool cannot classify these. Add a line per review
# (name, license, why). Re-check when the package version changes.
OVERRIDES='{
  "victory-vendor": "MIT AND ISC (package.json license field, reviewed 2026-10-05; bundled by recharts)",
  "caniuse-lite": "CC-BY-4.0 (browser data used by build tools only, not shipped; reviewed 2026-10-05)"
}'

echo "== license summary"
jq -r --argjson ov "$OVERRIDES" '
  def lic: (.licenses[0].license.id // .licenses[0].license.name // "UNKNOWN");
  [.components[] | {name, version, license: lic}] as $c
  | "components: \($c | length)",
    "",
    ($c | group_by(.license) | map({license: .[0].license, n: length}) | sort_by(-.n)[] | "\(.n)\t\(.license)"),
    "",
    "needs attention (unknown or copyleft, not in the reviewed list):",
    ($c[] | select(.license | test("UNKNOWN|GPL|AGPL|SSPL|UNLICENSED")) | select($ov[.name] | not) | "  \(.name)@\(.version)\t\(.license)"),
    "",
    "reviewed by hand:",
    ($c[] | select($ov[.name]) | "  \(.name)@\(.version)\t\($ov[.name])")
' "$OUT/sbom.cdx.json" | tee "$OUT/licenses.txt"

BAD=$(jq -r --argjson ov "$OVERRIDES" '
  [.components[] | {name, license: (.licenses[0].license.id // .licenses[0].license.name // "UNKNOWN")}
   | select(.license | test("UNKNOWN|GPL|AGPL|SSPL|UNLICENSED")) | select($ov[.name] | not)] | length' "$OUT/sbom.cdx.json")

echo "== audit"
set +e
pnpm audit --prod >"$OUT/audit.txt" 2>&1
AUDIT=$?
set -e
tail -n 3 "$OUT/audit.txt"

echo "== files in $OUT: sbom.cdx.json licenses.txt audit.txt"
if [[ $BAD -gt 0 || $AUDIT -ne 0 ]]; then
  echo "ATTENTION: $BAD license(s) to review, audit exit code $AUDIT" >&2
  exit 2
fi
