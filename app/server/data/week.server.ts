import { and, asc, eq, gte, isNotNull } from "drizzle-orm";

import { eventLogs, households, mealPlans, planEntries } from "~/db/schema";
import {
  getWeekDates,
  getWeekStartDate,
  isDateInWeek,
  todayInTimezone,
} from "~/domain/dates";
import { resolvePresence } from "~/domain/presence";
import { calculateServingTarget, type ServingMember } from "~/domain/servings";
import type { ScopedDatabase } from "~/server/context.server";
import {
  listPresenceMembers,
  type PresenceMember,
} from "~/server/data/presence.server";
import {
  getHouseholdRecipe,
  listHouseholdRecipes,
  type RecipeListItem,
} from "~/server/data/recipes.server";

export type WeekPlannerMember = Readonly<{
  appetiteMultiplier: number;
  displayName: string;
  id: string;
  isPresent: boolean;
}>;

export type WeekPlannerEntry = Readonly<{
  id: string;
  leftoverBufferServings: number;
  recipeId: string;
  recipeTitle: string;
  status: "planned" | "bench" | "cooked" | "skipped" | "swapped_out";
  storedServingsTarget: number;
}>;

export type WeekPlannerDay = Readonly<{
  date: string;
  demand: number;
  entry: WeekPlannerEntry | null;
  members: readonly WeekPlannerMember[];
  servingsTarget: number;
}>;

export type WeekPlannerData = Readonly<{
  days: readonly WeekPlannerDay[];
  mealPlanId: string | null;
  mealPlanStatus: "draft" | "shopping" | "ordered" | "active" | "closed" | null;
  recipes: readonly RecipeListItem[];
  scheduledDinnerCount: number;
  weekStart: string;
}>;

export type WeekPlannerErrorCode =
  | "ENTRY_NOT_FOUND"
  | "INVALID_DATE"
  | "INVALID_LEFTOVER_BUFFER"
  | "INVALID_WEEK_START"
  | "NO_PRESENT_SERVINGS"
  | "RECIPE_NOT_FOUND";

export class WeekPlannerError extends Error {
  override readonly name = "WeekPlannerError";

