import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MachineEvent } from "@mes/shared";
import { FileEventBuffer } from "../buffer.js";

const ev = (id: string): MachineEvent => ({ machineId: "m1", timestamp: "2026-10-07T13:00:00.000Z", sourceEventId: id, type: "machine_status", status: "running" }) as unknown as MachineEvent;

describe("FileEventBuffer.removeMany", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mes-buffer-"));
    file = join(dir, "buffer.ndjson");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("removes several events with one rewrite", () => {
    const buffer = new FileEventBuffer(file);
    for (const id of ["a", "b", "c"]) buffer.enqueue(ev(id));
    buffer.removeMany(new Set(["a", "c"]));
    expect(buffer.readAll().map((e) => e.sourceEventId)).toEqual(["b"]);
  });

  it("does not touch the file when none of the ids is in it (a duplicate ack costs nothing)", () => {
    const buffer = new FileEventBuffer(file);
    buffer.enqueue(ev("a"));
    const old = new Date("2026-01-01T00:00:00Z");
    utimesSync(file, old, old);
    buffer.removeMany(new Set(["zzz"]));
    buffer.remove("yyy");
    expect(statSync(file).mtime.getTime()).toBe(old.getTime());
    expect(readFileSync(file, "utf-8").trim().split("\n")).toHaveLength(1);
  });

  it("remove() still removes one event and empties the file when it was the last", () => {
    const buffer = new FileEventBuffer(file);
    buffer.enqueue(ev("a"));
    buffer.remove("a");
    expect(buffer.pendingCount).toBe(0);
    expect(readFileSync(file, "utf-8")).toBe("");
  });
});
