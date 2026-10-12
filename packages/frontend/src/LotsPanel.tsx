import { useEffect, useMemo, useState } from "react";
import { apiFetch, API_BASE } from "./api.js";
import { readJsonOrThrow } from "./master-data.js";
import { useScope } from "./scope.js";
import DataTable, { type Column } from "./ui/DataTable.js";
import Drawer from "./ui/Drawer.js";
import { downloadCsv } from "./ui/csv.js";
import { formatDate, formatDateTime, formatDuration } from "./ui/format.js";
import { usePolling } from "./ui/usePolling.js";
import { openMaterialLot, scrapRate, takeOpenParam, type Lot } from "./traceability.js";

type Period = "7" | "30" | "90" | "all";

/**
 * Késztermék-tételek (lots): kereshető táblázat. Egy tétel automatikusan
 * keletkezik, amikor egy work order lezárul. Sorra kattintva az oldalpanel
 * mutatja a teljes láncot: rendelés, gép, operátor, idő, darabszám és a
 * felhasznált alapanyag-tételek (azokra kattintva a Material lots oldal nyílik).
 */
export default function LotsPanel() {
  const { isInScope } = useScope();
  const [lots, setLots] = useState<Lot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState<Period>("30");
  const [withoutMaterial, setWithoutMaterial] = useState(false);
  const [openNumber, setOpenNumber] = useState<string | null>(() => takeOpenParam());

  function load() {
    return apiFetch(`${API_BASE}/api/lots`)
      .then((r) => readJsonOrThrow<Lot[]>(r))
      .then((rows) => {
        setLots(rows);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, []);
  usePolling(() => void load(), 30_000);

  // A link from another page opens a lot even if it is outside the default period.
  useEffect(() => {
    if (openNumber && lots.some((l) => l.lotNumber === openNumber)) setPeriod("all");
  }, [openNumber, lots]);

  const filtered = useMemo(() => {
    const since = period === "all" ? 0 : Date.now() - Number(period) * 86_400_000;
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return lots.filter((l) => {
      if (!isInScope(l.machineId)) return false;
      if (new Date(l.completedAt).getTime() < since) return false;
      if (withoutMaterial && l.materials.length > 0) return false;
      if (words.length === 0) return true;
      const haystack = [l.lotNumber, l.orderNumber, l.partName, l.machineName, l.operatorEmail, ...l.materials.flatMap((m) => [m.materialName, m.lotNumber, m.supplier])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
  }, [lots, query, period, withoutMaterial, isInScope]);

  const missingMaterial = useMemo(() => filtered.filter((l) => l.materials.length === 0).length, [filtered]);
  const filtersActive = query !== "" || period !== "30" || withoutMaterial;
  function clearFilters() {
    setQuery("");
    setPeriod("30");
    setWithoutMaterial(false);
  }

  function exportCsv() {
    downloadCsv(
      `lots-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Lot", "Work order", "Part", "Planned quantity", "Good", "Scrap", "Machine", "Operator", "Started", "Completed", "Material lots"],
      filtered.map((l) => [
        l.lotNumber,
        l.orderNumber,
        l.partName,
        l.quantity,
        l.goodCount,
        l.scrapCount,
        l.machineName,
        l.operatorEmail,
        l.startedAt,
        l.completedAt,
        l.materials.map((m) => `${m.materialName} (${m.lotNumber})`).join("; "),
      ]),
    );
  }

  const columns: Column<Lot>[] = [
    {
      id: "lot",
      header: "Lot",
      sortValue: (l) => l.lotNumber,
      cell: (l) => (
        <span>
          {l.lotNumber}
          <span className="ui-sub">{l.orderNumber}</span>
        </span>
      ),
    },
    { id: "part", header: "Part", sortValue: (l) => l.partName, cell: (l) => l.partName },
    { id: "machine", header: "Machine", sortValue: (l) => l.machineName, cell: (l) => l.machineName ?? <span className="ui-sub">—</span> },
    {
      id: "good",
      header: "Good",
      align: "right",
      sortValue: (l) => l.goodCount,
      cell: (l) => (
        <span>
          {l.goodCount.toLocaleString()}
          <span className="ui-sub">of {l.quantity.toLocaleString()}</span>
        </span>
      ),
    },
    {
      id: "scrap",
      header: "Scrap",
      align: "right",
      sortValue: (l) => l.scrapCount,
      cell: (l) => (
        <span>
          {l.scrapCount.toLocaleString()}
          <span className="ui-sub">{scrapRate(l.goodCount, l.scrapCount)}</span>
        </span>
      ),
    },
    {
      id: "material",
      header: "Material",
      sortValue: (l) => l.materials[0]?.materialName ?? null,
      cell: (l) =>
        l.materials.length === 0 ? (
          <span className="ui-pill ui-pill-warning">Not recorded</span>
        ) : (
          <span>
            {l.materials[0]!.materialName}
            <span className="ui-sub">
              Lot {l.materials[0]!.lotNumber}
              {l.materials.length > 1 ? ` +${l.materials.length - 1} more` : ""}
            </span>
          </span>
        ),
    },
    {
      id: "completed",
      header: "Completed",
      sortValue: (l) => l.completedAt,
      cell: (l) => (
        <span>
          {formatDateTime(l.completedAt)}
          <span className="ui-sub">{l.operatorEmail ?? "—"}</span>
        </span>
      ),
    },
  ];

  const openLot = openNumber ? lots.find((l) => l.lotNumber === openNumber) : undefined;

  return (
    <section className="ui-panel" style={{ marginTop: 8 }}>
      <div className="ui-panel-head">
        <h2 className="ui-panel-title">Lots</h2>
        <span className="ui-panel-count num">{filtered.length === lots.length ? lots.length : `${filtered.length} of ${lots.length}`}</span>
        <span className="ui-toolbar-spacer" />
        <button type="button" className="ui-btn" onClick={exportCsv} disabled={filtered.length === 0}>
          Export CSV
        </button>
      </div>

      <div className="ui-toolbar" role="search">
        <input
          className="ui-input ui-search"
          type="search"
          placeholder="Search lot, order, part, machine, material lot…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search lots"
        />
        <select className="ui-select" value={period} onChange={(e) => setPeriod(e.target.value as Period)} aria-label="Completed">
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="all">All time</option>
        </select>
        <label className="ui-check">
          <input type="checkbox" checked={withoutMaterial} onChange={(e) => setWithoutMaterial(e.target.checked)} />
          Material not recorded{missingMaterial > 0 && !withoutMaterial ? ` (${missingMaterial})` : ""}
        </label>
        {filtersActive && (
          <button type="button" className="ui-btn ui-btn-ghost" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      {error && <p className="ui-message ui-message-error">{error}</p>}

      {loading && lots.length === 0 ? (
        <p className="ui-message ui-message-info">Loading lots…</p>
      ) : (
        <DataTable
          paging={{ resetKey: [query, period, withoutMaterial] }}
          ariaLabel="Lots"
          rows={filtered}
          columns={columns}
          getRowId={(l) => l.id}
          onRowClick={(l) => setOpenNumber(l.lotNumber)}
          initialSort={{ columnId: "completed", dir: "desc" }}
          emptyText={
            lots.length === 0 ? (
              "No lots yet. A lot is created automatically when a work order is completed."
            ) : (
              <>
                No lots match these filters.{" "}
                <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={clearFilters}>
                  Clear filters
                </button>
              </>
            )
          }
        />
      )}

      {openLot && <LotDrawer lot={openLot} onClose={() => setOpenNumber(null)} />}
      {openNumber && !openLot && !loading && (
        <p className="ui-message ui-message-error">Lot {openNumber} was not found.</p>
      )}
    </section>
  );
}

function LotDrawer({ lot, onClose }: { lot: Lot; onClose: () => void }) {
  const duration = lot.startedAt ? (new Date(lot.completedAt).getTime() - new Date(lot.startedAt).getTime()) / 1000 : null;
  return (
    <Drawer
      title={lot.lotNumber}
      subtitle={`${lot.partName} · ${lot.orderNumber}`}
      onRequestClose={onClose}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button type="button" className="ui-btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <section className="ui-section">
        <h3 className="ui-section-title">Production</h3>
        <dl className="ui-facts">
          <dt>Work order</dt>
          <dd>{lot.orderNumber}</dd>
          <dt>Part</dt>
          <dd>{lot.partName}</dd>
          <dt>Good / planned</dt>
          <dd className="num">
            {lot.goodCount.toLocaleString()} / {lot.quantity.toLocaleString()}
          </dd>
          <dt>Scrap</dt>
          <dd className="num">
            {lot.scrapCount.toLocaleString()} ({scrapRate(lot.goodCount, lot.scrapCount)})
          </dd>
          <dt>Machine</dt>
          <dd>{lot.machineName ?? "—"}</dd>
          <dt>Started by</dt>
          <dd>{lot.operatorEmail ?? "—"}</dd>
          <dt>Started</dt>
          <dd>{formatDateTime(lot.startedAt)}</dd>
          <dt>Completed</dt>
          <dd>
            {formatDateTime(lot.completedAt)}
            {duration !== null && duration > 0 ? <span className="ui-sub">after {formatDuration(duration)}</span> : null}
          </dd>
        </dl>
        <p className="ui-field-hint" style={{ margin: 0 }}>
          Recorded automatically when the work order was completed: counts from the machine, start and operator from the terminal.
        </p>
      </section>

      <section className="ui-section">
        <h3 className="ui-section-title">Material</h3>
        {lot.materials.length === 0 ? (
          <p className="ui-message ui-message-error" style={{ margin: 0 }}>
            No material lot was recorded on {lot.orderNumber}, so this lot cannot be traced back to its material. Add it in the work order (Production → Work
            orders), even afterwards.
          </p>
        ) : (
          <ul className="ui-mini-list">
            {lot.materials.map((m) => (
              <li key={m.materialLotId} style={{ alignItems: "center" }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  {m.materialName}
                  <span className="ui-sub">
                    Lot {m.lotNumber}
                    {m.supplier ? ` · ${m.supplier}` : ""}
                    {m.receivedAt ? ` · received ${formatDate(m.receivedAt)}` : ""}
                  </span>
                </span>
                <button type="button" className="ui-btn ui-btn-small ui-btn-ghost" onClick={() => openMaterialLot(m.materialLotId)}>
                  Where else used
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Drawer>
  );
}
