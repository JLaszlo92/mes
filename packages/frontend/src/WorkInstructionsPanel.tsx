import { useEffect, useMemo, useState } from "react";
import { useAuth } from "./auth-context.js";
import DataTable, { type Column } from "./ui/DataTable.js";
import { formatDateTime } from "./ui/format.js";
import { usePolling } from "./ui/usePolling.js";
import InstructionViewer from "./InstructionViewer.js";
import WorkInstructionDrawer, { type InstructionTarget } from "./WorkInstructionDrawer.js";
import { formatBytes, listInstructions, type WorkInstruction } from "./work-instructions.js";

type DocFilter = "" | "pdf" | "none";

/**
 * Munkautasítások: kereshető táblázat, mint a gyártási rendeléseknél. Sorra
 * kattintva az oldalpanelen szerkeszthető (a mentés új verzió), ugyanott
 * tölthető fel a PDF, és látszik a verziótörténet meg a megtekintés-napló.
 */
export default function WorkInstructionsPanel() {
  const { auth } = useAuth();
  const canEdit = auth?.role === "admin" || auth?.role === "manager";
  const canSeeLog = canEdit || auth?.role === "supervisor";

  const [instructions, setInstructions] = useState<WorkInstruction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [docFilter, setDocFilter] = useState<DocFilter>("");
  const [editor, setEditor] = useState<InstructionTarget | null>(null);
  const [preview, setPreview] = useState<WorkInstruction | null>(null);

  function load() {
    return listInstructions()
      .then((rows) => {
        setInstructions(rows);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, []);

  // "Open orders" changes as work orders are created and closed; not while an editor is open.
  usePolling(() => void load(), 30_000, editor === null && preview === null);

  const filtered = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return instructions.filter((wi) => {
      const hasDoc = wi.pdfFileId !== null || wi.pdfUrl !== null;
      if (docFilter === "pdf" && !hasDoc) return false;
      if (docFilter === "none" && hasDoc) return false;
      if (words.length === 0) return true;
      const haystack = [wi.partName, wi.content, wi.pdfFileName, wi.createdByEmail].filter(Boolean).join(" ").toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
  }, [instructions, query, docFilter]);

  const filtersActive = query !== "" || docFilter !== "";
  function clearFilters() {
    setQuery("");
    setDocFilter("");
  }

  const columns: Column<WorkInstruction>[] = [
    {
      id: "name",
      header: "Instruction",
      sortValue: (wi) => wi.partName,
      cell: (wi) => (
        <span>
          {wi.partName}
          <span className="ui-sub ui-cell-clip">{wi.content.split("\n")[0] || "No text"}</span>
        </span>
      ),
    },
    { id: "version", header: "Version", align: "right", width: 80, sortValue: (wi) => wi.version, cell: (wi) => `v${wi.version}` },
    {
      id: "document",
      header: "Document",
      sortValue: (wi) => wi.pdfFileName ?? (wi.pdfUrl ? "link" : null),
      cell: (wi) =>
        wi.pdfFileId ? (
          <span>
            <span className="ui-cell-clip">{wi.pdfFileName}</span>
            <span className="ui-sub">{formatBytes(wi.pdfSizeBytes)}</span>
          </span>
        ) : wi.pdfUrl ? (
          "Link"
        ) : (
          <span className="ui-sub">None</span>
        ),
    },
    {
      id: "orders",
      header: "Open orders",
      align: "right",
      width: 110,
      sortValue: (wi) => wi.openWorkOrders ?? 0,
      cell: (wi) => wi.openWorkOrders ?? 0,
    },
    {
      id: "updated",
      header: "Last changed",
      sortValue: (wi) => wi.createdAt,
      cell: (wi) => (
        <span>
          {formatDateTime(wi.createdAt)}
          <span className="ui-sub">{wi.createdByEmail ?? "—"}</span>
        </span>
      ),
    },
  ];

  return (
    <section className="ui-panel" style={{ marginTop: 8 }}>
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Work instructions</h2>
        <span className="ui-panel-count num">{filtered.length === instructions.length ? instructions.length : `${filtered.length} of ${instructions.length}`}</span>
        <span className="ui-toolbar-spacer" />
        {canEdit && (
          <button type="button" className="ui-btn ui-btn-primary" onClick={() => setEditor({ mode: "create" })}>
            New instruction
          </button>
        )}
      </div>

      <div className="ui-toolbar" role="search">
        <input
          className="ui-input ui-search"
          type="search"
          placeholder="Search name, text, file…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search work instructions"
        />
        <select className="ui-select" value={docFilter} onChange={(e) => setDocFilter(e.target.value as DocFilter)} aria-label="Document">
          <option value="">With or without document</option>
          <option value="pdf">With a document</option>
          <option value="none">Text only</option>
        </select>
        {filtersActive && (
          <button type="button" className="ui-btn ui-btn-ghost" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      {error && <p className="ui-message ui-message-error">{error}</p>}
      {notice && <p className="ui-message ui-message-info">{notice}</p>}

      {loading && instructions.length === 0 ? (
        <p className="ui-message ui-message-info">Loading work instructions…</p>
      ) : (
        <DataTable
          ariaLabel="Work instructions"
          rows={filtered}
          columns={columns}
          getRowId={(wi) => wi.partName}
          onRowClick={(wi) => setEditor({ mode: "edit", instruction: wi })}
          initialSort={{ columnId: "name", dir: "asc" }}
          rowActions={(wi) => (
            <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={() => setPreview(wi)}>
              View
            </button>
          )}
          emptyText={
            instructions.length === 0 ? (
              canEdit ? "No work instructions yet. Create one and name it like the part it belongs to." : "No work instructions yet."
            ) : (
              <>
                No instructions match these filters.{" "}
                <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={clearFilters}>
                  Clear filters
                </button>
              </>
            )
          }
        />
      )}

      {editor && (
        <WorkInstructionDrawer
          key={editor.mode === "edit" ? editor.instruction.id : "new"}
          target={editor}
          canEdit={canEdit}
          canSeeLog={canSeeLog}
          onClose={() => setEditor(null)}
          onSaved={(wi) => {
            setEditor(null);
            setNotice(wi.version === 1 ? `${wi.partName} created.` : `${wi.partName} saved as version ${wi.version}.`);
            void load();
          }}
        />
      )}
      {preview && <InstructionViewer instruction={preview} subtitle="Preview: what the operator sees" onClose={() => setPreview(null)} />}
    </section>
  );
}
