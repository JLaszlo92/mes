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

# mes-edge-node az éles egység; a mes-edge-agent* a régi, egygépes mód (kikapcsolva
# tartjuk őket - lásd lent: csak AKTÍV egységet indítunk újra).
SERVICES=(mes-edge-node mes-edge-agent mes-edge-agent-modbus mes-edge-agent-opcua)

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

echo "Függőségek és fordítás (shared, edge-agent)..."
pnpm install --frozen-lockfile
pnpm --filter @mes/shared build
pnpm --filter @mes/edge-agent build

echo "Edge agent szolgáltatások újraindítása..."
RESTARTED_NODE=0
NODE_SINCE=""
for svc in "${SERVICES[@]}"; do
  # Csak a most FUTÓ egységet indítjuk újra: egy szándékosan kikapcsolt régi
  # egység újraindítása duplán publikálná a gépek eseményeit.
  if systemctl is-active --quiet "$svc"; then
    if [ "$svc" = "mes-edge-node" ]; then
      RESTARTED_NODE=1
      NODE_SINCE="$(date '+%Y-%m-%d %H:%M:%S')"
    fi
    systemctl restart "$svc"
    echo "  újraindítva: $svc"
  elif systemctl cat "$svc" >/dev/null 2>&1; then
    echo "  kihagyva (nem fut): $svc"
  fi
done

if [ "$RESTARTED_NODE" = "1" ]; then
  echo "Várakozás az edge node jelentkezésére..."
  OK=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    sleep 5
    if journalctl -u mes-edge-node --since "$NODE_SINCE" --no-pager 2>/dev/null | grep -q "claimed edge node"; then OK=1; break; fi
  done
  if [ "$OK" = "1" ]; then
    echo "  mes-edge-node jelentkezett (claimed edge node)."
  else
    echo "FIGYELEM: 60 mp alatt nem látszik 'claimed edge node' a naplóban: journalctl -u mes-edge-node -n 50" >&2
  fi
fi

echo ""
echo "$TARGET_TAG telepítve. Ellenőrizd a dashboardon, hogy minden gép rendesen jelentkezik-e, mielőtt lezártnak tekinted."
echo "Ha valami rossznak tűnik, vond vissza ezzel: $0 --rollback"