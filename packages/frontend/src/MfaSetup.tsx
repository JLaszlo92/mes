import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";

const WS_URL = import.meta.env.VITE_BACKEND_WS_URL ?? "ws://localhost:3001/ws";
const API_BASE = WS_URL.replace(/^ws/, "http").replace(/\/ws$/, "");

export default function MfaSetup() {
  const { auth, completeMfaSetup, logout } = useAuth();
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/mfa/enroll`, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth?.token}` },
    })
      .then((res) => res.json())
      .then((data) => {
        setQrCodeDataUrl(data.qrCodeDataUrl);
        setSecret(data.secret);
      })
      .catch((err) => setError(String(err)));
  }, [auth]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/auth/mfa/verify-enrollment`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth?.token}` },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `${res.status} ${res.statusText}`);
      }
      completeMfaSetup();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 360, margin: "60px auto", textAlign: "center" }}>
      <h1 style={{ fontSize: 20 }}>Set up two-factor authentication</h1>
      <p style={{ fontSize: 13, color: "#898781" }}>
        Your role requires MFA. Scan this QR code with an authenticator app, then enter the 6-digit code it shows.
      </p>
      {qrCodeDataUrl && <img src={qrCodeDataUrl} alt="MFA QR code" style={{ width: 200, height: 200 }} />}
      {secret && (
        <p style={{ fontSize: 12, color: "#898781" }}>
          Can't scan? Enter this key manually: <code>{secret}</code>
        </p>
      )}
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
        <input
          required
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          style={{ padding: 8, border: "1px solid #e1e0d9", borderRadius: 6, fontSize: 24, textAlign: "center", letterSpacing: 4 }}
        />
        {error && <p style={{ color: "#d03b3b", fontSize: 13, margin: 0 }}>{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          style={{ padding: "8px 14px", border: "1px solid #0b0b0b", borderRadius: 6, background: "#0b0b0b", color: "#fff", cursor: "pointer" }}
        >
          {submitting ? "Verifying…" : "Confirm"}
        </button>
      </form>
      <button
        onClick={logout}
        style={{ marginTop: 16, fontSize: 12, background: "none", border: "none", color: "#898781", cursor: "pointer", textDecoration: "underline" }}
      >
        Sign out instead
      </button>
    </div>
  );
}