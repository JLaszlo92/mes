import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const repo = {
  createNewVersion: vi.fn(),
  getCurrentInstructionForPart: vi.fn(),
  getInstructionFile: vi.fn(),
  getInstructionFileSha: vi.fn(),
  getInstructionForWorkOrder: vi.fn(),
  instructionFileExists: vi.fn(),
  isForeignKeyViolation: (err: unknown) => (err as { code?: string }).code === "23503",
  listCurrentInstructions: vi.fn(),
  listVersionsForPart: vi.fn(),
  listViews: vi.fn(),
  recordView: vi.fn(),
  storeInstructionFile: vi.fn(),
};
const audit = vi.fn();
vi.mock("../work-instructions-repository.js", () => repo);
vi.mock("../audit-repository.js", () => ({ recordAuditEvent: audit }));
vi.mock("../auth-plugin.js", () => ({ requireRole: () => async () => {} }));

async function app() {
  const { default: routes } = await import("../work-instruction-routes.js");
  const a = Fastify();
  a.decorateRequest("user", undefined);
  a.addHook("onRequest", async (request) => {
    (request as unknown as { user: unknown }).user = { id: "u1", role: "admin", email: "a@b" };
  });
  await a.register(routes);
  await a.ready();
  return a;
}

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n");

beforeEach(() => {
  for (const fn of Object.values(repo)) if (typeof fn === "function" && "mockReset" in fn) fn.mockReset();
  audit.mockReset();
});

describe("POST /api/work-instructions/files", () => {
  it("stores a PDF and returns a cleaned display name", async () => {
    repo.storeInstructionFile.mockResolvedValue({ id: "f1", sizeBytes: PDF.length, sha256: "abc" });
    const r = await (await app()).inject({
      method: "POST",
      url: "/api/work-instructions/files",
      headers: { "content-type": "application/pdf", "x-file-name": encodeURIComponent("../Szerelés A-12.PDF") },
      payload: PDF,
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ id: "f1", sizeBytes: PDF.length, fileName: "Szerelés A-12.pdf" });
    expect(repo.storeInstructionFile).toHaveBeenCalledWith(PDF, "u1");
  });
  it("rejects a body that is not a PDF without storing it", async () => {
    const r = await (await app()).inject({
      method: "POST",
      url: "/api/work-instructions/files",
      headers: { "content-type": "application/pdf" },
      payload: Buffer.from("MZ\u0090 not a pdf"),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ field: "file" });
    expect(repo.storeInstructionFile).not.toHaveBeenCalled();
  });
  it("survives a malformed file name header", async () => {
    repo.storeInstructionFile.mockResolvedValue({ id: "f1", sizeBytes: 1, sha256: "abc" });
    const r = await (await app()).inject({
      method: "POST",
      url: "/api/work-instructions/files",
      headers: { "content-type": "application/pdf", "x-file-name": "%E0%A4%A" },
      payload: PDF,
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().fileName).toBe("document.pdf");
  });
});

describe("GET /api/work-instructions/files/:id", () => {
  it("serves the PDF with headers that keep it inert", async () => {
    repo.getInstructionFileSha.mockResolvedValue("abc");
    repo.getInstructionFile.mockResolvedValue({ content: PDF, sha256: "abc" });
    const r = await (await app()).inject({ method: "GET", url: "/api/work-instructions/files/f1" });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.equals(PDF)).toBe(true);
    expect(r.headers["content-type"]).toBe("application/pdf");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-security-policy"]).toContain("sandbox");
    expect(r.headers.etag).toBe('"abc"');
  });
  it("answers 304 without reading the file when the browser has it", async () => {
    repo.getInstructionFileSha.mockResolvedValue("abc");
    const r = await (await app()).inject({ method: "GET", url: "/api/work-instructions/files/f1", headers: { "if-none-match": '"abc"' } });
    expect(r.statusCode).toBe(304);
    expect(repo.getInstructionFile).not.toHaveBeenCalled();
  });
  it("404 for an unknown file", async () => {
    repo.getInstructionFileSha.mockResolvedValue(undefined);
    expect((await (await app()).inject({ method: "GET", url: "/api/work-instructions/files/nope" })).statusCode).toBe(404);
  });
});

