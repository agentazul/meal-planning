import { eventLogs } from "~/db/schema";
import type { ScopedDatabase } from "~/server/context.server";

export async function logHouseholdEvent(
  scoped: ScopedDatabase,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  await scoped.db.insert(eventLogs).values({
    eventType,
    householdId: scoped.scope.householdId,
    payload,
  });
}
