import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import { getServerEnv } from "~/server/env.server";
import { getPostgresConnectionOptions } from "./postgres-options";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema> & {
  $client: Sql;
};

export type RequestDatabase = Readonly<{
  close: () => Promise<void>;
  db: Database;
}>;

export function createRequestDatabase(): RequestDatabase {
  const connectionString = getServerEnv().DATABASE_URL;
  const client = postgres(
    connectionString,
    getPostgresConnectionOptions(connectionString),
  );
  const db = drizzle({ client, schema });

  return {
    db,
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}
