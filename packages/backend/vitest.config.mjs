import { defineConfig } from "vitest/config";

// The tests mock the database; some modules still read DATABASE_URL when they are
// imported. A real value from the environment wins.
export default defineConfig({
  test: {
    env: { DATABASE_URL: process.env.DATABASE_URL ?? "postgres://test@localhost/test" },
  },
});
