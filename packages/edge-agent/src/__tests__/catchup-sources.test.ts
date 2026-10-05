import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModbusSignalSource } from "../signal-sources/ModbusSignalSource.js";
import { OpcUaSignalSource } from "../signal-sources/OpcUaSignalSource.js";
import { CounterBaseline } from "../counter-baseline.js";

function baseline(file: string, maxMin = 10) {
  const log = { info: vi.fn(), warn: vi.fn() };
  return { log, b: new CounterBaseline({ machineId: "m1", filePath: file, maxAgeMs: maxMin * 60000, log }) };
}
function stored(dir: string, good: number, scrap: number, agoMs: number): string {
  const f = join(dir, "c.json");
  writeFileSync(f, JSON.stringify({ good, scrap, seenAtMs: Date.now() - agoMs }));
  return f;
}
const count = (r: any[], result: string) => r.filter((x) => x.kind === "production_count" && x.result === result).length;

describe("ModbusSignalSource with counterBaseline", () => {
  function make(b?: CounterBaseline) {
    const s: any = new ModbusSignalSource({ host: "x", counterBaseline: b });
    const regs = { data: [0, 0, 1] };
    s.client = { readHoldingRegisters: async () => { if ((regs as any).fail) throw new Error("link"); return regs; }, close: () => {} };
    s.connected = true;
    s.reconnect = async () => { s.connected = true; };
    const readings: any[] = [];
    return { s, regs: regs as any, readings, poll: () => s.poll((r: any) => readings.push(r)) };
  }

  it("books the gap after a restart, once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-"));
    const { b } = baseline(stored(dir, 100, 10, 70_000));
    const t = make(b);
    t.regs.data = [135, 11, 1];
    await t.poll();
    expect(count(t.readings, "good")).toBe(35);
    expect(count(t.readings, "scrap")).toBe(1);
    await t.poll();
    expect(count(t.readings, "good")).toBe(35);
  });

  it("drops a gap longer than the limit and warns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-"));
    const { b, log } = baseline(stored(dir, 100, 10, 20 * 60_000));
    const t = make(b);
    t.regs.data = [135, 11, 1];
    await t.poll();
    expect(count(t.readings, "good")).toBe(0);
    expect(log.warn).toHaveBeenCalled();
  });

  it("catches up parts missed during a PLC link loss (short) and drops after limit 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-"));
    const { b } = baseline(join(dir, "none.json"));
    const t = make(b);
    t.regs.data = [10, 0, 1];
    await t.poll();                 // first start: baseline only
    expect(count(t.readings, "good")).toBe(0);
    t.regs.fail = true;
    await t.poll();                 // link lost -> down
    expect(t.readings.at(-1)).toEqual({ kind: "machine_status", status: "down" });
    t.regs.fail = false;
    t.regs.data = [14, 1, 1];
    await t.poll();                 // recovered: 4 good + 1 scrap booked via baseline
    expect(count(t.readings, "good")).toBe(4);
    expect(count(t.readings, "scrap")).toBe(1);
  });

  it("without a baseline behaves as before (no burst on first read)", async () => {
    const t = make(undefined);
    t.regs.data = [500, 3, 1];
    await t.poll();
    expect(count(t.readings, "good")).toBe(0);
    t.regs.data = [502, 3, 1];
    await t.poll();
    expect(count(t.readings, "good")).toBe(2);
  });
});

describe("OpcUaSignalSource with counterBaseline", () => {
  it("books the gap after a restart, once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ou-"));
    const { b } = baseline(stored(dir, 20, 2, 30_000));
    const s: any = new OpcUaSignalSource({ endpointUrl: "x", goodCountNodeId: "g", scrapCountNodeId: "s", statusNodeId: "t", counterBaseline: b });
    let vals = [25, 2, "running"];
    s.session = { read: async () => vals.map((v) => ({ value: { value: v } })) };
    const readings: any[] = [];
    await s.poll((r: any) => readings.push(r));
    expect(count(readings, "good")).toBe(5);
    expect(count(readings, "scrap")).toBe(0);
    vals = [26, 2, "running"];
    await s.poll((r: any) => readings.push(r));
    expect(count(readings, "good")).toBe(6);
  });
  it("re-baselines after a failed read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ou-"));
    const { b } = baseline(join(dir, "n.json"));
    const s: any = new OpcUaSignalSource({ endpointUrl: "x", goodCountNodeId: "g", scrapCountNodeId: "s", statusNodeId: "t", counterBaseline: b });
    let vals: any[] | null = [5, 0, "running"];
    s.session = { read: async () => { if (!vals) throw new Error("x"); return vals.map((v) => ({ value: { value: v } })); } };
    const readings: any[] = [];
    await s.poll((r: any) => readings.push(r));
    vals = null;
    await s.poll((r: any) => readings.push(r));
    vals = [8, 0, "running"];
    await s.poll((r: any) => readings.push(r));
    expect(count(readings, "good")).toBe(3);
  });
});
