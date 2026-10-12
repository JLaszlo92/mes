import { runMigrations } from "../migrate.js";
import { createUser } from "../users-repository.js";
import { pool } from "../db.js";

/**
 * Usage: node dist/scripts/create-admin.js <email> <password> [role] [name]
 * The role is a role id (admin, planner, operator, …); default admin.
 */
async function main() {
  const [, , email, password, role = "admin", name] = process.argv;
  if (!email || !password) {
    console.error("Usage: node dist/scripts/create-admin.js <email> <password> [role] [name]");
    process.exit(1);
  }
  await runMigrations();
  const user = await createUser({ email, password, role, displayName: name ?? null });
  console.log(`Created user ${user.email} (${user.roleName})`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
