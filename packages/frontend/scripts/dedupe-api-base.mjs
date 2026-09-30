#!/usr/bin/env node
// Egyszeri takarítás: az ismétlődő WS_URL / API_BASE definíciók helyett
// az api.ts exportjait importálja. Idempotens. Nem szabványos definíciót
// tartalmazó fájlt érintetlenül hagy és kiír (kézi ellenőrzésre).
//   node scripts/dedupe-api-base.mjs --dry   |   node scripts/dedupe-api-base.mjs
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const EXCLUDE = new Set(["api.ts"]);
const dry = process.argv.includes("--dry");

const CANONICAL = new Map([
  ["WS_URL", `const WS_URL = import.meta.env.VITE_BACKEND_WS_URL ?? "ws://localhost:3001/ws";`],
  ["API_BASE", `const API_BASE = WS_URL.replace(/^ws/, "http").replace(/\\/ws$/, "");`],
]);
const DEFINITION = /^\s*(?:export\s+)?const\s+(WS_URL|API_BASE)\s*=/;
const API_IMPORT = /^import\s*\{([^}]*)\}\s*from\s*["']\.\/api\.js["'];?\s*$/;

function lastImportLineIndex(lines) {
  let last = -1;
  let inImport = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!inImport) {
      if (line.startsWith("import ") || line === "import") inImport = true;
      else if (line === "" || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;
      else break;
    }
    if (inImport && (/from\s+["'][^"']+["'];?$/.test(line) || /^import\s+["'][^"']+["'];?$/.test(line))) {
      last = i;
      inImport = false;
    }
  }
  return last;
}

let changed = 0;
const skipped = [];

for (const name of readdirSync(SRC).sort()) {
  if (!/\.(tsx?|jsx?)$/.test(name) || name.endsWith(".d.ts") || EXCLUDE.has(name)) continue;
  const path = join(SRC, name);
  const before = readFileSync(path, "utf8");
  const lines = before.split("\n");

  const definitionLines = lines
    .map((line, index) => ({ line, index, match: line.match(DEFINITION) }))
    .filter((d) => d.match);
  if (definitionLines.length === 0) continue;

  const nonCanonical = definitionLines.filter((d) => d.line.trim() !== CANONICAL.get(d.match[1]));
  if (nonCanonical.length > 0) {
    skipped.push(`${name}: ${nonCanonical.map((d) => `line ${d.index + 1}`).join(", ")}`);
    continue;
  }

  const removeIndexes = new Set(definitionLines.map((d) => d.index));
  const kept = lines.filter((_, i) => !removeIndexes.has(i));
  const body = kept.join("\n");
  const needed = ["API_BASE", "WS_URL"].filter((id) => new RegExp(`\\b${id}\\b`).test(body));

  const importIndex = kept.findIndex((line) => API_IMPORT.test(line));
  if (importIndex >= 0) {
    const existing = kept[importIndex].match(API_IMPORT)[1].split(",").map((s) => s.trim()).filter(Boolean);
    kept[importIndex] = `import { ${[...new Set([...existing, ...needed])].join(", ")} } from "./api.js";`;
  } else if (needed.length > 0) {
    kept.splice(lastImportLineIndex(kept) + 1, 0, `import { ${needed.join(", ")} } from "./api.js";`);
  }

  const after = kept.join("\n").replace(/\n{3,}/g, "\n\n");
  if (after === before) continue;

  changed++;
  console.log(`${dry ? "[dry] " : ""}${name}: removed ${removeIndexes.size} definition(s), imports ${needed.join(", ") || "(none)"} from ./api.js`);
  if (!dry) writeFileSync(path, after);
}

if (skipped.length > 0) {
  console.log("\nSKIPPED — non-standard definition, review by hand:");
  for (const s of skipped) console.log(`  ${s}`);
}
console.log(`\n${changed} file(s) ${dry ? "would be " : ""}updated`);
