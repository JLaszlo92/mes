import { useState, type ReactNode } from "react";

export default function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div style={{ marginTop: 16, border: "1px solid #e1e0d9", borderRadius: 10, overflow: "hidden" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "12px 16px",
          background: "#f7f7f5",
          border: "none",
          cursor: "pointer",
          fontSize: 15,
          fontWeight: 600,
          textAlign: "left",
        }}
      >
        {title}
        <span style={{ fontSize: 13, color: "#898781" }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && <div style={{ padding: "0 16px 16px" }}>{children}</div>}
    </div>
  );
}