import { defineConfig } from "drizzle-kit";

import { loadLocalEnvironment } from "./scripts/load-env";

loadLocalEnvironment();

export default defineConfig({
  dialect: "postgresql",
  out: "./drizzle",
  schema: "./app/db/schema.ts",
  dbCredentials: {
    url:
      process.env.DATABASE_DIRECT_URL ??
      process.env.DATABASE_URL ??
      "postgresql://meal_planner:meal_planner@localhost:5432/meal_planner",
  },
  strict: true,
  verbose: true,
});
