import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { normalizeIngredientLookup } from "~/data/ingredients";
import {
  canonicalIngredients,
  eventLogs,
  households,
  mealPlans,
  pantryCustomItems,
  pantryItems,
  pantryRestockBatches,
  planEntries,
  purchaseFormats,
  recipeIngredients,
  recipes,
} from "~/db/schema";
import { parseDateOnly } from "~/domain/dates";
import {
  aggregatePantryRequirements,
  CUSTOM_PANTRY_ITEM_NAME_MAX,
  normalizeCustomPantryItemName,
  PANTRY_QUANTITY_MAX,
  pantryBaseUnitForMeasurement,
  type PantryRequirementRow,
} from "~/domain/pantry";
import {
  convertPantryBaseQuantityToUnit,
  type PantryRestockBatchInput,
  type PantryRestockItemInput,
  PantryRestockValidationError,
  validatePantryRestockBatchInput,
} from "~/domain/pantry-restock";
import {
  convertToCanonical,
  UnitConversionError,
  type UsRecipeMeasurementUnit,
} from "~/domain/units";
import type { ScopedDatabase } from "~/server/context.server";
import { listPantryBalanceForecast } from "~/server/data/pantry-forecast.server";
import { lockPantryInventoryForecast } from "~/server/data/pantry-inventory-lock.server";

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
  defaultPurchaseQuantityInBaseUnit: number | null;
  densityGramsPerMl: number | null;
  gramsPerCount: number | null;
  id: string;
  isStaple: boolean;
  name: string;
  storageClass: "pantry" | "fridge" | "freezer" | "counter";
}>;

