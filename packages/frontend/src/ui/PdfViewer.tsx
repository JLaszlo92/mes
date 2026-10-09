import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { apiFetch, API_BASE } from "../api.js";
import { PDF_LABELS_EN, type PdfViewerLabels } from "./pdf-labels.js";

/**
 * Beépített PDF-megjelenítő (pdf.js, vászonra rajzol).
 *
 * Miért nem sima link vagy <iframe>: a fájl hitelesített végponton van
 * (Authorization fejléc kell hozzá), és a terminál-tabletek böngészői nem
 * egyformán bánnak a PDF-fel (az Android Chrome letölti és kilép a kioszkból,
 * az iOS Safari iframe-ben csak az első oldalt mutatja). Így minden eszközön
 * ugyanaz látszik, a terminál oldalán belül.
 *
 * A pdf.js csak akkor töltődik le, amikor először megnyitnak egy PDF-et
 * (külön chunk). A "legacy" build régebbi tablet-böngészőkön is fut. A worker
 * a Vite `?worker` importjával készül: sima .js fájl lesz az assets alatt
 * (egy .mjs-t az nginx alapbeállítással nem JavaScriptként szolgálna ki).
 */

type PdfJs = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as Promise<PdfJs>,
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker"),
  ])
    .then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerPort = new worker.default();
      return lib;
    })
    .catch((err) => {
      pdfjsPromise = null; // a failed download (network) can be retried
      throw err;
    });
  return pdfjsPromise;
}

const ZOOMS = [1, 1.25, 1.5, 2, 3];
/** Upper limit for one page's canvas, so a zoomed page cannot exhaust a tablet's memory. */
const MAX_CANVAS_PIXELS = 12_000_000;

export default function PdfViewer({ fileId, labels = PDF_LABELS_EN }: { fileId: string; labels?: PdfViewerLabels }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    let destroy: (() => void) | undefined;
    setDoc(null);
    setError(null);
    (async () => {
      const [lib, res] = await Promise.all([loadPdfJs(), apiFetch(`${API_BASE}/api/work-instructions/files/${encodeURIComponent(fileId)}`)]);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = await res.arrayBuffer();
      if (!alive) return;
      const task = lib.getDocument({ data, isEvalSupported: false });
      destroy = () => void task.destroy();
      const loaded = await task.promise;
      if (alive) setDoc(loaded);
    })().catch((err) => {
      if (alive) setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      alive = false;
      destroy?.();
    };
  }, [fileId, attempt]);

  // The pages follow the width of the frame (rotation, window resize).
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.floor(el.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const pageWidth = Math.max(0, Math.min(width - 24, 1100)) * zoom;
  const zoomIndex = ZOOMS.indexOf(zoom);

  return (
    <div className="ui-pdf">
      <div className="ui-pdf-bar">
        <span className="ui-pdf-count num">{doc ? `${doc.numPages} ${labels.page}` : ""}</span>
        <span className="ui-toolbar-spacer" />
        <button type="button" className="ui-btn ui-pdf-btn" onClick={() => setZoom(ZOOMS[zoomIndex - 1]!)} disabled={!doc || zoomIndex <= 0} aria-label={labels.zoomOut}>
          −
        </button>
        <button type="button" className="ui-btn ui-pdf-btn" onClick={() => setZoom(1)} disabled={!doc || zoom === 1} title={labels.fit}>
          <span className="num">{Math.round(zoom * 100)}%</span>
        </button>
        <button type="button" className="ui-btn ui-pdf-btn" onClick={() => setZoom(ZOOMS[zoomIndex + 1]!)} disabled={!doc || zoomIndex >= ZOOMS.length - 1} aria-label={labels.zoomIn}>
          +
        </button>
      </div>
      <div className="ui-pdf-frame" ref={frameRef}>
        {error ? (
          <div className="ui-pdf-state">
            <p className="ui-message ui-message-error">
              {labels.failed} ({error})
            </p>
            <button type="button" className="ui-btn" onClick={() => setAttempt((n) => n + 1)}>
              {labels.retry}
            </button>
          </div>
        ) : !doc ? (
          <div className="ui-pdf-state">{labels.loading}</div>
        ) : (
          pageWidth > 0 && Array.from({ length: doc.numPages }, (_, i) => <PdfPage key={i + 1} doc={doc} pageNumber={i + 1} cssWidth={pageWidth} root={frameRef.current} />)
        )}
      </div>
    </div>
  );
}

/** One page: reserves its place at once, draws itself when it comes near the visible area. */
function PdfPage({ doc, pageNumber, cssWidth, root }: { doc: PDFDocumentProxy; pageNumber: number; cssWidth: number; root: HTMLElement | null }) {
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(pageNumber === 1);
  const [ratio, setRatio] = useState(1.4142); // A4 until the real size is known

  useEffect(() => {
    const el = holderRef.current;
    if (!el || near) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { root, rootMargin: "800px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near, root]);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let task: RenderTask | undefined;
    (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      setRatio(base.height / base.width);
      const cssScale = cssWidth / base.width;
      let density = Math.min(window.devicePixelRatio || 1, 2);
      const pixels = base.width * cssScale * density * (base.height * cssScale * density);
      if (pixels > MAX_CANVAS_PIXELS) density *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
      const viewport = page.getViewport({ scale: cssScale * density });
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) return;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      task = page.render({ canvasContext: context, viewport });
      await task.promise;
    })().catch(() => {
      // A cancelled render (zoom, close) rejects on purpose; a broken page stays blank.
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, cssWidth, near]);

  return (
    <div ref={holderRef} className="ui-pdf-page" style={{ width: cssWidth, height: Math.round(cssWidth * ratio) }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
