#!/usr/bin/env bash
# Egy adott, kijelölt edge-agent kiadást telepít erre a node-ra — ez a
# "staged, reversible" frissítés-mechanizmus, amit a ROADMAP M8 elvár.
# EZ NEM kriptográfiai aláírás (lásd docs/SECURITY_REVIEW.md, miért
# tudatos döntés ezt egyelőre elhalasztani) — ez git tag-alapú
# verziózás, dokumentált, szkriptelhető visszavonási úttal, ami a
# "staged és reversible" tényleges tartalma.
#
# Használat:
#   scripts/deploy-edge-agent.sh <tag>       # egy konkrét tag telepítése
#   scripts/deploy-edge-agent.sh --latest    # a legújabb edge-agent-* tag telepítése
#   scripts/deploy-edge-agent.sh --rollback  # visszaállás az eggyel korábbi tag-re

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SERVICES=(mes-edge-agent mes-edge-agent-modbus mes-edge-agent-opcua)

git fetch --tags origin

current_tag() {
  git describe --tags --match 'edge-agent-*' --exact-match 2>/dev/null || echo "(nincs — nem egy tag-elt commit-on állunk)"
}

list_tags() {
  git tag -l 'edge-agent-*' --sort=-creatordate
}

case "${1:-}" in
  --latest)
    TARGET_TAG="$(list_tags | head -n1)"
    ;;
  --rollback)
    CURRENT="$(git describe --tags --match 'edge-agent-*' --exact-match 2>/dev/null || true)"
    if [ -z "$CURRENT" ]; then
      echo "Jelenleg nem egy tag-elt kiadáson állunk — nem lehet megállapítani, mihez képest kellene visszaállni." >&2
      exit 1
    fi
    TARGET_TAG="$(list_tags | grep -A1 -F "$CURRENT" | tail -n1)"
    if [ "$TARGET_TAG" = "$CURRENT" ]; then
      echo "Nincs $CURRENT-nál korábbi edge-agent-* tag." >&2
      exit 1
    fi
    echo "Visszaállás: $CURRENT → $TARGET_TAG"
    ;;
  "")
    echo "Használat: $0 <tag> | --latest | --rollback" >&2
    echo "" >&2
    echo "Jelenleg telepítve: $(current_tag)" >&2
    echo "" >&2
    echo "Elérhető tag-ek (legújabb elöl):" >&2
    list_tags | sed 's/^/  /' >&2
    exit 1
    ;;
  *)
    TARGET_TAG="$1"
    ;;
esac

if ! git rev-parse "$TARGET_TAG" >/dev/null 2>&1; then
  echo "'$TARGET_TAG' tag nem található. Elérhető tag-ek:" >&2
  list_tags | sed 's/^/  /' >&2
  exit 1
fi

echo "Telepítés: $TARGET_TAG (jelenleg: $(current_tag))"
git checkout "$TARGET_TAG"

echo "Fordítás (edge-agent)..."
(cd packages/edge-agent && pnpm run build)

echo "Edge agent szolgáltatások újraindítása..."
for svc in "${SERVICES[@]}"; do
  if systemctl list-units --full -all | grep -q "^${svc}\.service"; then
    systemctl restart "$svc"
    echo "  újraindítva: $svc"
  fi
done

echo ""
echo "$TARGET_TAG telepítve. Ellenőrizd a dashboardon, hogy minden gép rendesen jelentkezik-e, mielőtt lezártnak tekinted."
echo "Ha valami rossznak tűnik, vond vissza ezzel: $0 --rollback"