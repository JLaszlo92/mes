#!/usr/bin/env bash
# Run on the edge node. Prints, per machine, how many events are waiting
# (unacknowledged) in the edge agent's buffer, and their oldest/newest timestamps.
# The buffer directory comes from the StateDirectory drop-in (/var/lib/mes-edge).
DIR="${1:-/var/lib/mes-edge}"
node -e '
const fs = require("fs");
const dir = process.argv[1];
for (const f of fs.readdirSync(dir).sort()) {
  const lines = fs.readFileSync(dir + "/" + f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ts = lines.map((e) => e.timestamp).sort();
  console.log(f, lines.length, ts[0] || "-", ts[ts.length - 1] || "-");
}' "$DIR"
