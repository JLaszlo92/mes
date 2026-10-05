import type { FastifyInstance } from "fastify";
import { pool } from "./db.js";
import { requireRole } from "./auth-plugin.js";
import { shapeRelated } from "./machine-related.js";

/** GET /api/machine-registry/:id/related - counts of the configuration that belongs to a machine (admin/manager). */
export function registerMachineRelated(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>(
    "/api/machine-registry/:id/related",
    { preHandler: requireRole("admin", "manager") },
    async (request, reply) => {
      const id = request.params.id;
      const exists = await pool.query(`SELECT 1 FROM machines WHERE id = $1`, [id]);
      if ((exists.rowCount ?? 0) === 0) {
        reply.code(404);
        return { error: "unknown machine" };
      }
      const [counts, terminals] = await Promise.all([
        pool.query(
          `SELECT
             (SELECT count(*) FILTER (WHERE is_active) FROM machine_fault_codes WHERE machine_id = $1) AS fc_active,
             (SELECT count(*) FROM machine_fault_codes WHERE machine_id = $1) AS fc_total,
             (SELECT count(*) FILTER (WHERE is_active) FROM alert_rules WHERE machine_id = $1) AS ar_active,
             (SELECT count(*) FROM alert_rules WHERE machine_id = $1) AS ar_total,
             (SELECT count(*) FILTER (WHERE is_active) FROM alert_rules WHERE machine_id IS NULL) AS ar_global_active,
             (SELECT count(*) FILTER (WHERE is_active) FROM preventive_maintenance_schedules WHERE machine_id = $1) AS pm_active,
             (SELECT count(*) FROM preventive_maintenance_schedules WHERE machine_id = $1) AS pm_total`,
          [id],
        ),
        pool.query<{ id: string; name: string }>(
          `SELECT t.id, t.name
             FROM terminal_ui_machines tm
             JOIN terminal_uis t ON t.id = tm.terminal_ui_id
            WHERE tm.machine_id = $1
            ORDER BY t.name`,
          [id],
        ),
      ]);
      return shapeRelated(counts.rows[0] ?? {}, terminals.rows);
    },
  );
}
