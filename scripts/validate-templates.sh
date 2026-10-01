#!/bin/bash
# =============================================================================
# Validate tat ca template OpenClaw bang schema cua ban `openclaw` dang cai.
# Quet: config/*.json + moi heredoc CONFIGEOF trong install.sh.
#
# Chay tren VPS (can `openclaw`), truoc khi merge hoac sau khi OpenClaw len ban moi:
#   bash scripts/validate-templates.sh [repo_dir]
# =============================================================================
set -uo pipefail

REPO=${1:-$(cd "$(dirname "$0")/.." && pwd)}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cp "$REPO"/config/*.json "$WORK"/
awk -v d="$WORK" "/<< 'CONFIGEOF'/{n=split(\$3,a,\"/\"); f=d\"/install.sh-\"a[n]; next} /^CONFIGEOF\$/{f=\"\"; next} f{print > f}" "$REPO/install.sh"

total=0; bad=0
for f in "$WORK"/*.json; do
    total=$((total + 1))
    h=$(mktemp -d "$WORK/home.XXXX"); mkdir -p "$h/.openclaw"; cp "$f" "$h/.openclaw/openclaw.json"
    # Placeholder ${VAR} trong template -> gia tri gia
    env_args=$(grep -oE '\$\{[A-Z0-9_]+\}' "$f" | sort -u | sed -E 's/\$\{([A-Z0-9_]+)\}/\1=dummy/' | tr '\n' ' ')
    if ! out=$(env HOME="$h" $env_args timeout 60 openclaw config validate 2>&1); then
        bad=$((bad + 1))
        echo "FAIL $(basename "$f"): $(echo "$out" | grep -E 'Unrecognized|retired|invalid|Error' | head -2 | tr '\n' ' ')"
    fi
done

echo "$(openclaw --version 2>/dev/null): templates=$total fail=$bad"
[ "$bad" -eq 0 ]
