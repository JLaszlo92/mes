import { useState, type FormEvent } from "react";
import { useAuth } from "./auth-context.js";

const inputStyle = { display: "block", width: "100%", padding: 8, marginTop: 4, border: "1px solid #e1e0d9", borderRadius: 6 };

export default function LoginForm() {
  const { login, mfaPendingToken, submitMfaCode } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCodeSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await submitMfaCode(code);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (mfaPendingToken) {
    return (
      <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 320, margin: "80px auto" }}>
        <h1 style={{ fontSize: 20 }}>MES — Two-factor code</h1>
        <p style={{ fontSize: 13, color: "#898781" }}>Enter the 6-digit code from your authenticator app.</p>
        <form onSubmit={handleCodeSubmit} style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
          <input
            required
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            style={{ ...inputStyle, fontSize: 24, textAlign: "center", letterSpacing: 4 }}
            autoFocus
          />
          {error && <p style={{ color: "#d03b3b", fontSize: 13, margin: 0 }}>{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            style={{ padding: "8px 14px", border: "1px solid #0b0b0b", borderRadius: 6, background: "#0b0b0b", color: "#fff", cursor: "pointer" }}
          >
            {submitting ? "Verifying…" : "Verify"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 320, margin: "80px auto" }}>
      <h1 style={{ fontSize: 20 }}>MES — Sign in</h1>
      <form onSubmit={handlePasswordSubmit} style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
        <label style={{ fontSize: 13 }}>
          Email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} />
        </label>
        <label style={{ fontSize: 13 }}>
          Password
          <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} style={inputStyle} />
        </label>
        {error && <p style={{ color: "#d03b3b", fontSize: 13, margin: 0 }}>{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          style={{ padding: "8px 14px", border: "1px solid #0b0b0b", borderRadius: 6, background: "#0b0b0b", color: "#fff", cursor: "pointer" }}
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}