describe("POST /api/work-instructions", () => {
  it("publishes a version and audits it", async () => {
    repo.instructionFileExists.mockResolvedValue(true);
    repo.createNewVersion.mockResolvedValue({ id: "i2", partName: "B", version: 2, pdfFileId: "f1", pdfFileName: "a.pdf", pdfUrl: null });
    const r = await (await app()).inject({
      method: "POST",
      url: "/api/work-instructions",
      payload: { partName: " B ", content: "step", pdfFileId: "f1", pdfFileName: "a.pdf" },
    });
    expect(r.statusCode).toBe(201);
    expect(repo.createNewVersion).toHaveBeenCalledWith({ partName: "B", content: "step", pdfUrl: null, pdfFileId: "f1", pdfFileName: "a.pdf", createdBy: "u1" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "work_instruction_versioned", target: "i2", details: expect.objectContaining({ version: 2, pdfFileId: "f1" }) }));
  });
  it("400 with the field for bad input and for a file that does not exist", async () => {
    const a = await app();
    expect((await a.inject({ method: "POST", url: "/api/work-instructions", payload: { partName: "B", content: " " } })).json()).toMatchObject({ field: "content" });
    repo.instructionFileExists.mockResolvedValue(false);
    const r = await a.inject({ method: "POST", url: "/api/work-instructions", payload: { partName: "B", pdfFileId: "gone" } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ field: "pdfFileId" });
    expect(repo.createNewVersion).not.toHaveBeenCalled();
  });
});

describe("GET /api/work-orders/:id/work-instruction", () => {
  it("tells an unknown order from an order without instruction", async () => {
    const a = await app();
    repo.getInstructionForWorkOrder.mockResolvedValueOnce(undefined);
    expect((await a.inject({ method: "GET", url: "/api/work-orders/x/work-instruction" })).json()).toEqual({ error: "unknown work order" });
    repo.getInstructionForWorkOrder.mockResolvedValueOnce(null);
    const none = await a.inject({ method: "GET", url: "/api/work-orders/w1/work-instruction" });
    expect(none.statusCode).toBe(404);
    expect(none.json()).toEqual({ error: "no work instruction for this work order" });
    repo.getInstructionForWorkOrder.mockResolvedValueOnce({ id: "i1", partName: "B" });
    expect((await a.inject({ method: "GET", url: "/api/work-orders/w1/work-instruction" })).json()).toEqual({ id: "i1", partName: "B" });
  });
});

describe("names in the path", () => {
  it("passes a name with a slash and a percent sign through once-decoded", async () => {
    repo.getCurrentInstructionForPart.mockResolvedValue({ id: "i1" });
    repo.listVersionsForPart.mockResolvedValue([]);
    const a = await app();
    const name = "Tengely 20/30 100%";
    await a.inject({ method: "GET", url: `/api/work-instructions/${encodeURIComponent(name)}` });
    expect(repo.getCurrentInstructionForPart).toHaveBeenCalledWith(name);
    await a.inject({ method: "GET", url: `/api/work-instructions/${encodeURIComponent(name)}/versions` });
    expect(repo.listVersionsForPart).toHaveBeenCalledWith(name);
  });
});

describe("POST /api/work-instructions/view", () => {
  it("records the view for the signed-in user; unknown ids are a 404, not a 500", async () => {
    const a = await app();
    const ok = await a.inject({ method: "POST", url: "/api/work-instructions/view", payload: { workInstructionId: "i1", workOrderId: "w1" } });
    expect(ok.statusCode).toBe(201);
    expect(repo.recordView).toHaveBeenCalledWith("i1", "w1", "u1");
    repo.recordView.mockRejectedValueOnce(Object.assign(new Error("fk"), { code: "23503" }));
    expect((await a.inject({ method: "POST", url: "/api/work-instructions/view", payload: { workInstructionId: "nope" } })).statusCode).toBe(404);
    expect((await a.inject({ method: "POST", url: "/api/work-instructions/view", payload: {} })).statusCode).toBe(400);
  });
});
