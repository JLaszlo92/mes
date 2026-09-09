import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { MachineEvent } from "@mes/shared";

/**
 * Durable local queue for events generated while the cloud connection is
 * down — the concrete mechanism behind PRD Section 5.1/8.4's "local
 * buffering" requirement and ROADMAP.md M0's "survives a simulated network
 * drop" acceptance test.
 *
 * Implementation note: this is an append-only NDJSON file rather than
 * something like better-sqlite3. That's a deliberate skeleton-stage choice,
 * not an oversight — it has zero native dependencies (nothing to compile on
 * whatever hardware ends up running the edge agent), and the format is
 * readable with `cat` during debugging. If buffered volumes grow large
 * enough that repeatedly rewriting the whole file on every acknowledge
 * becomes a real cost, swap this class for a SQLite-backed one; nothing
 * outside this file needs to change since callers only see enqueue/
 * readAll/clear.
 */
export class FileEventBuffer {
  constructor(private readonly filePath: string) {
    if (!existsSync(this.filePath)) {
      writeFileSync(this.filePath, "");
    }
  }

  enqueue(event: MachineEvent): void {
    appendFileSync(this.filePath, JSON.stringify(event) + "\n");
  }

  readAll(): MachineEvent[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, "utf-8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as MachineEvent);
  }

  clear(): void {
    writeFileSync(this.filePath, "");
  }

  /**
   * Removes one acknowledged event by id. Rewrites the whole file — fine at
   * the volumes a single machine's buffer accumulates during an outage; if
   * that stops being true, this is the method to replace with something
   * indexed.
   */
  remove(sourceEventId: string): void {
    const remaining = this.readAll().filter((e) => e.sourceEventId !== sourceEventId);
    writeFileSync(this.filePath, remaining.map((e) => JSON.stringify(e)).join("\n") + (remaining.length ? "\n" : ""));
  }

  get pendingCount(): number {
    return this.readAll().length;
  }
}
