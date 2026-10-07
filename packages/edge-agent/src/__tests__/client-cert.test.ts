import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readClientCertExpiry } from "../client-cert.js";

// A throw-away self-signed EC certificate (no key), valid until 2126-09-13 12:34:39 UTC.
const PEM = `-----BEGIN CERTIFICATE-----
MIIBqTCCAU+gAwIBAgIUGYbj9+rdO7rtmZ52ShlxiqR+uC0wCgYIKoZIzj0EAwIw
KTERMA8GA1UECgwITUVTIFRlc3QxFDASBgNVBAMMC3Rlc3QtZGV2aWNlMCAXDTI2
MTAwNzEyMzQzOVoYDzIxMjYwOTEzMTIzNDM5WjApMREwDwYDVQQKDAhNRVMgVGVz
dDEUMBIGA1UEAwwLdGVzdC1kZXZpY2UwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC
AARw8D8IUu9THgkkQ31zBNBNert4ODdfLMOcKRak7Lkrb8IiRPVu4RVe3W13cVjh
idg3Swor4dHiMRkzJIlSupPVo1MwUTAdBgNVHQ4EFgQU9UxITSZU16D9z4Wl61J8
TA1vCJMwHwYDVR0jBBgwFoAU9UxITSZU16D9z4Wl61J8TA1vCJMwDwYDVR0TAQH/
BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiA/9MGA+DqZpj0ILchG1NP2/XGvCjqU
DHvJKNA/6FYbxQIhAJKFOScRZR/fK2dc/65Lpx3CaM8sQ39GQISDnL5lc6Bw
-----END CERTIFICATE-----
`;
const EXPIRES_AT_MS = Date.UTC(2126, 8, 13, 12, 34, 39);

const dir = mkdtempSync(path.join(os.tmpdir(), "mes-client-cert-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("readClientCertExpiry", () => {
  it("reads the notAfter of the certificate in the file", async () => {
    const file = path.join(dir, "cert.pem");
    writeFileSync(file, PEM);
    expect(await readClientCertExpiry(file)).toEqual({ expiresAtMs: EXPIRES_AT_MS });
  });

  it("leaves the figure out instead of throwing: no path, missing file, not a certificate", async () => {
    expect(await readClientCertExpiry(undefined)).toBeUndefined();
    expect(await readClientCertExpiry("")).toBeUndefined();
    expect(await readClientCertExpiry(path.join(dir, "nope.pem"))).toBeUndefined();
    const junk = path.join(dir, "junk.pem");
    writeFileSync(junk, "this is not a certificate");
    expect(await readClientCertExpiry(junk)).toBeUndefined();
  });
});
