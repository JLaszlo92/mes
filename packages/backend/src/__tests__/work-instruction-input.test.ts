import { describe, expect, it } from "vitest";
import { MAX_PDF_BYTES, checkPdfUpload, looksLikePdf, parseWorkInstructionCreate, sanitizePdfFileName } from "../work-instruction-input.js";

describe("sanitizePdfFileName", () => {
  it("keeps only the file name and forces the .pdf ending", () => {
    expect(sanitizePdfFileName("../../etc/Konzol A-12 szerelés.PDF")).toBe("Konzol A-12 szerelés.pdf");
    expect(sanitizePdfFileName("C:\\docs\\rajz")).toBe("rajz.pdf");
    expect(sanitizePdfFileName('a"<b>:*?|\u0000c.pdf')).toBe("abc.pdf");
  });
  it("falls back to a neutral name", () => {
    expect(sanitizePdfFileName("")).toBe("document.pdf");
    expect(sanitizePdfFileName(undefined)).toBe("document.pdf");
    expect(sanitizePdfFileName("...pdf")).toBe("document.pdf");
  });
  it("limits the length", () => {
    const name = sanitizePdfFileName(`${"x".repeat(400)}.pdf`);
    expect(name.length).toBe(150);
    expect(name.endsWith(".pdf")).toBe(true);
  });
});

describe("checkPdfUpload", () => {
  const pdf = Buffer.from("%PDF-1.7\n...");
  it("accepts a PDF, also with leading bytes before the header", () => {
    expect(checkPdfUpload(pdf)).toEqual({ ok: true, value: pdf });
    expect(looksLikePdf(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), pdf]))).toBe(true);
  });
  it("rejects empty, foreign and oversized uploads", () => {
    expect(checkPdfUpload(Buffer.alloc(0))).toMatchObject({ ok: false, field: "file" });
    expect(checkPdfUpload(undefined)).toMatchObject({ ok: false, field: "file" });
    expect(checkPdfUpload({ not: "a buffer" })).toMatchObject({ ok: false, field: "file" });
    expect(checkPdfUpload(Buffer.from("<html><script>alert(1)</script>"))).toMatchObject({ ok: false, error: "the file is not a PDF" });
    expect(checkPdfUpload(Buffer.concat([pdf, Buffer.alloc(MAX_PDF_BYTES)]))).toMatchObject({ ok: false, field: "file" });
  });
});

describe("parseWorkInstructionCreate", () => {
  it("trims and fills the optional fields", () => {
    expect(parseWorkInstructionCreate({ partName: " Bracket ", content: " step 1 " })).toEqual({
      ok: true,
      value: { partName: "Bracket", content: "step 1", pdfUrl: null, pdfFileId: null, pdfFileName: null },
    });
  });
  it("accepts a PDF without text, and names the file", () => {
    expect(parseWorkInstructionCreate({ partName: "B", pdfFileId: "f1", pdfFileName: "dir/rajz.PDF" })).toEqual({
      ok: true,
      value: { partName: "B", content: "", pdfUrl: null, pdfFileId: "f1", pdfFileName: "rajz.pdf" },
    });
    expect(parseWorkInstructionCreate({ partName: "B", content: "", pdfFileName: "x.pdf" })).toMatchObject({ ok: false, field: "content" });
  });
  it("needs a name and some content", () => {
    expect(parseWorkInstructionCreate({ content: "a" })).toMatchObject({ ok: false, field: "partName" });
    expect(parseWorkInstructionCreate({ partName: "B", content: "  " })).toMatchObject({ ok: false, field: "content" });
    expect(parseWorkInstructionCreate(null)).toMatchObject({ ok: false, field: "body" });
    expect(parseWorkInstructionCreate({ partName: "B", content: "a", extra: 1 })).toMatchObject({ ok: false, field: "extra" });
  });
  it("only allows http(s) links", () => {
    expect(parseWorkInstructionCreate({ partName: "B", pdfUrl: "https://example.com/a.pdf" })).toMatchObject({ ok: true });
    for (const pdfUrl of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "not a link"]) {
      expect(parseWorkInstructionCreate({ partName: "B", content: "a", pdfUrl })).toMatchObject({ ok: false, field: "pdfUrl" });
    }
    expect(parseWorkInstructionCreate({ partName: "B", content: "a", pdfUrl: "" })).toMatchObject({ ok: true, value: { pdfUrl: null } });
  });
  it("refuses names that the fixed routes would shadow", () => {
    for (const partName of ["files", "View", "views"]) {
      expect(parseWorkInstructionCreate({ partName, content: "a" })).toMatchObject({ ok: false, field: "partName" });
    }
  });
});
