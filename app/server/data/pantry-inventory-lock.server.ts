import { sql } from "drizzle-orm";

import type { ScopedDatabase } from "~/server/context.server";

export type PantryInventoryTransaction = Parameters<
  Parameters<ScopedDatabase["db"]["transaction"]>[0]
>[0];

/**
 * Serializes every write that can change a pantry forecast. Pantry counts,
 * grocery restocks, scheduled recipe commitments, and weekly draft
 * publication all use the same household-scoped lock.
 */
export async function lockPantryInventoryForecast(
  transaction: PantryInventoryTransaction,
  householdId: string,
): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`weekly-generation-pantry:${householdId}`}, 0))`,
  );
}
