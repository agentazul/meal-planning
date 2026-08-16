import { and, asc, eq, sql } from "drizzle-orm";

import { normalizeIngredientLookup } from "~/data/ingredients";
import {
  canonicalIngredients,
  eventLogs,
  mealPlans,
  pantryCustomItems,
  pantryItems,
  planEntries,
  purchaseFormats,
  recipeIngredients,
  recipes,
} from "~/db/schema";
import {
  aggregatePantryRequirements,
  CUSTOM_PANTRY_ITEM_NAME_MAX,
  normalizeCustomPantryItemName,
  PANTRY_QUANTITY_MAX,
  pantryBaseUnitForMeasurement,
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

export type CustomPantryInventoryItem = Readonly<{
  baseUnit: "g" | "ml" | "count";
  id: string;
  name: string;
  quantity: number;
  quantityInBaseUnit: number;
  storageClass: "pantry" | "fridge" | "freezer" | "counter";
  unit: string;
  updatedAt: Date;
}>;

export type PantryOverview = Readonly<{
  catalog: readonly PantryCatalogItem[];
  customInventory: readonly CustomPantryInventoryItem[];
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

export type CreateCustomPantryItemInput = Readonly<{
  name: string;
  quantity: number;
  storageClass: CustomPantryInventoryItem["storageClass"];
  unit: UsRecipeMeasurementUnit;
}>;

export type SetCustomPantryItemCountInput = Readonly<{
  customPantryItemId: string;
  quantity: number;
  unit: UsRecipeMeasurementUnit;
}>;

export type PantryItemErrorCode =
  | "INGREDIENT_NOT_FOUND"
  | "DUPLICATE_CUSTOM_ITEM"
  | "INVALID_QUANTITY"
  | "INVALID_NAME"
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
  const [catalogRows, inventoryRows, customInventoryRows, planRows] =
    await Promise.all([
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
        .select({
        baseUnit: pantryCustomItems.baseUnit,
        id: pantryCustomItems.id,
        name: pantryCustomItems.name,
        quantity: pantryCustomItems.quantity,
        quantityInBaseUnit: pantryCustomItems.quantityInBaseUnit,
        storageClass: pantryCustomItems.storageClass,
        unit: pantryCustomItems.unit,
        updatedAt: pantryCustomItems.updatedAt,
      })
        .from(pantryCustomItems)
        .where(eq(pantryCustomItems.householdId, scoped.scope.householdId))
        .orderBy(
        asc(pantryCustomItems.storageClass),
        asc(pantryCustomItems.name),
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
  const customInventory = customInventoryRows.map(
    (row): CustomPantryInventoryItem => ({
      ...row,
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
    customInventory,
    inventory,
    mealPlanId: plan?.id ?? null,
    mealPlanStatus: plan?.status ?? null,
    requirements,
    weekStart,
  };
}

function validateQuantity(quantity: number): void {
  if (
    !Number.isFinite(quantity) ||
    quantity < 0 ||
    quantity > PANTRY_QUANTITY_MAX
  ) {
    throw new PantryItemError(
      "INVALID_QUANTITY",
      `Enter an amount from 0 to ${PANTRY_QUANTITY_MAX.toLocaleString("en-US")}.`,
    );
  }
}

function convertPantryQuantity(
  quantity: number,
  unit: UsRecipeMeasurementUnit,
  baseUnit: "g" | "ml" | "count",
  densityGramsPerMl: number | null = null,
  gramsPerCount: number | null = null,
): number {
  try {
    const converted = convertToCanonical({
      canonicalUnit: baseUnit,
      densityGPerMl: densityGramsPerMl,
      gramsPerCount,
      quantity,
      unit,
    });
    const quantityInBaseUnit = Number(converted.quantity.toFixed(3));
    if (quantity > 0 && quantityInBaseUnit <= 0) {
      throw new PantryItemError(
        "INVALID_QUANTITY",
        "Enter a larger amount so it can be counted accurately.",
      );
    }
    return quantityInBaseUnit;
  } catch (error) {
    if (error instanceof PantryItemError) throw error;
    if (error instanceof UnitConversionError) {
      throw new PantryItemError(
        "INVALID_UNIT",
        "Choose a measurement that matches this ingredient.",
      );
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

export async function createCustomPantryItem(
  scoped: ScopedDatabase,
  input: CreateCustomPantryItemInput,
): Promise<
  Readonly<{ id: string; ingredientName: string; quantityInBaseUnit: number }>
> {
  const name = input.name.normalize("NFKC").trim().replace(/\s+/g, " ");
  const nameKey = normalizeCustomPantryItemName(name);
  if (!nameKey || name.length > CUSTOM_PANTRY_ITEM_NAME_MAX) {
    throw new PantryItemError(
      "INVALID_NAME",
      `Enter an ingredient name from 1 to ${CUSTOM_PANTRY_ITEM_NAME_MAX} characters.`,
    );
  }
  validateQuantity(input.quantity);

  const canonicalRows = await scoped.db
    .select({
      aliases: canonicalIngredients.aliases,
      name: canonicalIngredients.name,
    })
    .from(canonicalIngredients);
  const canonicalLookup = normalizeIngredientLookup(name);
  const matchesCanonical = canonicalRows.some((ingredient) =>
    [ingredient.name, ...ingredient.aliases].some(
      (candidate) => normalizeIngredientLookup(candidate) === canonicalLookup,
    ),
  );
  if (matchesCanonical) {
    throw new PantryItemError(
      "DUPLICATE_CUSTOM_ITEM",
      "That ingredient is already in the kitchen catalog. Choose it from the list instead.",
    );
  }

  const baseUnit = pantryBaseUnitForMeasurement(input.unit);
  const quantityInBaseUnit = convertPantryQuantity(
    input.quantity,
    input.unit,
    baseUnit,
  );

  try {
    return await scoped.db.transaction(async (transaction) => {
      const [created] = await transaction
        .insert(pantryCustomItems)
        .values({
          baseUnit,
          householdId: scoped.scope.householdId,
          name,
          nameKey,
          quantity: input.quantity.toFixed(3),
          quantityInBaseUnit: quantityInBaseUnit.toFixed(3),
          storageClass: input.storageClass,
          unit: input.unit,
          updatedByAppUserId: scoped.scope.userId,
        })
        .returning({ id: pantryCustomItems.id });
      if (!created) throw new Error("Custom pantry item was not created");

      await transaction.insert(eventLogs).values({
        eventType: "pantry.custom_item_created",
        householdId: scoped.scope.householdId,
        payload: {
          customPantryItemId: created.id,
          quantityInBaseUnit,
          unit: input.unit,
          userId: scoped.scope.userId,
        },
      });
      return { id: created.id, ingredientName: name, quantityInBaseUnit };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PantryItemError(
        "DUPLICATE_CUSTOM_ITEM",
        "That custom item is already in your pantry. Choose it from the list to update its count.",
      );
    }
    throw error;
  }
}

export async function setCustomPantryItemCount(
  scoped: ScopedDatabase,
  input: SetCustomPantryItemCountInput,
): Promise<Readonly<{ ingredientName: string; quantityInBaseUnit: number }>> {
  validateQuantity(input.quantity);
  const [item] = await scoped.db
    .select({
      baseUnit: pantryCustomItems.baseUnit,
      id: pantryCustomItems.id,
      name: pantryCustomItems.name,
    })
    .from(pantryCustomItems)
    .where(
      and(
        eq(pantryCustomItems.id, input.customPantryItemId),
        eq(pantryCustomItems.householdId, scoped.scope.householdId),
      ),
    )
    .limit(1);
  if (!item) {
    throw new PantryItemError(
      "INGREDIENT_NOT_FOUND",
      "Choose a custom item from your pantry.",
    );
  }

  const quantityInBaseUnit = convertPantryQuantity(
    input.quantity,
    input.unit,
    item.baseUnit,
  );
  await scoped.db.transaction(async (transaction) => {
    await transaction
      .update(pantryCustomItems)
      .set({
        quantity: input.quantity.toFixed(3),
        quantityInBaseUnit: quantityInBaseUnit.toFixed(3),
        unit: input.unit,
        updatedAt: sql`now()`,
        updatedByAppUserId: scoped.scope.userId,
      })
      .where(
        and(
          eq(pantryCustomItems.id, item.id),
          eq(pantryCustomItems.householdId, scoped.scope.householdId),
        ),
      );
    await transaction.insert(eventLogs).values({
      eventType: "pantry.custom_item_counted",
      householdId: scoped.scope.householdId,
      payload: {
        customPantryItemId: item.id,
        quantityInBaseUnit,
        unit: input.unit,
        userId: scoped.scope.userId,
      },
    });
  });
  return { ingredientName: item.name, quantityInBaseUnit };
}

export async function setPantryItemCount(
  scoped: ScopedDatabase,
  input: SetPantryItemCountInput,
): Promise<Readonly<{ ingredientName: string; quantityInBaseUnit: number }>> {
  validateQuantity(input.quantity);

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

  const quantityInBaseUnit = convertPantryQuantity(
    input.quantity,
    input.unit,
    ingredient.baseUnit,
    toOptionalNumber(ingredient.densityGramsPerMl),
    toOptionalNumber(ingredient.gramsPerCount),
  );

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
