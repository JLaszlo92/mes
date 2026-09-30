import type { MachineEvent, MachineStatusValue } from "@mes/shared";
import { pool } from "./db.js";

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

  /**
   * Induláskor (és csak induláskor) visszatölti minden gép LEGUTÓBBI
   * ismert állapotát — enélkül minden backend-újraindítás után minden gép
   * hamisan "idle"-nek látszana, amíg a következő valódi machine_status
   * esemény meg nem érkezik.
   *
   * Gépenként egy indexelt LIMIT 1 lekérdezés (korábban DISTINCT ON a
   * teljes státusztörténeten). Ha egy gépnek nincs megmaradt nyers
   * státuszeseménye (régóta hallgat, és a nyers adat a megőrzési időn túl
   * már törlődött), az utolsó ismert állapot az óránkénti összesítő utolsó
   * órájának domináns állapota.
   */
  async rehydrateStatuses(): Promise<void> {
    const result = await pool.query<{ machine_id: string; status: string; timestamp: Date }>(
      `SELECT m.id AS machine_id,
              COALESCE(ev.status, hr.status) AS status,
              COALESCE(ev.ts, hr.ts) AS "timestamp"
       FROM machines m
       LEFT JOIN LATERAL (
         SELECT payload->>'status' AS status, "timestamp" AS ts FROM events
         WHERE machine_id = m.id AND type = 'machine_status'
         ORDER BY "timestamp" DESC LIMIT 1
       ) ev ON true
       LEFT JOIN LATERAL (
         SELECT status, bucket_start + interval '1 hour' AS ts FROM machine_status_hourly
         WHERE machine_id = m.id
         ORDER BY bucket_start DESC, seconds DESC LIMIT 1
       ) hr ON ev.status IS NULL
       WHERE COALESCE(ev.status, hr.status) IS NOT NULL`,
    );
    for (const row of result.rows) {
      const state = this.getOrCreate(row.machine_id);
      state.status = row.status as MachineStatusValue;
      state.lastUpdated = new Date(row.timestamp).toISOString();
    }
  }

}


export const stateStore = new MachineStateStore();
