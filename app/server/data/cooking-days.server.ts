import { and, eq, inArray } from "drizzle-orm";

import { cookingDaysOff, eventLogs, households, planEntries } from "~/db/schema";
import { todayInTimezone } from "~/domain/dates";
import type { ScopedDatabase } from "~/server/context.server";
import { WeekPlannerError } from "~/server/data/week.server";

type SetCookingDayOffInput = Readonly<{ date: string }>;
type ClearCookingDayOffInput = Readonly<{ date: string }>;

async function assertDateNotInPast(
  scoped: ScopedDatabase,
  date: string,
): Promise<void> {
  const [household] = await scoped.db
    .select({ timezone: households.timezone })
    .from(households)
    .where(eq(households.id, scoped.scope.householdId))
    .limit(1);

  if (!household) {
    throw new Error("Household was not found.");
  }

  const today = todayInTimezone(household.timezone);

  if (date < today) {
    throw new WeekPlannerError(
      "PAST_DATE",
      "Choose today or a future date to turn off cooking.",
    );
  }
}

export async function setCookingDayOff(
  scoped: ScopedDatabase,
  input: SetCookingDayOffInput,
): Promise<void> {
  await assertDateNotInPast(scoped, input.date);

  const conflictingEntries = await scoped.db
    .select({ id: planEntries.id })
    .from(planEntries)
    .where(
      and(
        eq(planEntries.householdId, scoped.scope.householdId),
        eq(planEntries.scheduledDate, input.date),
        inArray(planEntries.status, ["planned", "cooked"]),
      ),
    )
    .limit(1);

  if (conflictingEntries.length > 0) {
    throw new WeekPlannerError(
      "DAY_HAS_DINNER",
      "Remove this dinner before turning the day off.",
    );
  }

  await scoped.db.transaction(async (transaction) => {
    await transaction
      .insert(cookingDaysOff)
      .values({
        createdByAppUserId: scoped.scope.userId,
        date: input.date,
        householdId: scoped.scope.householdId,
      })
      .onConflictDoNothing({
        target: [cookingDaysOff.householdId, cookingDaysOff.date],
      });

    await transaction.insert(eventLogs).values({
      eventType: "plan.day_off_set",
      householdId: scoped.scope.householdId,
      payload: {
        appUserId: scoped.scope.userId,
        date: input.date,
      },
    });
  });
}

export async function clearCookingDayOff(
  scoped: ScopedDatabase,
  input: ClearCookingDayOffInput,
): Promise<boolean> {
  return scoped.db.transaction(async (transaction) => {
    const [deleted] = await transaction
      .delete(cookingDaysOff)
      .where(
        and(
          eq(cookingDaysOff.householdId, scoped.scope.householdId),
          eq(cookingDaysOff.date, input.date),
        ),
      )
      .returning({ id: cookingDaysOff.id });

    if (!deleted) {
      return false;
    }

    await transaction.insert(eventLogs).values({
      eventType: "plan.day_off_cleared",
      householdId: scoped.scope.householdId,
      payload: {
        appUserId: scoped.scope.userId,
        date: input.date,
      },
    });

    return true;
  });
}
