#!/usr/bin/env bash
# MES telepítés node-dc-n, egy paranccsal (rootként, a repó bármely mappájából):
#
#   ops/deploy.sh /root/valami.patch [/root/masik.patch ...]   patch(ek) + build + felület + újraindítás + push
#   ops/deploy.sh                                              a mostani állapot újra buildelése és telepítése
#   ops/deploy.sh --no-push /root/valami.patch                 push nélkül
#
# Lépések (bármelyik hibájánál megáll, és megmondja, mi a teendő):
#   1. ellenőrzés: root, nincs félbemaradt `git am`, nincs más helyi módosítás
#      (a docs/DEVELOPMENT_STATUS.md helyi változását visszaállítja — azt a patch hozza)
#   2. a patchek alkalmazása (`git am`); ha valamelyik nem megy, mindet visszavonja
#   3. `pnpm install`, ha a függőségek változtak; build
#      — ha a build nem sikerül, a most alkalmazott patcheket visszavonja (a régi verzió fut tovább)
#   4. a felület átmásolása a webrootba (előbb a fájlok, az index.html utoljára, egy lépésben),
#      így a böngésző soha nem kap félkész felületet; a terminálok 2 percen belül maguktól újratöltenek
#   5. a backend újraindítása és megvárása (/health?db=1); a migrációk induláskor futnak
#   6. git push
#
# Beállítható (környezeti változó):
#   MES_WEB_ROOT    default /var/www/mes             (ahonnan az nginx kiszolgálja a felületet)
#   MES_SERVICE     default mes-backend               (systemd unit)
#   MES_HEALTH_URL  default http://127.0.0.1:3001/health?db=1
#   MES_HEALTH_WAIT default 90                        (másodperc)
set -euo pipefail

# A patch magát ezt a fájlt is módosíthatja: a bash futás közben olvassa a szkriptet, ezért egy másolatból fut.
if [ -z "${MES_DEPLOY_REPO:-}" ]; then
  copy="$(mktemp /tmp/mes-deploy.XXXXXX)"
  cp "$0" "$copy"
  MES_DEPLOY_REPO="$(cd "$(dirname "$0")/.." && pwd)" exec bash "$copy" "$@"
fi
trap 'rm -f "$0"' EXIT
SELF="ops/deploy.sh"

WEB_ROOT="${MES_WEB_ROOT:-/var/www/mes}"
SERVICE="${MES_SERVICE:-mes-backend}"
HEALTH_URL="${MES_HEALTH_URL:-http://127.0.0.1:3001/health?db=1}"
HEALTH_WAIT="${MES_HEALTH_WAIT:-90}"
PUSH=1
PATCHES=()

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mHIBA: %s\033[0m\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --no-push) PUSH=0 ;;
    -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
    -*) die "ismeretlen kapcsoló: $arg (lásd: $SELF --help)" ;;
    *) [ -f "$arg" ] || die "nincs ilyen patch fájl: $arg"; PATCHES+=("$(realpath "$arg")") ;;
  esac
done

REPO="$MES_DEPLOY_REPO"
cd "$REPO"

# ---- 1. ellenőrzés ----
say "Ellenőrzés ($REPO)"
[ "$(id -u)" -eq 0 ] || [ -n "${MES_DEPLOY_NOT_ROOT:-}" ] || die "rootként futtasd (a webroot írása és a szolgáltatás újraindítása miatt)."
if [ -d .git/rebase-apply ]; then
  die "félbemaradt 'git am' van a repóban. Nézd meg: git am --show-current-patch; elvetés: git am --abort — utána futtasd újra."
fi
if ! git diff --quiet -- docs/DEVELOPMENT_STATUS.md 2>/dev/null; then
  echo "docs/DEVELOPMENT_STATUS.md helyi változása visszaállítva (a patch hozza a frisset)."
  git checkout -- docs/DEVELOPMENT_STATUS.md
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  git status --short
  die "helyi módosítások vannak a repóban (fent). Mentsd el vagy vond vissza őket (git stash / git checkout -- <fájl>), utána futtasd újra."
fi
OLD_HEAD="$(git rev-parse HEAD)"
echo "Jelenlegi verzió: $(git log -1 --format='%h %s')"

