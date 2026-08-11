import { and, asc, eq, sql } from "drizzle-orm";

import {
  canonicalIngredients,
  eventLogs,
  mealPlans,
  pantryItems,
  planEntries,
  purchaseFormats,
  recipeIngredients,
  recipes,
} from "~/db/schema";
import {
  aggregatePantryRequirements,
  PANTRY_QUANTITY_MAX,
  type PantryRequirementRow,
} from "~/domain/pantry";
import {
  convertToCanonical,
  UnitConversionError,
  type UsRecipeMeasurementUnit,
} from "~/domain/units";
import type { ScopedDatabase } from "~/server/context.server";

export type PantryCatalogItem = Readonly<{
  baseUnit: "g" | "ml" | "count";
  category:
    | "produce"
    | "protein"
    | "dairy"
    | "pantry"
    | "spice"
    | "frozen"
    | "bakery"
    | "other";
  defaultPurchaseDescription: string | null;
  densityGramsPerMl: number | null;
  gramsPerCount: number | null;
  id: string;
  isStaple: boolean;
  name: string;
  storageClass: "pantry" | "fridge" | "freezer" | "counter";
}>;

export type PantryInventoryItem = PantryCatalogItem &
  Readonly<{
    quantity: number;
    quantityInBaseUnit: number;
    unit: string;
    updatedAt: Date;
  }>;

export type PantryOverview = Readonly<{
  catalog: readonly PantryCatalogItem[];
  inventory: readonly PantryInventoryItem[];
  mealPlanId: string | null;
  mealPlanStatus: "draft" | "shopping" | "ordered" | "active" | "closed" | null;
  requirements: readonly PantryRequirementRow[];
  weekStart: string;
}>;

export type SetPantryItemCountInput = Readonly<{
  canonicalIngredientId: string;
  quantity: number;
  unit: UsRecipeMeasurementUnit;
}>;

export type PantryItemErrorCode =
  | "INGREDIENT_NOT_FOUND"
  | "INVALID_QUANTITY"
  | "INVALID_UNIT";

export class PantryItemError extends Error {
  override readonly name = "PantryItemError";

  constructor(
    readonly code: PantryItemErrorCode,
    readonly userMessage: string,
  ) {
    super(userMessage);
  }
}

function toOptionalNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

export async function getPantryOverview(
  scoped: ScopedDatabase,
  weekStart: string,
): Promise<PantryOverview> {
  const [catalogRows, inventoryRows, planRows] = await Promise.all([
    scoped.db
      .select({
        baseUnit: canonicalIngredients.baseUnit,
        category: canonicalIngredients.category,
        defaultPurchaseDescription: purchaseFormats.description,
        densityGramsPerMl: canonicalIngredients.densityGramsPerMl,
        gramsPerCount: canonicalIngredients.gramsPerCount,
        id: canonicalIngredients.id,
        isStaple: canonicalIngredients.isStaple,
        name: canonicalIngredients.name,
        storageClass: canonicalIngredients.storageClass,
      })
      .from(canonicalIngredients)
      .leftJoin(
        purchaseFormats,
        and(
          eq(
            purchaseFormats.canonicalIngredientId,
            canonicalIngredients.id,
          ),
          eq(purchaseFormats.isDefault, true),
        ),
      )
      .orderBy(
        asc(canonicalIngredients.category),
        asc(canonicalIngredients.name),
      ),
    scoped.db
      .select({
        baseUnit: canonicalIngredients.baseUnit,
        category: canonicalIngredients.category,
        defaultPurchaseDescription: purchaseFormats.description,
        densityGramsPerMl: canonicalIngredients.densityGramsPerMl,
        gramsPerCount: canonicalIngredients.gramsPerCount,
        id: canonicalIngredients.id,
        isStaple: canonicalIngredients.isStaple,
        name: canonicalIngredients.name,
        quantity: pantryItems.quantity,
        quantityInBaseUnit: pantryItems.quantityInBaseUnit,
        storageClass: canonicalIngredients.storageClass,
        unit: pantryItems.unit,
        updatedAt: pantryItems.updatedAt,
      })
      .from(pantryItems)
      .innerJoin(
        canonicalIngredients,
        eq(pantryItems.canonicalIngredientId, canonicalIngredients.id),
      )
      .leftJoin(
        purchaseFormats,
        and(
          eq(
            purchaseFormats.canonicalIngredientId,
            canonicalIngredients.id,
          ),
          eq(purchaseFormats.isDefault, true),
        ),
      )
      .where(eq(pantryItems.householdId, scoped.scope.householdId))
      .orderBy(
        asc(canonicalIngredients.storageClass),
        asc(canonicalIngredients.name),
      ),
    scoped.db
      .select({ id: mealPlans.id, status: mealPlans.status })
      .from(mealPlans)
      .where(
        and(
          eq(mealPlans.householdId, scoped.scope.householdId),
          eq(mealPlans.weekStartDate, weekStart),
        ),
      )
      .limit(1),
  ]);

  const plan = planRows[0] ?? null;
  const requirementRows = plan
    ? await scoped.db
        .select({
          baseServings: recipes.baseServings,
          canonicalIngredientId: recipeIngredients.canonicalIngredientId,
          isOptional: recipeIngredients.isOptional,
          quantityInBaseUnit: recipeIngredients.quantityInBaseUnit,
          recipeTitle: recipes.title,
          scalesLinearly: recipeIngredients.scalesLinearly,
          servingsTarget: planEntries.servingsTarget,
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
            eq(planEntries.householdId, scoped.scope.householdId),
            eq(planEntries.mealPlanId, plan.id),
            eq(planEntries.status, "planned"),
          ),
        )
        .orderBy(asc(recipes.title), asc(recipeIngredients.position))
    : [];

  const catalog = catalogRows.map(
    (row): PantryCatalogItem => ({
      ...row,
      densityGramsPerMl: toOptionalNumber(row.densityGramsPerMl),
      gramsPerCount: toOptionalNumber(row.gramsPerCount),
    }),
  );
  const inventory = inventoryRows.map(
    (row): PantryInventoryItem => ({
      ...row,
      densityGramsPerMl: toOptionalNumber(row.densityGramsPerMl),
      gramsPerCount: toOptionalNumber(row.gramsPerCount),
      quantity: Number(row.quantity),
      quantityInBaseUnit: Number(row.quantityInBaseUnit),
    }),
  );
  const requirements = aggregatePantryRequirements(
    requirementRows.map((row) => ({
      ...row,
      quantityInBaseUnit: Number(row.quantityInBaseUnit),
    })),
    inventory.map((item) => ({
      canonicalIngredientId: item.id,
      quantityInBaseUnit: item.quantityInBaseUnit,
    })),
  );

  return {
    catalog,
    inventory,
    mealPlanId: plan?.id ?? null,
    mealPlanStatus: plan?.status ?? null,
    requirements,
    weekStart,
  };
}

