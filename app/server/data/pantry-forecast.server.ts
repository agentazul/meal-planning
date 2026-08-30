import { and, asc, eq, gt, inArray, isNotNull, lt } from "drizzle-orm";

import {
  pantryItems,
  planEntries,
  recipeIngredients,
  recipes,
} from "~/db/schema";
import { parseDateOnly } from "~/domain/dates";
import {
  forecastPantryBalances,
  type PantryBalanceForecast,
  type PantryRecipeRequirement,
} from "~/domain/pantry";
import type { ScopedDatabase } from "~/server/context.server";
import type { PantryInventoryTransaction } from "~/server/data/pantry-inventory-lock.server";

type PantryForecastDatabase = ScopedDatabase["db"] | PantryInventoryTransaction;

/**
 * Estimates tracked pantry balances immediately before a date. Past scheduled
 * dinners are treated as presumed cooked because the current product does not
 * yet expose cooked/skipped confirmations. A per-item checkpoint prevents a
 * later manual count or reconciled grocery restock from replaying old usage.
 */
export async function listPantryBalanceForecast(
  database: PantryForecastDatabase,
  input: Readonly<{ beforeDate: string; householdId: string }>,
): Promise<readonly PantryBalanceForecast[]> {
  const beforeDate = parseDateOnly(input.beforeDate).toString();
  const balanceRows = await database
    .select({
      canonicalIngredientId: pantryItems.canonicalIngredientId,
      recordedQuantityInBaseUnit: pantryItems.quantityInBaseUnit,
      recipeUsageThroughDate: pantryItems.recipeUsageThroughDate,
    })
    .from(pantryItems)
    .where(eq(pantryItems.householdId, input.householdId))
    .orderBy(asc(pantryItems.canonicalIngredientId));

  if (balanceRows.length === 0) return [];

  const firstUnreconciledDate = balanceRows.reduce(
    (earliest, row) =>
      row.recipeUsageThroughDate < earliest
        ? row.recipeUsageThroughDate
        : earliest,
    balanceRows[0]!.recipeUsageThroughDate,
  );
  const requirementRows = await database
    .select({
      baseServings: recipes.baseServings,
      canonicalIngredientId: recipeIngredients.canonicalIngredientId,
      isOptional: recipeIngredients.isOptional,
      planEntryId: planEntries.id,
      preparation: recipeIngredients.preparation,
      quantity: recipeIngredients.quantity,
      quantityInBaseUnit: recipeIngredients.quantityInBaseUnit,
      recipeId: recipes.id,
      recipeIngredientId: recipeIngredients.id,
      recipeTitle: recipes.title,
      scalesLinearly: recipeIngredients.scalesLinearly,
      scheduledDate: planEntries.scheduledDate,
      servingsTarget: planEntries.servingsTarget,
      unit: recipeIngredients.unit,
    })
    .from(planEntries)
    .innerJoin(
      recipes,
      and(
        eq(recipes.householdId, planEntries.householdId),
        eq(recipes.id, planEntries.recipeId),
      ),
    )
    .innerJoin(
      recipeIngredients,
      and(
        eq(recipeIngredients.householdId, recipes.householdId),
        eq(recipeIngredients.recipeId, recipes.id),
      ),
    )
    .where(
      and(
        eq(planEntries.householdId, input.householdId),
        inArray(planEntries.status, ["planned", "cooked"]),
        isNotNull(planEntries.scheduledDate),
        gt(planEntries.scheduledDate, firstUnreconciledDate),
        lt(planEntries.scheduledDate, beforeDate),
      ),
    )
    .orderBy(asc(planEntries.scheduledDate), asc(recipeIngredients.position));

  const requirements = requirementRows.flatMap(
    (row): readonly PantryRecipeRequirement[] =>
      row.scheduledDate
        ? [
            {
              ...row,
              quantity: Number(row.quantity),
              quantityInBaseUnit: Number(row.quantityInBaseUnit),
              scheduledDate: row.scheduledDate,
            },
          ]
        : [],
  );

  return forecastPantryBalances({
    balances: balanceRows.map((row) => ({
      canonicalIngredientId: row.canonicalIngredientId,
      recordedQuantityInBaseUnit: Number(row.recordedQuantityInBaseUnit),
      recipeUsageThroughDate: row.recipeUsageThroughDate,
    })),
    beforeDate,
    requirements,
  });
}
