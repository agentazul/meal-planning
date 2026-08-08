import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { z } from "zod";

import { getPostgresConnectionOptions } from "../app/db/postgres-options";
import { loadLocalEnvironment } from "./load-env";

loadLocalEnvironment();

const connectionString = z
  .string()
  .min(1)
  .parse(
    process.env.DATABASE_DIRECT_URL ??
      process.env.DATABASE_URL_UNPOOLED ??
      process.env.DATABASE_URL,
  );

const client = postgres(
  connectionString,
  getPostgresConnectionOptions(connectionString),
);
const db = drizzle({ client });

try {
  await migrate(db, { migrationsFolder: "drizzle" });
  console.info("Database migrations applied successfully.");
} finally {
  await client.end();
}