export async function setPantryItemCount(
  scoped: ScopedDatabase,
  input: SetPantryItemCountInput,
): Promise<Readonly<{ ingredientName: string; quantityInBaseUnit: number }>> {
  if (
    !Number.isFinite(input.quantity) ||
    input.quantity < 0 ||
    input.quantity > PANTRY_QUANTITY_MAX
  ) {
    throw new PantryItemError(
      "INVALID_QUANTITY",
      `Enter an amount from 0 to ${PANTRY_QUANTITY_MAX.toLocaleString("en-US")}.`,
    );
  }

  const [ingredient] = await scoped.db
    .select({
      baseUnit: canonicalIngredients.baseUnit,
      densityGramsPerMl: canonicalIngredients.densityGramsPerMl,
      gramsPerCount: canonicalIngredients.gramsPerCount,
      id: canonicalIngredients.id,
      name: canonicalIngredients.name,
    })
    .from(canonicalIngredients)
    .where(eq(canonicalIngredients.id, input.canonicalIngredientId))
    .limit(1);

  if (!ingredient) {
    throw new PantryItemError(
      "INGREDIENT_NOT_FOUND",
      "Choose an ingredient from the kitchen catalog.",
    );
  }

  let quantityInBaseUnit: number;
  try {
    const converted = convertToCanonical({
      canonicalUnit: ingredient.baseUnit,
      densityGPerMl: toOptionalNumber(ingredient.densityGramsPerMl),
      gramsPerCount: toOptionalNumber(ingredient.gramsPerCount),
      quantity: input.quantity,
      unit: input.unit,
    });
    quantityInBaseUnit = Number(converted.quantity.toFixed(3));
  } catch (error) {
    if (error instanceof UnitConversionError) {
      throw new PantryItemError(
        "INVALID_UNIT",
        "Choose a measurement that matches this ingredient.",
      );
    }
    throw error;
  }

  if (input.quantity > 0 && quantityInBaseUnit <= 0) {
    throw new PantryItemError(
      "INVALID_QUANTITY",
      "Enter a larger amount so it can be counted accurately.",
    );
  }

  await scoped.db.transaction(async (transaction) => {
    await transaction
      .insert(pantryItems)
      .values({
        canonicalIngredientId: ingredient.id,
        householdId: scoped.scope.householdId,
        quantity: input.quantity.toFixed(3),
        quantityInBaseUnit: quantityInBaseUnit.toFixed(3),
        unit: input.unit,
        updatedByAppUserId: scoped.scope.userId,
      })
      .onConflictDoUpdate({
        set: {
          quantity: input.quantity.toFixed(3),
          quantityInBaseUnit: quantityInBaseUnit.toFixed(3),
          unit: input.unit,
          updatedAt: sql`now()`,
          updatedByAppUserId: scoped.scope.userId,
        },
        target: [
          pantryItems.householdId,
          pantryItems.canonicalIngredientId,
        ],
      });

    await transaction.insert(eventLogs).values({
      eventType: "pantry.item_counted",
      householdId: scoped.scope.householdId,
      payload: {
        canonicalIngredientId: ingredient.id,
        quantityInBaseUnit,
        unit: input.unit,
        userId: scoped.scope.userId,
      },
    });
  });

  return { ingredientName: ingredient.name, quantityInBaseUnit };
}
