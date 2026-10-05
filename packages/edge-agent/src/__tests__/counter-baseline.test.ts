import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CounterBaseline, loadCounters, parseStoredCounters, type BaselineLogger } from "../counter-baseline.js";

const silent: BaselineLogger = { info: () => {}, warn: () => {} };
const MIN = 60_000;

function make(file: string, nowRef: { t: number }, maxAgeMs = 10 * MIN, log: BaselineLogger = silent) {
  return new CounterBaseline({ machineId: "m1", filePath: file, maxAgeMs, log, now: () => nowRef.t });
}

describe("parseStoredCounters", () => {
  it("accepts a valid file and rejects garbage", () => {
    expect(parseStoredCounters('{"good":5,"scrap":1,"seenAtMs":99}')).toEqual({ good: 5, scrap: 1, seenAtMs: 99 });
    expect(parseStoredCounters("not json")).toBeNull();
    expect(parseStoredCounters('{"good":-1,"scrap":0,"seenAtMs":1}')).toBeNull();
    expect(parseStoredCounters('{"good":1.5,"scrap":0,"seenAtMs":1}')).toBeNull();
    expect(parseStoredCounters('{"good":1}')).toBeNull();
  });
});

describe("CounterBaseline", () => {
  it("first start: no catch-up, and the baseline is stored", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-"));
    const file = join(dir, "sub", "c.json");
    const now = { t: 1_000_000 };
    const b = make(file, now);
    expect(b.onFirstRead(100, 2)).toEqual({ good: 0, scrap: 0 });
    expect(loadCounters(file)).toEqual({ good: 100, scrap: 2, seenAtMs: 1_000_000 });
  });

  it("a restart within the limit books the parts produced meanwhile", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-"));
    const file = join(dir, "c.json");
    const now = { t: 1_000_000 };
    const a = make(file, now);
    a.onFirstRead(100, 2);
    now.t += 5_000;
    a.onRead(110, 2);
    // the agent dies here; a new one starts 70 s later and the PLC counted on
    now.t += 70_000;
    const b = make(file, now);
    expect(b.onFirstRead(145, 3)).toEqual({ good: 35, scrap: 1 });
  });

  it("a restart after more than the limit drops the parts and warns", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-"));
    const file = join(dir, "c.json");
    const now = { t: 1_000_000 };
    make(file, now).onFirstRead(100, 0);
    now.t += 11 * MIN;
    const warnings: Array<{ obj: object; msg: string }> = [];
    const log: BaselineLogger = { info: () => {}, warn: (obj, msg) => { warnings.push({ obj, msg }); } };
    const b = make(file, now, 10 * MIN, log);
    expect(b.onFirstRead(160, 0)).toEqual({ good: 0, scrap: 0 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.obj).toMatchObject({ lostGood: 60, reason: "too_old" });
  });

  it("an in-process connection loss uses the last reading, not the file from the start", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-"));
    const file = join(dir, "c.json");
    const now = { t: 1_000_000 };
    const b = make(file, now);
    b.onFirstRead(0, 0);
    now.t += 20 * MIN;
    b.onRead(50, 0); // still connected 20 minutes after the start
    now.t += 2 * MIN; // then the link drops for 2 minutes
    expect(b.onFirstRead(58, 0)).toEqual({ good: 8, scrap: 0 });
  });

  it("does not rewrite the file on every unchanged reading, but refreshes the time now and then", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-"));
    const file = join(dir, "c.json");
    const now = { t: 1_000_000 };
    const b = make(file, now);
    b.onFirstRead(10, 0);
    now.t += 1000;
    b.onRead(10, 0);
    expect(JSON.parse(readFileSync(file, "utf8")).seenAtMs).toBe(1_000_000);
    now.t += 5000;
    b.onRead(10, 0);
    expect(JSON.parse(readFileSync(file, "utf8")).seenAtMs).toBe(1_006_000);
    now.t += 10;
    b.onRead(11, 0);
    expect(JSON.parse(readFileSync(file, "utf8")).good).toBe(11);
  });

  it("survives a corrupt file and an unwritable path", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-"));
    const file = join(dir, "c.json");
    writeFileSync(file, "{broken");
    const now = { t: 5 };
    expect(make(file, now).onFirstRead(9, 9)).toEqual({ good: 0, scrap: 0 });

    // a path below a regular file can never be created
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    const bad = make(join(blocker, "sub", "c.json"), now);
    expect(bad.onFirstRead(1, 1)).toEqual({ good: 0, scrap: 0 });
    expect(() => bad.onRead(2, 2)).not.toThrow();
  });
});
