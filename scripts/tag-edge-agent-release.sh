#!/usr/bin/env bash
# Egy új, hivatalos edge-agent kiadást jelöl ki (git tag) az aktuális
# commit-on. Akkor futtasd, amikor egy packages/edge-agent-et (vagy a
# Python bridge-szkripteket) érintő változtatást leteszteltél, és készen
# áll a telepítésre.
#
# Használat: scripts/tag-edge-agent-release.sh "rövid leírás a változásról"

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DESCRIPTION="${1:-}"
if [ -z "$DESCRIPTION" ]; then
  echo "Használat: $0 \"rövid leírás a változásról\"" >&2
  exit 1
fi

git fetch --tags origin

LAST_NUM=$(git tag -l 'edge-agent-v*' | sed 's/edge-agent-v//' | sort -n | tail -n1)
NEXT_NUM=$(( ${LAST_NUM:-0} + 1 ))
NEW_TAG="edge-agent-v${NEXT_NUM}"

git tag -a "$NEW_TAG" -m "$DESCRIPTION"
git push origin "$NEW_TAG"

echo "Kijelölve és feltöltve: $NEW_TAG — $DESCRIPTION"
echo "Telepítsd ezzel: scripts/deploy-edge-agent.sh $NEW_TAG"