  constructor(
    readonly code: WeekPlannerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type ScheduleRecipeInput = Readonly<{
  leftoverBufferServings: number;
  recipeId: string;
  scheduledDate: string;
  weekStart: string;
}>;

type RemovePlanEntryInput = Readonly<{
  entryId: string;
  weekStart: string;
}>;

export type RefreshPlanServingTargetsResult = Readonly<{
  updatedCount: number;
  zeroTargetCount: number;
}>;

function assertCanonicalWeekStart(weekStart: string): void {
  let normalized: string;

  try {
    normalized = getWeekStartDate(weekStart);
  } catch {
    throw new WeekPlannerError(
      "INVALID_DATE",
      "The selected week must use a valid YYYY-MM-DD date.",
    );
  }

  if (normalized !== weekStart) {
    throw new WeekPlannerError(
      "INVALID_WEEK_START",
      "The selected week must begin on Sunday.",
    );
  }
}

function assertDateBelongsToWeek(date: string, weekStart: string): void {
  try {
    if (isDateInWeek(date, weekStart)) return;
  } catch {
    throw new WeekPlannerError(
      "INVALID_DATE",
      "The dinner date must use a valid YYYY-MM-DD date.",
    );
  }

  throw new WeekPlannerError(
    "INVALID_DATE",
    "The dinner date must be within the selected week.",
  );
}

function toServingMembers(
  members: readonly PresenceMember[],
): readonly ServingMember[] {
  return members.map((member) => ({
    active: member.active,
    appetiteMultiplier: member.appetiteMultiplier,
    id: member.id,
    presenceOverrides: member.overrides,
    presenceRules: member.rules,
  }));
}

function calculateDayTarget(
  date: string,
  members: readonly PresenceMember[],
  leftoverBufferServings: number,
) {
  return calculateServingTarget({
    date,
    leftoverBufferServings,
    members: toServingMembers(members),
  });
}

export async function getWeekPlannerData(
  scoped: ScopedDatabase,
  weekStart: string,
): Promise<WeekPlannerData> {
  assertCanonicalWeekStart(weekStart);

  const dates = getWeekDates(weekStart);
  const weekEnd = dates.at(-1);
  if (!weekEnd) {
    throw new WeekPlannerError("INVALID_DATE", "The selected week is empty.");
  }

  const [members, recipes, plans] = await Promise.all([
    listPresenceMembers(scoped, { from: weekStart, to: weekEnd }),
    listHouseholdRecipes(scoped),
    scoped.db
      .select({
        id: mealPlans.id,
        status: mealPlans.status,
      })
      .from(mealPlans)
      .where(
        and(
          eq(mealPlans.householdId, scoped.scope.householdId),
          eq(mealPlans.weekStartDate, weekStart),
        ),
      )
      .limit(1),
  ]);

  const plan = plans[0] ?? null;
  const entryRows = plan
    ? await scoped.db
        .select({
          id: planEntries.id,
          leftoverBufferServings: planEntries.leftoverBufferServings,
          recipeId: planEntries.recipeId,
          scheduledDate: planEntries.scheduledDate,
          servingsTarget: planEntries.servingsTarget,
          status: planEntries.status,
        })
        .from(planEntries)
        .where(
          and(
            eq(planEntries.householdId, scoped.scope.householdId),
            eq(planEntries.mealPlanId, plan.id),
            isNotNull(planEntries.scheduledDate),
          ),
        )
        .orderBy(asc(planEntries.scheduledDate), asc(planEntries.createdAt))
    : [];

  const recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const entriesByDate = new Map(
    entryRows.flatMap((entry) =>
      entry.scheduledDate ? [[entry.scheduledDate, entry] as const] : [],
    ),
  );

  const days = dates.map((date): WeekPlannerDay => {
    const storedEntry = entriesByDate.get(date) ?? null;
    const leftoverBufferServings = storedEntry?.leftoverBufferServings ?? 0;
    const target = calculateDayTarget(date, members, leftoverBufferServings);
    const recipe = storedEntry
      ? (recipesById.get(storedEntry.recipeId) ?? null)
      : null;

    const entry = storedEntry
      ? {
          id: storedEntry.id,
          leftoverBufferServings: storedEntry.leftoverBufferServings,
          recipeId: storedEntry.recipeId,
          recipeTitle: recipe?.title ?? "Unavailable recipe",
          status: storedEntry.status,
          storedServingsTarget: storedEntry.servingsTarget,
        }
      : null;

    return {
      date,
      demand: target.demand,
      entry,
      members: members.map((member) => ({
        appetiteMultiplier: member.appetiteMultiplier,
        displayName: member.displayName,
        id: member.id,
        isPresent: resolvePresence({
          date,
          overrides: member.overrides,
          rules: member.rules,
        }).isPresent,
      })),
      servingsTarget: target.target,
    };
  });

  return {
    days,
    mealPlanId: plan?.id ?? null,
    mealPlanStatus: plan?.status ?? null,
    recipes,
    scheduledDinnerCount: days.filter((day) => day.entry !== null).length,
    weekStart,
  };
}

export async function scheduleRecipeForDate(
  scoped: ScopedDatabase,
  input: ScheduleRecipeInput,
): Promise<Readonly<{ entryId: string; replaced: boolean }>> {
  assertCanonicalWeekStart(input.weekStart);
  assertDateBelongsToWeek(input.scheduledDate, input.weekStart);

  if (
    !Number.isInteger(input.leftoverBufferServings) ||
    input.leftoverBufferServings < 0 ||
    input.leftoverBufferServings > 4
  ) {
    throw new WeekPlannerError(
      "INVALID_LEFTOVER_BUFFER",
      "Leftover servings must be a whole number from 0 to 4.",
    );
  }

  const [recipe, members] = await Promise.all([
    getHouseholdRecipe(scoped, input.recipeId),
    listPresenceMembers(scoped, {
      from: input.scheduledDate,
      to: input.scheduledDate,
    }),
  ]);

  if (!recipe) {
    throw new WeekPlannerError(
      "RECIPE_NOT_FOUND",
      "Choose a recipe from this household.",
    );
  }

  const target = calculateDayTarget(
    input.scheduledDate,
    members,
    input.leftoverBufferServings,
  );

  if (target.target < 1) {
    throw new WeekPlannerError(
      "NO_PRESENT_SERVINGS",
      "Add a leftover serving or update presence before scheduling this dinner.",
    );
  }

  return scoped.db.transaction(async (transaction) => {
    const [existingPlan] = await transaction
      .select({ id: mealPlans.id })
      .from(mealPlans)
      .where(
        and(
          eq(mealPlans.householdId, scoped.scope.householdId),
          eq(mealPlans.weekStartDate, input.weekStart),
        ),
      )
      .limit(1);

    let planId = existingPlan?.id;

    if (!planId) {
      const [createdPlan] = await transaction
        .insert(mealPlans)
        .values({
          householdId: scoped.scope.householdId,
          status: "draft",
          weekStartDate: input.weekStart,
        })
        .onConflictDoNothing({
          target: [mealPlans.householdId, mealPlans.weekStartDate],
        })
        .returning({ id: mealPlans.id });

      planId = createdPlan?.id;

      if (!planId) {
        const [concurrentPlan] = await transaction
          .select({ id: mealPlans.id })
          .from(mealPlans)
          .where(
            and(
              eq(mealPlans.householdId, scoped.scope.householdId),
              eq(mealPlans.weekStartDate, input.weekStart),
            ),
          )
          .limit(1);
        planId = concurrentPlan?.id;
      }
    }

    if (!planId) {
      throw new Error("Meal plan was not created.");
    }

    const [existingEntry] = await transaction
      .select({
        id: planEntries.id,
        recipeId: planEntries.recipeId,
      })
      .from(planEntries)
      .where(
        and(
          eq(planEntries.householdId, scoped.scope.householdId),
          eq(planEntries.mealPlanId, planId),
          eq(planEntries.scheduledDate, input.scheduledDate),
        ),
      )
      .limit(1);

    let entryId: string;
    let replaced = false;

    if (existingEntry) {
      const [updatedEntry] = await transaction
        .update(planEntries)
        .set({
          benchRank: null,
          leftoverBufferServings: input.leftoverBufferServings,
          recipeId: recipe.id,
          servingsTarget: target.target,
          status: "planned",
        })
        .where(
          and(
            eq(planEntries.householdId, scoped.scope.householdId),
            eq(planEntries.id, existingEntry.id),
          ),
        )
        .returning({ id: planEntries.id });

      if (!updatedEntry) {
        throw new Error("Plan entry was not updated.");
      }

      entryId = updatedEntry.id;
      replaced = true;

      await transaction.insert(eventLogs).values({
        eventType: "plan.entry_replaced",
        householdId: scoped.scope.householdId,
        payload: {
          date: input.scheduledDate,
          leftoverBufferServings: input.leftoverBufferServings,
          mealPlanId: planId,
          newRecipeId: recipe.id,
          planEntryId: entryId,
          previousRecipeId: existingEntry.recipeId,
          servingsTarget: target.target,
        },
      });
    } else {
      const [createdEntry] = await transaction
        .insert(planEntries)
        .values({
          householdId: scoped.scope.householdId,
          leftoverBufferServings: input.leftoverBufferServings,
          mealPlanId: planId,
          recipeId: recipe.id,
          scheduledDate: input.scheduledDate,
          servingsTarget: target.target,
          status: "planned",
        })
        .returning({ id: planEntries.id });

      if (!createdEntry) {
        throw new Error("Plan entry was not created.");
      }

      entryId = createdEntry.id;

      await transaction.insert(eventLogs).values({
        eventType: "plan.entry_scheduled",
        householdId: scoped.scope.householdId,
        payload: {
          date: input.scheduledDate,
          leftoverBufferServings: input.leftoverBufferServings,
          mealPlanId: planId,
          planEntryId: entryId,
          recipeId: recipe.id,
          servingsTarget: target.target,
        },
      });
    }

    return { entryId, replaced };
  });
}

export async function removePlanEntry(
  scoped: ScopedDatabase,
  input: RemovePlanEntryInput,
): Promise<void> {
  assertCanonicalWeekStart(input.weekStart);

  await scoped.db.transaction(async (transaction) => {
    const [entry] = await transaction
      .select({
        id: planEntries.id,
        mealPlanId: planEntries.mealPlanId,
        recipeId: planEntries.recipeId,
        scheduledDate: planEntries.scheduledDate,
      })
      .from(planEntries)
      .innerJoin(
        mealPlans,
        and(
          eq(mealPlans.householdId, planEntries.householdId),
          eq(mealPlans.id, planEntries.mealPlanId),
        ),
      )
      .where(
        and(
          eq(planEntries.householdId, scoped.scope.householdId),
          eq(planEntries.id, input.entryId),
          eq(mealPlans.householdId, scoped.scope.householdId),
          eq(mealPlans.weekStartDate, input.weekStart),
        ),
      )
      .limit(1);

    if (!entry?.scheduledDate) {
      throw new WeekPlannerError(
        "ENTRY_NOT_FOUND",
        "That scheduled dinner was not found in this week.",
      );
    }

    assertDateBelongsToWeek(entry.scheduledDate, input.weekStart);

    await transaction
      .delete(planEntries)
      .where(
        and(
          eq(planEntries.householdId, scoped.scope.householdId),
          eq(planEntries.id, entry.id),
        ),
      );

    await transaction.insert(eventLogs).values({
      eventType: "plan.entry_removed",
      householdId: scoped.scope.householdId,
      payload: {
        date: entry.scheduledDate,
        mealPlanId: entry.mealPlanId,
        planEntryId: entry.id,
        recipeId: entry.recipeId,
      },
    });
  });
}

export async function refreshPlanServingTargets(
  scoped: ScopedDatabase,
): Promise<RefreshPlanServingTargetsResult> {
  const [household] = await scoped.db
    .select({ timezone: households.timezone })
    .from(households)
    .where(eq(households.id, scoped.scope.householdId))
    .limit(1);

  if (!household) {
    throw new Error("Household was not found.");
  }

  const today = todayInTimezone(household.timezone);
  const rows = await scoped.db
    .select({
      id: planEntries.id,
      leftoverBufferServings: planEntries.leftoverBufferServings,
      scheduledDate: planEntries.scheduledDate,
      servingsTarget: planEntries.servingsTarget,
    })
    .from(planEntries)
    .where(
      and(
        eq(planEntries.householdId, scoped.scope.householdId),
        eq(planEntries.status, "planned"),
        isNotNull(planEntries.scheduledDate),
        gte(planEntries.scheduledDate, today),
      ),
    )
    .orderBy(asc(planEntries.scheduledDate), asc(planEntries.id));

  const scheduledRows = rows.flatMap((entry) =>
    entry.scheduledDate
      ? [{ ...entry, scheduledDate: entry.scheduledDate }]
      : [],
  );

  if (scheduledRows.length === 0) {
    return { updatedCount: 0, zeroTargetCount: 0 };
  }

  const through = scheduledRows.at(-1)?.scheduledDate ?? today;
  const members = await listPresenceMembers(scoped, {
    from: today,
    to: through,
  });
  const updates = scheduledRows.map((entry) => ({
    id: entry.id,
    target: calculateDayTarget(
      entry.scheduledDate,
      members,
      entry.leftoverBufferServings,
    ).target,
  }));
  const validUpdates = updates.filter(
    (update) =>
      rows.find((entry) => entry.id === update.id)?.servingsTarget !==
      update.target,
  );
  const zeroTargetCount = updates.filter(
    (update) => update.target === 0,
  ).length;

  if (validUpdates.length === 0) {
    return { updatedCount: 0, zeroTargetCount };
  }

  await scoped.db.transaction(async (transaction) => {
    for (const update of validUpdates) {
      await transaction
        .update(planEntries)
        .set({ servingsTarget: update.target })
        .where(
          and(
            eq(planEntries.householdId, scoped.scope.householdId),
            eq(planEntries.id, update.id),
          ),
        );
    }

    await transaction.insert(eventLogs).values({
      eventType: "plan.serving_targets_refreshed",
      householdId: scoped.scope.householdId,
      payload: {
        updatedCount: validUpdates.length,
        zeroTargetCount,
      },
    });
  });

  return {
    updatedCount: validUpdates.length,
    zeroTargetCount,
  };
}
