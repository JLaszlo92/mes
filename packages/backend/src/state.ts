import type { MachineEvent, MachineStatusValue } from "@mes/shared";

export interface MachineState {
  machineId: string;
  status: MachineStatusValue;
  goodCount: number;
  scrapCount: number;
  lastUpdated: string;
}

/**
 * Fast, in-memory "current state per machine" view — this is what a
 * dashboard actually wants (see PRD Section 5.7), rebuilt by replaying
 * events and kept current as new ones arrive. The Event table in Postgres
 * remains the source of truth (and is what a process restart rebuilds this
 * cache from); this class is a derived cache, not a second source of truth.
 */
class MachineStateStore {
  private readonly machines = new Map<string, MachineState>();

  private getOrCreate(machineId: string): MachineState {
    let state = this.machines.get(machineId);
    if (!state) {
      state = {
        machineId,
        status: "idle",
        goodCount: 0,
        scrapCount: 0,
        lastUpdated: new Date(0).toISOString(),
      };
      this.machines.set(machineId, state);
    }
    return state;
  }

  applyEvent(event: MachineEvent): MachineState {
    const state = this.getOrCreate(event.machineId);
    if (event.type === "machine_status") {
      state.status = event.status;
    } else if (event.type === "production_count") {
      if (event.result === "good") state.goodCount += 1;
      else state.scrapCount += 1;
    }
    state.lastUpdated = event.timestamp;
    return { ...state };
  }

  get(machineId: string): MachineState | undefined {
    const state = this.machines.get(machineId);
    return state ? { ...state } : undefined;
  }

  getAll(): MachineState[] {
    return [...this.machines.values()].map((s) => ({ ...s }));
  }
}

export const stateStore = new MachineStateStore();
