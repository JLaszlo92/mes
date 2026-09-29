#!/usr/bin/env node
/**
 * Egyszeri átállítás: a frontend `fetch(` hívásait `apiFetch(`-re cseréli,
 * és beszúrja az importot. Idempotens — újrafuttatva nem változtat semmit.
 *
 *   node scripts/use-api-fetch.mjs --dry   # csak kiírja, mit módosítana
 *   node scripts/use-api-fetch.mjs         # végrehajtja
 *
 * Kihagyja: api.ts (maga az apiFetch), auth-context.tsx (login/logout
 * szándékosan sima fetch), *.d.ts. A cserélt hívások viselkedése a
 * backendre menő kéréseken kívül nem változik (más originre nem kerül token).
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const EXCLUDE = new Set(["api.ts", "auth-context.tsx"]);
const IMPORT_LINE = `import { apiFetch } from "./api.js";`;
const dry = process.argv.includes("--dry");

// Csak a "szabad" fetch( hívások: nem apiFetch(, nem window.fetch(, nem refetch( stb.
const FETCH_CALL = /(?<![\w.$])fetch\(/g;

/** Az utolsó import-utasítás záró sorának indexe (többsoros importot is kezel), vagy -1. */
function lastImportLineIndex(lines) {
  let last = -1;
  let inImport = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!inImport) {
      if (line.startsWith("import ") || line === "import") {
        inImport = true;
      } else if (line === "" || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) {
        continue;
      } else {
        break;
      }
    }
    if (inImport && (/from\s+["'][^"']+["'];?$/.test(line) || /^import\s+["'][^"']+["'];?$/.test(line))) {
      last = i;
      inImport = false;
    }
  }
  return last;
}

let changedFiles = 0;
for (const name of readdirSync(SRC).sort()) {
  if (!/\.(tsx?|jsx?)$/.test(name) || name.endsWith(".d.ts") || EXCLUDE.has(name)) continue;
  const path = join(SRC, name);
  const before = readFileSync(path, "utf8");
  const count = (before.match(FETCH_CALL) ?? []).length;
  if (count === 0) continue;

  let after = before.replace(FETCH_CALL, "apiFetch(");
  if (!after.includes(IMPORT_LINE)) {
    const lines = after.split("\n");
    const idx = lastImportLineIndex(lines);
    lines.splice(idx + 1, 0, IMPORT_LINE);
    after = lines.join("\n");
  }

  changedFiles++;
  console.log(`${dry ? "[dry] " : ""}${name}: ${count} × fetch → apiFetch`);
  if (!dry) writeFileSync(path, after);
}
console.log(`${changedFiles} file(s) ${dry ? "would be " : ""}updated`);
