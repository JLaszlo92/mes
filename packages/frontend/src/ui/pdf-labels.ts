/** Captions of the PDF viewer; separate from PdfViewer.tsx so that importing them does not pull the viewer into the main bundle. */
export interface PdfViewerLabels {
  loading: string;
  failed: string;
  retry: string;
  page: string;
  zoomIn: string;
  zoomOut: string;
  fit: string;
}

export const PDF_LABELS_EN: PdfViewerLabels = {
  loading: "Loading document…",
  failed: "The document could not be opened.",
  retry: "Try again",
  page: "pages",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  fit: "Fit width",
};
