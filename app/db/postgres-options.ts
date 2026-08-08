export type PostgresConnectionOptions = Readonly<{
  max: number;
  prepare: false;
  ssl?: "verify-full";
}>;

export function getPostgresConnectionOptions(
  connectionString: string,
): PostgresConnectionOptions {
  const sslMode = new URL(connectionString).searchParams.get("sslmode");

  return {
    max: 1,
    prepare: false,
    ...(sslMode === "require" || sslMode === "verify-full"
      ? { ssl: "verify-full" as const }
      : {}),
  };
}