# ---- 2. patchek ----
if [ "${#PATCHES[@]}" -gt 0 ]; then
  say "Patchek alkalmazása (${#PATCHES[@]} db)"
  for p in "${PATCHES[@]}"; do
    echo "- $p"
    if ! git am --3way "$p"; then
      git am --abort >/dev/null 2>&1 || true
      git reset -q --hard "$OLD_HEAD"
      die "a patch nem alkalmazható: $p — semmi nem változott (a repó a korábbi állapotban van)."
    fi
  done
else
  say "Nincs patch: a mostani verzió buildelése és telepítése"
fi
NEW_HEAD="$(git rev-parse HEAD)"

rollback() {
  if [ "$NEW_HEAD" != "$OLD_HEAD" ]; then
    git reset -q --hard "$OLD_HEAD"
    echo "A most alkalmazott patchek visszavonva; a repó a korábbi állapotban van, a futó rendszer nem változott."
  fi
}

# ---- 3. függőségek és build ----
if [ "$NEW_HEAD" != "$OLD_HEAD" ] && ! git diff --quiet "$OLD_HEAD" "$NEW_HEAD" -- pnpm-lock.yaml package.json 'packages/*/package.json'; then
  say "Függőségek változtak: pnpm install"
  pnpm install --frozen-lockfile || { rollback; die "pnpm install nem sikerült."; }
fi
say "Build"
if ! pnpm -r --filter=./packages/* build; then
  rollback
  die "a build nem sikerült (a hiba fent látszik)."
fi
DIST="$REPO/packages/frontend/dist"
[ -f "$DIST/index.html" ] || { rollback; die "nincs $DIST/index.html a build után."; }

# ---- 4. felület ----
say "Felület másolása: $DIST -> $WEB_ROOT"
mkdir -p "$WEB_ROOT"
# Előbb minden más (az új assets fájlok), az index.html utoljára és atomikusan (mv), hogy soha ne mutasson hiányzó fájlra.
find "$DIST" -mindepth 1 -maxdepth 1 ! -name index.html -exec cp -a {} "$WEB_ROOT"/ \;
cp -a "$DIST/index.html" "$WEB_ROOT/.index.html.new"
mv -f "$WEB_ROOT/.index.html.new" "$WEB_ROOT/index.html"
# Régi buildek fájljai: ami 14 napnál régebbi és már nincs a mostani buildben, törölhető.
if [ -d "$WEB_ROOT/assets" ]; then
  removed=0
  while IFS= read -r -d '' f; do
    [ -e "$DIST/assets/$(basename "$f")" ] || { rm -f "$f"; removed=$((removed + 1)); }
  done < <(find "$WEB_ROOT/assets" -maxdepth 1 -type f -mtime +14 -print0)
  [ "$removed" -gt 0 ] && echo "$removed régi fájl törölve a $WEB_ROOT/assets mappából."
fi
echo "Felület: $(grep -o '/assets/index-[^"]*\.js' "$WEB_ROOT/index.html" | head -1)"

# ---- 5. backend ----
if [ -n "${MES_SKIP_RESTART:-}" ]; then
  say "Backend újraindítás kihagyva (MES_SKIP_RESTART)"
else
  say "Backend újraindítása: $SERVICE"
  systemctl restart "$SERVICE"
  printf 'Várakozás: %s ' "$HEALTH_URL"
  ok=0
  for _ in $(seq 1 "$HEALTH_WAIT"); do
    if curl -fsS -m 2 "$HEALTH_URL" >/dev/null 2>&1; then ok=1; break; fi
    printf '.'; sleep 1
  done
  echo
  if [ "$ok" -ne 1 ]; then
    journalctl -u "$SERVICE" -n 40 --no-pager || true
    die "a backend $HEALTH_WAIT mp alatt nem állt fel (napló fent). A felület már az új; visszaállás: git reset --hard $OLD_HEAD && $SELF --no-push"
  fi
  echo "A backend fut."
fi

# ---- 6. push ----
if [ "$PUSH" -eq 1 ] && [ "$NEW_HEAD" != "$OLD_HEAD" ]; then
  say "git push"
  git push || echo "FIGYELEM: a push nem sikerült — a telepítés kész, a push később pótolható: git push"
fi

say "Kész"
if [ "$NEW_HEAD" != "$OLD_HEAD" ]; then
  git log --format='  %h %s' "$OLD_HEAD..$NEW_HEAD"
else
  echo "  $(git log -1 --format='%h %s') (újratelepítve)"
fi
