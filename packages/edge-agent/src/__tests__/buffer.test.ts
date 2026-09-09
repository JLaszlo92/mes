import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileEventBuffer } from "../buffer.js";

const TEST_FILE = "/tmp/mes-edge-agent-buffer-test.ndjson";

function makeEvent(sourceEventId: string) {
  return {
    type: "production_count" as const,
    machineId: "m-test",
    timestamp: new Date().toISOString(),
    sourceEventId,
    result: "good" as const,
  };
}

describe("FileEventBuffer", () => {
  beforeEach(() => {
    if (existsSync(TEST_FILE)) rmSync(TEST_FILE);
  });
  afterEach(() => {
    if (existsSync(TEST_FILE)) rmSync(TEST_FILE);
  });

  it("starts empty", () => {
    const buffer = new FileEventBuffer(TEST_FILE);
    expect(buffer.pendingCount).toBe(0);
  });

  it("persists enqueued events across buffer instances (survives a process restart)", () => {
    const buffer = new FileEventBuffer(TEST_FILE);
    buffer.enqueue(makeEvent("a"));
    buffer.enqueue(makeEvent("b"));

    const reopened = new FileEventBuffer(TEST_FILE);
    expect(reopened.readAll().map((e) => e.sourceEventId)).toEqual(["a", "b"]);
  });

  it("preserves FIFO order", () => {
    const buffer = new FileEventBuffer(TEST_FILE);
    for (const id of ["1", "2", "3"]) buffer.enqueue(makeEvent(id));
    expect(buffer.readAll().map((e) => e.sourceEventId)).toEqual(["1", "2", "3"]);
  });

  it("clear() empties the queue", () => {
    const buffer = new FileEventBuffer(TEST_FILE);
    buffer.enqueue(makeEvent("a"));
    buffer.clear();
    expect(buffer.pendingCount).toBe(0);
  });

  it("remove() drops only the matching event, preserving order of the rest", () => {
    const buffer = new FileEventBuffer(TEST_FILE);
    for (const id of ["1", "2", "3"]) buffer.enqueue(makeEvent(id));
    buffer.remove("2");
    expect(buffer.readAll().map((e) => e.sourceEventId)).toEqual(["1", "3"]);
  });

  it("remove() on an empty buffer is a no-op", () => {
    const buffer = new FileEventBuffer(TEST_FILE);
    buffer.remove("nonexistent");
    expect(buffer.pendingCount).toBe(0);
  });
});
