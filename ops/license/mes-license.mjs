#!/usr/bin/env node
// Vendor-side license tool for the MES. Run it on the VENDOR's admin machine
// (the laptop), never on a customer node: the signing key must stay offline.
// No dependencies; needs Node 18+.
//
//   mes-license.mjs keygen
//   mes-license.mjs issue --customer "Name" --edge-nodes 2 --terminals 10 \
//       --device-ca ~/mes-device-ca/root.crt [--days 365] [--grace 14] [--from ISO] [--out file]
//   mes-license.mjs verify <license.json> --device-ca <root.crt> [--pub license.pub] [--min-serial N]
//
// Keys live in ~/mes-license-key (MES_LICENSE_DIR overrides): license.key
// (encrypted private key), license.pub (give this to the backend), serial.
// For automated tests only, MES_LICENSE_PASSPHRASE supplies the passphrase.
import {
  X509Certificate, createHash, createPrivateKey, createPublicKey, generateKeyPairSync,
  randomBytes, sign, verify,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

const FORMAT = "mes-license-v1";
const DOMAIN = Buffer.from(`${FORMAT}\n`);
const DAY = 86_400_000;
const DIR = process.env.MES_LICENSE_DIR ?? join(homedir(), "mes-license-key");
const KEY = join(DIR, "license.key");
const PUB = join(DIR, "license.pub");
const SERIAL = join(DIR, "serial");

const die = (m) => { console.error(m); process.exit(1); };

function ask(prompt) {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl._writeToOutput = () => {};
    rl.question("", (a) => { rl.close(); process.stderr.write("\n"); resolve(a); });
  });
}

async function passphrase(confirm) {
  if (process.env.MES_LICENSE_PASSPHRASE) return process.env.MES_LICENSE_PASSPHRASE;
  const a = await ask("License key passphrase: ");
  if (confirm) {
    if (a.length < 12) die("Use at least 12 characters.");
    if ((await ask("Repeat: ")) !== a) die("Passphrases differ.");
  }
  return a;
}

const fingerprint = (path) => createHash("sha256").update(new X509Certificate(readFileSync(path)).raw).digest("hex");

function evaluate(p, now, caSha, minSerial) {
  if (p.deviceCaSha256 !== caSha) return ["INVALID", "issued for a different installation (device CA mismatch)"];
  if (minSerial !== undefined && p.serial < minSerial) return ["INVALID", "older than an installed license"];
  const from = Date.parse(p.validFrom), until = Date.parse(p.validUntil), t = now.getTime();
  if (t < from - DAY) return ["INVALID", "not valid yet"];
  if (t <= until) return ["VALID", `${Math.ceil((until - t) / DAY)} days left`];
  const graceEnd = until + p.graceDays * DAY;
  if (t <= graceEnd) return ["GRACE", `grace period ends in ${Math.ceil((graceEnd - t) / DAY)} days`];
  return ["EXPIRED", "license and grace period ended"];
}

async function keygen() {
  if (existsSync(KEY)) die(`A license key already exists in ${DIR}`);
  const pass = await passphrase(true);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: pass },
  });
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(KEY, privateKey, { mode: 0o600 });
  writeFileSync(PUB, publicKey, { mode: 0o644 });
  writeFileSync(SERIAL, "0\n", { mode: 0o600 });
  console.log(`Created ${KEY} (encrypted, keep it offline and back it up) and ${PUB} (public, goes to the backend).`);
}

async function issue(args) {
  const { values: v } = parseArgs({
    args,
    options: {
      customer: { type: "string" }, "edge-nodes": { type: "string" }, terminals: { type: "string" },
      "device-ca": { type: "string" }, days: { type: "string", default: "365" },
      grace: { type: "string", default: "14" }, from: { type: "string" }, out: { type: "string" },
    },
  });
  for (const k of ["customer", "edge-nodes", "terminals", "device-ca"]) if (!v[k]) die(`Missing --${k}`);
  const edgeNodes = Number(v["edge-nodes"]), terminals = Number(v.terminals);
  const days = Number(v.days), grace = Number(v.grace);
  if (![edgeNodes, terminals, grace].every((n) => Number.isInteger(n) && n >= 0 && n <= 100000)) die("Bad number in limits/grace.");
  if (!Number.isInteger(days) || days < 1 || days > 3660) die("--days must be 1..3660");
  if (!existsSync(KEY)) die(`No license key in ${DIR} - run keygen first.`);
  const from = v.from ? new Date(v.from) : new Date();
  if (Number.isNaN(from.getTime())) die("Bad --from date.");

  const key = createPrivateKey({ key: readFileSync(KEY), format: "pem", passphrase: await passphrase(false) });
  const serial = Number(readFileSync(SERIAL, "utf8").trim()) + 1;
  const payload = {
    v: 1,
    licenseId: `lic-${randomBytes(6).toString("hex")}`,
    customer: v.customer,
    serial,
    issuedAt: new Date().toISOString(),
    validFrom: from.toISOString(),
    validUntil: new Date(from.getTime() + days * DAY).toISOString(),
    graceDays: grace,
    deviceCaSha256: fingerprint(v["device-ca"]),
    limits: { edgeNodes, terminals },
  };
  const bytes = Buffer.from(JSON.stringify(payload));
  const sig = sign(null, Buffer.concat([DOMAIN, bytes]), key);
  const out = v.out ?? `license-${serial}.json`;
  writeFileSync(out, JSON.stringify({ format: FORMAT, payload: bytes.toString("base64url"), signature: sig.toString("base64url") }, null, 2) + "\n");
  writeFileSync(SERIAL, `${serial}\n`, { mode: 0o600 });
  console.log(`Issued ${out}: serial ${serial}, ${edgeNodes} edge node(s), ${terminals} terminal(s), valid until ${payload.validUntil} (+${grace} days grace).`);
}

function verifyCmd(args) {
  const { values: v, positionals } = parseArgs({
    args, allowPositionals: true,
    options: { "device-ca": { type: "string" }, pub: { type: "string", default: PUB }, "min-serial": { type: "string" } },
  });
  const file = positionals[0];
  if (!file || !v["device-ca"]) die("Usage: verify <license.json> --device-ca <root.crt> [--pub license.pub] [--min-serial N]");
  const env = JSON.parse(readFileSync(file, "utf8"));
  if (env.format !== FORMAT) die("Not a MES license file.");
  const bytes = Buffer.from(env.payload, "base64url");
  const ok = verify(null, Buffer.concat([DOMAIN, bytes]), createPublicKey(readFileSync(v.pub)), Buffer.from(env.signature, "base64url"));
  if (!ok) die("INVALID: signature does not verify");
  const p = JSON.parse(bytes.toString("utf8"));
  const [state, why] = evaluate(p, new Date(), fingerprint(v["device-ca"]), v["min-serial"] ? Number(v["min-serial"]) : undefined);
  console.log(JSON.stringify(p, null, 2));
  console.log(`${state}: ${why}`);
  process.exit(state === "VALID" || state === "GRACE" ? 0 : 2);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "keygen") await keygen();
else if (cmd === "issue") await issue(rest);
else if (cmd === "verify") verifyCmd(rest);
else die("Usage: mes-license.mjs keygen | issue ... | verify <file> ...");