export type PantryInventoryItem = PantryCatalogItem &
  Readonly<{
    estimatedRecipeUsageInBaseUnit: number;
    quantity: number;
    quantityInBaseUnit: number;
    recordedQuantityInBaseUnit: number;
    recipeUsageThroughDate: string;
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

export type WeeklyGenerationPantryBalance = Readonly<{
  canonicalIngredientId: string;
  quantityInBaseUnit: number;
}>;

export type SetPantryItemCountInput = Readonly<{
  canonicalIngredientId: string;
  quantity: number;
  unit: UsRecipeMeasurementUnit;
}>;

/**
 * Returns the household's estimated canonical balances immediately before a
 * generated week. Past scheduled recipes after each balance checkpoint are
 * presumed used. A zero balance is retained because it means counted empty.
 */
export async function listWeeklyGenerationPantryBalances(
  scoped: ScopedDatabase,
  beforeDate: string,
): Promise<readonly WeeklyGenerationPantryBalance[]> {
  const rows = await listPantryBalanceForecast(scoped.db, {
    beforeDate,
    householdId: scoped.scope.householdId,
  });

  return rows.map((row) => ({
    canonicalIngredientId: row.canonicalIngredientId,
    quantityInBaseUnit: row.projectedQuantityInBaseUnit,
  }));
}

export type ApplyPantryRestockBatchInput = PantryRestockBatchInput;

export type ApplyPantryRestockBatchResult = Readonly<{
  appliedCount: number;
  duplicate: boolean;
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
  | "INVALID_UNIT"
  | "INVALID_RESTOCK_BATCH"
  | "PURCHASE_FORMAT_NOT_FOUND";

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
          defaultPurchaseQuantityInBaseUnit: purchaseFormats.quantityInBaseUnit,
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
            eq(purchaseFormats.canonicalIngredientId, canonicalIngredients.id),
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
          defaultPurchaseQuantityInBaseUnit: purchaseFormats.quantityInBaseUnit,
          densityGramsPerMl: canonicalIngredients.densityGramsPerMl,
          gramsPerCount: canonicalIngredients.gramsPerCount,
          id: canonicalIngredients.id,
          isStaple: canonicalIngredients.isStaple,
          name: canonicalIngredients.name,
          quantity: pantryItems.quantity,
          quantityInBaseUnit: pantryItems.quantityInBaseUnit,
          recipeUsageThroughDate: pantryItems.recipeUsageThroughDate,
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
            eq(purchaseFormats.canonicalIngredientId, canonicalIngredients.id),
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
            eq(planEntries.householdId, scoped.scope.householdId),
            eq(planEntries.mealPlanId, plan.id),
            eq(planEntries.status, "planned"),
          ),
        )
        .orderBy(asc(recipes.title), asc(recipeIngredients.position))
    : [];

  const pantryForecast = await listPantryBalanceForecast(scoped.db, {
    beforeDate: weekStart,
    householdId: scoped.scope.householdId,
  });
  const forecastByIngredientId = new Map(
    pantryForecast.map((item) => [item.canonicalIngredientId, item]),
  );
  const catalog = catalogRows.map((row): PantryCatalogItem => ({
    ...row,
    densityGramsPerMl: toOptionalNumber(row.densityGramsPerMl),
    defaultPurchaseQuantityInBaseUnit: toOptionalNumber(
      row.defaultPurchaseQuantityInBaseUnit,
    ),
    gramsPerCount: toOptionalNumber(row.gramsPerCount),
  }));
  const inventory = inventoryRows.map((row): PantryInventoryItem => {
    const densityGramsPerMl = toOptionalNumber(row.densityGramsPerMl);
    const gramsPerCount = toOptionalNumber(row.gramsPerCount);
    const forecast = forecastByIngredientId.get(row.id);
    const quantityInBaseUnit =
      forecast?.projectedQuantityInBaseUnit ?? Number(row.quantityInBaseUnit);
    return {
      ...row,
      densityGramsPerMl,
      defaultPurchaseQuantityInBaseUnit: toOptionalNumber(
        row.defaultPurchaseQuantityInBaseUnit,
      ),
      estimatedRecipeUsageInBaseUnit: forecast?.estimatedUsageInBaseUnit ?? 0,
      gramsPerCount,
      quantity: convertPantryBaseQuantityToUnit({
        baseUnit: row.baseUnit,
        densityGramsPerMl,
        gramsPerCount,
        quantityInBaseUnit,
        unit: row.unit as UsRecipeMeasurementUnit,
      }),
      quantityInBaseUnit,
      recordedQuantityInBaseUnit: Number(row.quantityInBaseUnit),
      recipeUsageThroughDate: row.recipeUsageThroughDate,
    };
  });
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
      quantity: Number(row.quantity),
      quantityInBaseUnit: Number(row.quantityInBaseUnit),
      scheduledDate: row.scheduledDate!,
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
    await lockPantryInventoryForecast(transaction, scoped.scope.householdId);
    const recipeUsageThroughDate = sql`(now() at time zone (select ${households.timezone} from ${households} where ${households.id} = ${scoped.scope.householdId}))::date`;
    await transaction
      .insert(pantryItems)
      .values({
        canonicalIngredientId: ingredient.id,
        householdId: scoped.scope.householdId,
        quantity: input.quantity.toFixed(3),
        quantityInBaseUnit: quantityInBaseUnit.toFixed(3),
        recipeUsageThroughDate,
        unit: input.unit,
        updatedByAppUserId: scoped.scope.userId,
      })
      .onConflictDoUpdate({
        set: {
          quantity: input.quantity.toFixed(3),
          quantityInBaseUnit: quantityInBaseUnit.toFixed(3),
          recipeUsageThroughDate,
          unit: input.unit,
          updatedAt: sql`now()`,
          updatedByAppUserId: scoped.scope.userId,
        },
        target: [pantryItems.householdId, pantryItems.canonicalIngredientId],
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

type RestockIngredient = Readonly<{
  baseUnit: "g" | "ml" | "count";
  defaultPurchaseQuantityInBaseUnit: string | null;
  densityGramsPerMl: string | null;
  gramsPerCount: string | null;
  id: string;
}>;

type PreparedRestockItem = Readonly<{
  displayQuantity: number;
  ingredient: RestockIngredient;
  input: PantryRestockItemInput;
  quantityInBaseUnit: number;
  unitInBaseUnit: number;
}>;

function invalidRestockBatch(message: string): PantryItemError {
  return new PantryItemError("INVALID_RESTOCK_BATCH", message);
}

function prepareRestockItem(
  input: PantryRestockItemInput,
  ingredient: RestockIngredient,
): PreparedRestockItem {
  const densityGramsPerMl = toOptionalNumber(ingredient.densityGramsPerMl);
  const gramsPerCount = toOptionalNumber(ingredient.gramsPerCount);
  const defaultPurchaseQuantityInBaseUnit = toOptionalNumber(
    ingredient.defaultPurchaseQuantityInBaseUnit,
  );

  if (input.quantity === null && defaultPurchaseQuantityInBaseUnit === null) {
    throw new PantryItemError(
      "PURCHASE_FORMAT_NOT_FOUND",
      "One of these ingredients does not have a default package size. Enter what you actually bought.",
    );
  }

  try {
    const quantityInBaseUnit =
      input.quantity === null
        ? defaultPurchaseQuantityInBaseUnit! * input.packageCount
        : convertPantryQuantity(
            input.quantity,
            input.unit,
            ingredient.baseUnit,
            densityGramsPerMl,
            gramsPerCount,
          );
    const displayQuantity =
      input.quantity ??
      convertPantryBaseQuantityToUnit({
        baseUnit: ingredient.baseUnit,
        densityGramsPerMl,
        gramsPerCount,
        quantityInBaseUnit,
        unit: input.unit,
      });
    const unitInBaseUnit = convertToCanonical({
      canonicalUnit: ingredient.baseUnit,
      densityGPerMl: densityGramsPerMl,
      gramsPerCount,
      quantity: 1,
      unit: input.unit,
    }).quantity;

    return {
      displayQuantity,
      ingredient,
      input,
      quantityInBaseUnit: Number(quantityInBaseUnit.toFixed(3)),
      unitInBaseUnit,
    };
  } catch (error) {
    if (error instanceof PantryItemError) throw error;
    if (error instanceof UnitConversionError || error instanceof RangeError) {
      throw new PantryItemError(
        "INVALID_UNIT",
        "Choose a measurement that matches every ingredient in this grocery update.",
      );
    }
    throw error;
  }
}

export async function applyPantryRestockBatch(
  scoped: ScopedDatabase,
  input: ApplyPantryRestockBatchInput,
): Promise<ApplyPantryRestockBatchResult> {
  try {
    validatePantryRestockBatchInput(input);
  } catch (error) {
    if (error instanceof PantryRestockValidationError) {
      throw invalidRestockBatch(
        "Review the grocery quantities and try adding them to the pantry again.",
      );
    }
    throw error;
  }

  return scoped.db.transaction(async (transaction) => {
    await lockPantryInventoryForecast(transaction, scoped.scope.householdId);
    const [createdBatch] = await transaction
      .insert(pantryRestockBatches)
      .values({
        appUserId: scoped.scope.userId,
        appliedCount: input.items.length,
        batchId: input.batchId,
        householdId: scoped.scope.householdId,
        weekStartDate: input.weekStart,
      })
      .onConflictDoNothing({ target: pantryRestockBatches.batchId })
      .returning({ batchId: pantryRestockBatches.batchId });
    if (!createdBatch) {
      const [existingBatch] = await transaction
        .select({
          appliedCount: pantryRestockBatches.appliedCount,
          householdId: pantryRestockBatches.householdId,
        })
        .from(pantryRestockBatches)
        .where(eq(pantryRestockBatches.batchId, input.batchId))
        .limit(1);
      if (!existingBatch) {
        throw new Error("Conflicting pantry restock batch was not found.");
      }
      if (existingBatch.householdId !== scoped.scope.householdId) {
        throw invalidRestockBatch(
          "This grocery update cannot be used for this household.",
        );
      }
      return {
        appliedCount: existingBatch.appliedCount,
        duplicate: true,
      };
    }

    const ingredientIds = input.items.map((item) => item.canonicalIngredientId);
    const ingredientRows = await transaction
      .select({
        baseUnit: canonicalIngredients.baseUnit,
        defaultPurchaseQuantityInBaseUnit: purchaseFormats.quantityInBaseUnit,
        densityGramsPerMl: canonicalIngredients.densityGramsPerMl,
        gramsPerCount: canonicalIngredients.gramsPerCount,
        id: canonicalIngredients.id,
      })
      .from(canonicalIngredients)
      .leftJoin(
        purchaseFormats,
        and(
          eq(purchaseFormats.canonicalIngredientId, canonicalIngredients.id),
          eq(purchaseFormats.isDefault, true),
        ),
      )
      .where(inArray(canonicalIngredients.id, ingredientIds));
    const ingredientsById = new Map(
      ingredientRows.map((ingredient) => [ingredient.id, ingredient]),
    );
    const preparedItems = input.items.map((item) => {
      const ingredient = ingredientsById.get(item.canonicalIngredientId);
      if (!ingredient) {
        throw new PantryItemError(
          "INGREDIENT_NOT_FOUND",
          "One of these ingredients is no longer in the kitchen catalog.",
        );
      }
      return prepareRestockItem(item, ingredient);
    });
    const pantryForecast = await listPantryBalanceForecast(transaction, {
      beforeDate: input.weekStart,
      householdId: scoped.scope.householdId,
    });
    const forecastByIngredientId = new Map(
      pantryForecast.map((item) => [item.canonicalIngredientId, item]),
    );
    const restockCheckpoint = parseDateOnly(input.weekStart)
      .subtract({ days: 1 })
      .toString();
    const appliedItems = preparedItems.map((item) => {
      const forecast = forecastByIngredientId.get(item.ingredient.id);
      const balanceBeforeInBaseUnit =
        forecast?.projectedQuantityInBaseUnit ?? 0;
      const balanceAfterInBaseUnit = Number(
        (item.input.inventoryMode === "purchase"
          ? balanceBeforeInBaseUnit + item.quantityInBaseUnit
          : item.quantityInBaseUnit
        ).toFixed(3),
      );
      validateQuantity(balanceAfterInBaseUnit);
      const recipeUsageThroughDate =
        forecast && forecast.recipeUsageThroughDate > restockCheckpoint
          ? forecast.recipeUsageThroughDate
          : restockCheckpoint;
      return {
        ...item,
        balanceAfterInBaseUnit,
        balanceBeforeInBaseUnit,
        estimatedRecipeUsageAppliedInBaseUnit:
          item.input.inventoryMode === "purchase"
            ? (forecast?.estimatedUsageInBaseUnit ?? 0)
            : 0,
        recipeUsageThroughDate,
        resultingDisplayQuantity: Number(
          (balanceAfterInBaseUnit / item.unitInBaseUnit).toFixed(3),
        ),
      };
    });

    for (const item of appliedItems) {
      await transaction
        .insert(pantryItems)
        .values({
          canonicalIngredientId: item.ingredient.id,
          householdId: scoped.scope.householdId,
          quantity: item.resultingDisplayQuantity.toFixed(3),
          quantityInBaseUnit: item.balanceAfterInBaseUnit.toFixed(3),
          recipeUsageThroughDate: item.recipeUsageThroughDate,
          unit: item.input.unit,
          updatedByAppUserId: scoped.scope.userId,
        })
        .onConflictDoUpdate({
          set: {
            quantity: item.resultingDisplayQuantity.toFixed(3),
            quantityInBaseUnit: item.balanceAfterInBaseUnit.toFixed(3),
            recipeUsageThroughDate: item.recipeUsageThroughDate,
            unit: item.input.unit,
            updatedAt: sql`now()`,
            updatedByAppUserId: scoped.scope.userId,
          },
          target: [pantryItems.householdId, pantryItems.canonicalIngredientId],
        });
    }

    await transaction.insert(eventLogs).values({
      eventType: "pantry.restock_batch_applied",
      householdId: scoped.scope.householdId,
      payload: {
        batchId: input.batchId,
        items: appliedItems.map((item) => ({
          balanceAfterInBaseUnit: item.balanceAfterInBaseUnit,
          balanceBeforeInBaseUnit: item.balanceBeforeInBaseUnit,
          canonicalIngredientId: item.ingredient.id,
          estimatedRecipeUsageAppliedInBaseUnit:
            item.estimatedRecipeUsageAppliedInBaseUnit,
          inventoryMode: item.input.inventoryMode,
          packageCount: item.input.packageCount,
          quantity: item.displayQuantity,
          quantityInBaseUnit: item.quantityInBaseUnit,
          recipeUsageThroughDate: item.recipeUsageThroughDate,
          unit: item.input.unit,
          usedDefaultPurchaseFormat: item.input.quantity === null,
        })),
        userId: scoped.scope.userId,
        weekStart: input.weekStart,
      },
    });

    return { appliedCount: preparedItems.length, duplicate: false };
  });
}
