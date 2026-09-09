import { runMigrations } from "../migrate.js";
import { createUser, type UserRole } from "../users-repository.js";
import { pool } from "../db.js";

async function main() {
  const [, , email, password, role] = process.argv;
  if (!email || !password || !role) {
    console.error("Usage: node dist/scripts/create-admin.js <email> <password> <role>");
    process.exit(1);
  }
  await runMigrations();
  const user = await createUser(email, password, role as UserRole);
  console.log(`Created user ${user.email} (${user.role})`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});