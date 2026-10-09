import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { WorkInstruction } from "./work-instructions.js";
import { PDF_LABELS_EN, type PdfViewerLabels } from "./ui/pdf-labels.js";

const PdfViewer = lazy(() => import("./ui/PdfViewer.js"));

export interface InstructionViewerLabels {
  text: string;
  document: string;
  close: string;
  noText: string;
  openLink: string;
  pdf: PdfViewerLabels;
}

export const VIEWER_LABELS_EN: InstructionViewerLabels = {
  text: "Instructions",
  document: "PDF",
  close: "Close",
  noText: "This instruction has no text. Open the PDF.",
  openLink: "Open the linked document",
  pdf: PDF_LABELS_EN,
};

export const VIEWER_LABELS_HU: InstructionViewerLabels = {
  text: "Leírás",
  document: "PDF",
  close: "Bezárás",
  noText: "Ehhez az utasításhoz nincs szöveges leírás. Nyisd meg a PDF-et.",
  openLink: "Külső dokumentum megnyitása",
  pdf: {
    loading: "Dokumentum betöltése…",
    failed: "A dokumentumot nem sikerült megnyitni.",
    retry: "Újra",
    page: "oldal",
    zoomIn: "Nagyítás",
    zoomOut: "Kicsinyítés",
    fit: "Teljes szélesség",
  },
};

export type ViewerTab = "text" | "pdf";

/**
 * Egy munkautasítás teljes képernyős nézete: szöveges leírás és a feltöltött
 * PDF, két fülön. A terminálon (nagy gombok, magyar feliratok) és a
 * dashboardon (előnézet: "ezt látja az operátor") ugyanez a komponens.
 */
export default function InstructionViewer({
  instruction,
  subtitle,
  initialTab,
  labels = VIEWER_LABELS_EN,
  large = false,
  onClose,
}: {
  instruction: WorkInstruction;
  subtitle?: string;
  initialTab?: ViewerTab;
  labels?: InstructionViewerLabels;
  /** Touch-sized controls and larger text, for the terminal. */
  large?: boolean;
  onClose: () => void;
}) {
  const hasPdf = instruction.pdfFileId !== null;
  const hasText = instruction.content.trim() !== "";
  const [tab, setTab] = useState<ViewerTab>(() => (initialTab === "pdf" && hasPdf ? "pdf" : hasText || !hasPdf ? "text" : "pdf"));
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // The viewer may sit on top of a drawer: only the viewer closes.
        e.preventDefault();
        e.stopImmediatePropagation();
        closeRef.current();
      }
    }
    // Capture phase: runs before the drawer's own Escape handler.
    document.addEventListener("keydown", onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = overflow;
    };
  }, []);

  return (
    <div className="ui-viewer" data-large={large ? "true" : undefined} role="dialog" aria-modal="true" aria-label={instruction.partName}>
      <div className="ui-viewer-head">
        <div className="ui-viewer-title">
          <strong>{instruction.partName}</strong>
          <span className="ui-sub">
            v{instruction.version}
            {subtitle ? ` · ${subtitle}` : ""}
          </span>
        </div>
        {hasPdf && (
          <div className="ui-viewer-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "text"} className="ui-viewer-tab" onClick={() => setTab("text")}>
              {labels.text}
            </button>
            <button type="button" role="tab" aria-selected={tab === "pdf"} className="ui-viewer-tab" onClick={() => setTab("pdf")}>
              {labels.document}
            </button>
          </div>
        )}
        <button type="button" className="ui-btn ui-viewer-close" onClick={onClose}>
          {labels.close}
        </button>
      </div>

      {tab === "pdf" && instruction.pdfFileId ? (
        <Suspense fallback={<div className="ui-pdf-state">{labels.pdf.loading}</div>}>
          <PdfViewer fileId={instruction.pdfFileId} labels={labels.pdf} />
        </Suspense>
      ) : (
        <div className="ui-viewer-text">
          {hasText ? <div className="ui-viewer-content">{instruction.content}</div> : hasPdf ? <p className="ui-field-hint">{labels.noText}</p> : null}
          {instruction.pdfUrl && (
            <p>
              <a href={instruction.pdfUrl} target="_blank" rel="noopener noreferrer">
                {labels.openLink}
              </a>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
