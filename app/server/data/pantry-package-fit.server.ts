import { createHash } from "node:crypto";

import { and, asc, eq, sql } from "drizzle-orm";

import {
  canonicalIngredients,
  eventLogs,
  mealPlans,
  pantryItems,
  pantryPackageFitChoices,
  planEntries,
  purchaseFormats,
  recipeIngredients,
  recipes,
  type RecipeStep,
} from "~/db/schema";
import { analyzePantryPackageFit } from "~/domain/pantry-package-fit";
import { aggregatePantryRequirements } from "~/domain/pantry";
import {
  convertToCanonical,
  UnitConversionError,
  US_RECIPE_MEASUREMENT_UNITS,
  type UsRecipeMeasurementUnit,
} from "~/domain/units";
import type { ScopedDatabase } from "~/server/context.server";
import {
  RecipePackageFitEditError,
  updateRecipeIngredientForPackageFit,
} from "~/server/data/recipes.server";

export type PantryPackageFitChoiceKind =
  | "keep_recipe_buy_enough"
  | "custom_store_amount";

export type PantryPackageFitBasis = Readonly<{
  basisHash: string;
  currentQuantityInBaseUnit: number | null;
  defaultPurchaseQuantityInBaseUnit: number | null;
  neededQuantityInBaseUnit: number;
  requiredQuantityInBaseUnit: number;
}>;

export type PantryPackageFitChoice = PantryPackageFitBasis &
  Readonly<{
    canonicalIngredientId: string;
    customLabel: string | null;
    customQuantity: number | null;
    customQuantityInBaseUnit: number | null;
    customUnit: string | null;
    kind: PantryPackageFitChoiceKind;
    mealPlanId: string;
    revision: number;
    updatedAt: Date;
  }>;

export type PantryPackageFitContributor = Readonly<{
  baseServings: number;
  instructions: readonly RecipeStep[];
  planEntryId: string;
  plannedServings: number;
  perServingAfter: number | null;
  perServingBefore: number;
  preparation: string | null;
  quantity: number;
  quantityInBaseUnit: number;
  recipeId: string;
  recipeIngredientId: string;
  recipeTitle: string;
  recipeUpdatedAt: Date;
  scalesLinearly: boolean;
  scheduledDate: string | null;
  scheduledDates: readonly string[];
  suggestedQuantity: number | null;
  methodReferenceRisk: boolean;
  unit: UsRecipeMeasurementUnit;
}>;

export type PantryPackageFitMismatch = Omit<
  PantryPackageFitBasis,
  "currentQuantityInBaseUnit"
> &
  Readonly<{
    baseUnit: "g" | "ml" | "count";
    canonicalIngredientId: string;
    choice: PantryPackageFitChoice | null;
    compatibleUnits: readonly UsRecipeMeasurementUnit[];
    contributors: readonly PantryPackageFitContributor[];
    defaultPurchaseDescription: string;
    gramsPerCount: number | null;
    ingredientName: string;
    packageCount: number;
    projectedQuantityInBaseUnit: number;
    currentQuantityInBaseUnit: number;
    risk: "food_safety" | "recipe_structure" | "standard";
    surplusQuantityInBaseUnit: number;
  }>;

export type PantryPackageFitReview = Readonly<{
  mealPlanId: string | null;
  mismatches: readonly PantryPackageFitMismatch[];
  weekStart: string;
}>;

export type UpsertPantryPackageFitChoiceInput =
  | Readonly<{
      canonicalIngredientId: string;
      expectedBasisHash: string;
      kind: "keep_recipe_buy_enough";
      mealPlanId: string;
    }>
  | Readonly<{
      canonicalIngredientId: string;
      expectedBasisHash: string;
      kind: "custom_store_amount";
      mealPlanId: string;
      quantity: number;
      shoppingLabel?: string | null;
      unit: UsRecipeMeasurementUnit;
    }>;

export type ResolvePantryPackageFitInput =
  | Readonly<{
      canonicalIngredientId: string;
      expectedBasisHash: string;
      intent: "keep-recipe";
      mealPlanId: string;
    }>
  | Readonly<{
      canonicalIngredientId: string;
      expectedBasisHash: string;
      intent: "alternate-store";
      mealPlanId: string;
      quantity: number;
      shoppingLabel?: string | null;
      unit: UsRecipeMeasurementUnit;
    }>
  | Readonly<{
      acknowledgedPermanentChange: true;
      expectedRecipeUpdatedAt: Date | string;
      instructions: readonly RecipeStep[];
      intent: "edit-saved-recipe";
      quantity: number;
      recipeId: string;
      recipeIngredientId: string;
      unit: UsRecipeMeasurementUnit;
    }>;

export type PantryPackageFitErrorCode =
  | "CHOICE_NOT_FOUND"
  | "CUSTOM_AMOUNT_INSUFFICIENT"
  | "INVALID_INPUT"
  | "MEAL_PLAN_NOT_FOUND"
  | "STALE_BASIS"
  | "UNIT_NOT_COMPATIBLE";

export class PantryPackageFitError extends Error {
  override readonly name = "PantryPackageFitError";

  constructor(
    readonly code: PantryPackageFitErrorCode,
    readonly userMessage: string,
  ) {
    super(userMessage);
  }
}

type BasisContext = PantryPackageFitBasis &
  Readonly<{
    baseUnit: "g" | "ml" | "count";
    canonicalIngredientId: string;
    defaultPurchaseDescription: string | null;
    densityGramsPerMl: number | null;
    gramsPerCount: number | null;
    ingredientName: string;
    mealPlanId: string;
  }>;

function roundQuantity(value: number): number {
  return Number(value.toFixed(3));
}

function hashBasis(input: {
  canonicalIngredientId: string;
  currentQuantityInBaseUnit: number | null;
  defaultPurchaseQuantityInBaseUnit: number | null;
  densityGramsPerMl: number | null;
  gramsPerCount: number | null;
  mealPlanId: string;
  neededQuantityInBaseUnit: number;
  requiredQuantityInBaseUnit: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        canonicalIngredientId: input.canonicalIngredientId,
        currentQuantityInBaseUnit: input.currentQuantityInBaseUnit,
        defaultPurchaseQuantityInBaseUnit:
          input.defaultPurchaseQuantityInBaseUnit,
        densityGramsPerMl: input.densityGramsPerMl,
        gramsPerCount: input.gramsPerCount,
        mealPlanId: input.mealPlanId,
        neededQuantityInBaseUnit: input.neededQuantityInBaseUnit,
        requiredQuantityInBaseUnit: input.requiredQuantityInBaseUnit,
      }),
    )
    .digest("hex");
}

function compatibleUnits(
  baseUnit: "g" | "ml" | "count",
  densityGramsPerMl: number | null,
  gramsPerCount: number | null,
): readonly UsRecipeMeasurementUnit[] {
  if (baseUnit === "count") return ["count"];
  if (baseUnit === "g") {
    return [
      "oz",
      "lb",
      ...(densityGramsPerMl ? (["tsp", "tbsp", "cup", "fl_oz"] as const) : []),
      ...(gramsPerCount ? (["count"] as const) : []),
    ];
  }
  return [
    "tsp",
    "tbsp",
    "cup",
    "fl_oz",
    ...(densityGramsPerMl ? (["oz", "lb"] as const) : []),
  ];
}

function isUsRecipeUnit(value: string): value is UsRecipeMeasurementUnit {
  return US_RECIPE_MEASUREMENT_UNITS.includes(
    value as UsRecipeMeasurementUnit,
  );
}

async function getBasisContext(
  scoped: ScopedDatabase,
  mealPlanId: string,
  canonicalIngredientId: string,
): Promise<BasisContext> {
  const [plan] = await scoped.db
    .select({ id: mealPlans.id })
    .from(mealPlans)
    .where(
      and(
        eq(mealPlans.id, mealPlanId),
        eq(mealPlans.householdId, scoped.scope.householdId),
      ),
    )
    .limit(1);
  if (!plan) {
    throw new PantryPackageFitError(
      "MEAL_PLAN_NOT_FOUND",
      "That meal plan is no longer available for this household.",
    );
  }

  const [ingredient, requirements, inventory] = await Promise.all([
    scoped.db
      .select({
        baseUnit: canonicalIngredients.baseUnit,
        defaultPurchaseDescription: purchaseFormats.description,
        defaultPurchaseQuantityInBaseUnit: purchaseFormats.quantityInBaseUnit,
        densityGramsPerMl: canonicalIngredients.densityGramsPerMl,
        gramsPerCount: canonicalIngredients.gramsPerCount,
        ingredientName: canonicalIngredients.name,
      })
      .from(canonicalIngredients)
      .leftJoin(
        purchaseFormats,
        and(
          eq(purchaseFormats.canonicalIngredientId, canonicalIngredients.id),
          eq(purchaseFormats.isDefault, true),
        ),
      )
      .where(eq(canonicalIngredients.id, canonicalIngredientId))
      .limit(1),
    scoped.db
      .select({
        baseServings: recipes.baseServings,
        isOptional: recipeIngredients.isOptional,
        quantityInBaseUnit: recipeIngredients.quantityInBaseUnit,
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
          eq(planEntries.mealPlanId, mealPlanId),
          eq(planEntries.status, "planned"),
          eq(recipeIngredients.canonicalIngredientId, canonicalIngredientId),
        ),
      ),
    scoped.db
      .select({ quantityInBaseUnit: pantryItems.quantityInBaseUnit })
      .from(pantryItems)
      .where(
        and(
          eq(pantryItems.householdId, scoped.scope.householdId),
          eq(pantryItems.canonicalIngredientId, canonicalIngredientId),
        ),
      )
      .limit(1),
  ]);

  const ingredientRow = ingredient[0];
  if (!ingredientRow || requirements.length === 0) {
    throw new PantryPackageFitError(
      "CHOICE_NOT_FOUND",
      "That ingredient is no longer required by this meal plan.",
    );
  }
  const requiredQuantityInBaseUnit = roundQuantity(
    requirements.reduce((total, row) => {
      if (row.isOptional || row.servingsTarget === 0) return total;
      const quantity = Number(row.quantityInBaseUnit);
      return (
        total +
        (row.scalesLinearly
          ? quantity * (row.servingsTarget / row.baseServings)
          : quantity)
      );
    }, 0),
  );
  const currentQuantityInBaseUnit = inventory[0]
    ? Number(inventory[0].quantityInBaseUnit)
    : null;
  const neededQuantityInBaseUnit = roundQuantity(
    Math.max(
      requiredQuantityInBaseUnit - (currentQuantityInBaseUnit ?? 0),
      0,
    ),
  );
  const defaultPurchaseQuantityInBaseUnit =
    ingredientRow.defaultPurchaseQuantityInBaseUnit === null
      ? null
      : Number(ingredientRow.defaultPurchaseQuantityInBaseUnit);
  const basis = {
    currentQuantityInBaseUnit,
    defaultPurchaseQuantityInBaseUnit,
    neededQuantityInBaseUnit,
    requiredQuantityInBaseUnit,
  };
  const densityGramsPerMl =
    ingredientRow.densityGramsPerMl === null
      ? null
      : Number(ingredientRow.densityGramsPerMl);
  const gramsPerCount =
    ingredientRow.gramsPerCount === null
      ? null
      : Number(ingredientRow.gramsPerCount);

  return {
    ...basis,
    baseUnit: ingredientRow.baseUnit,
    basisHash: hashBasis({
      ...basis,
      canonicalIngredientId,
      densityGramsPerMl,
      gramsPerCount,
      mealPlanId,
    }),
    canonicalIngredientId,
    defaultPurchaseDescription: ingredientRow.defaultPurchaseDescription,
    densityGramsPerMl,
    gramsPerCount,
    ingredientName: ingredientRow.ingredientName,
    mealPlanId,
  };
}

function mapChoiceRow(row: typeof pantryPackageFitChoices.$inferSelect): PantryPackageFitChoice {
  return {
    basisHash: row.basisHash,
    canonicalIngredientId: row.canonicalIngredientId,
    currentQuantityInBaseUnit:
      row.basisCurrentQuantityInBaseUnit === null
        ? null
        : Number(row.basisCurrentQuantityInBaseUnit),
    customLabel: row.customLabel,
    customQuantity: row.customQuantity === null ? null : Number(row.customQuantity),
    customQuantityInBaseUnit:
      row.customQuantityInBaseUnit === null
        ? null
        : Number(row.customQuantityInBaseUnit),
    customUnit: row.customUnit,
    defaultPurchaseQuantityInBaseUnit:
      row.basisDefaultPurchaseQuantityInBaseUnit === null
        ? null
        : Number(row.basisDefaultPurchaseQuantityInBaseUnit),
    kind: row.kind,
    mealPlanId: row.mealPlanId,
    neededQuantityInBaseUnit: Number(row.basisNeededQuantityInBaseUnit),
    requiredQuantityInBaseUnit: Number(row.basisRequiredQuantityInBaseUnit),
    revision: row.revision,
    updatedAt: row.updatedAt,
  };
}

export async function loadPantryPackageFitChoices(
  scoped: ScopedDatabase,
  mealPlanId: string,
): Promise<readonly PantryPackageFitChoice[]> {
  const [plan] = await scoped.db
    .select({ id: mealPlans.id })
    .from(mealPlans)
    .where(
      and(
        eq(mealPlans.id, mealPlanId),
        eq(mealPlans.householdId, scoped.scope.householdId),
      ),
    )
    .limit(1);
  if (!plan) {
    throw new PantryPackageFitError(
      "MEAL_PLAN_NOT_FOUND",
      "That meal plan is no longer available for this household.",
    );
  }

  const rows = await scoped.db
    .select()
    .from(pantryPackageFitChoices)
    .where(
      and(
        eq(pantryPackageFitChoices.householdId, scoped.scope.householdId),
        eq(pantryPackageFitChoices.mealPlanId, mealPlanId),
      ),
    )
    .orderBy(asc(pantryPackageFitChoices.updatedAt));
  const validity = await Promise.all(
    rows.map(async (row) => {
      try {
        const current = await getBasisContext(
          scoped,
          mealPlanId,
          row.canonicalIngredientId,
        );
        return current.basisHash === row.basisHash ? mapChoiceRow(row) : null;
      } catch (error) {
        if (error instanceof PantryPackageFitError) return null;
        throw error;
      }
    }),
  );
  return validity.filter((choice): choice is PantryPackageFitChoice => choice !== null);
}

export async function upsertPantryPackageFitChoice(
  scoped: ScopedDatabase,
  input: UpsertPantryPackageFitChoiceInput,
): Promise<PantryPackageFitChoice> {
  if (!/^[a-f0-9]{64}$/.test(input.expectedBasisHash)) {
    throw new PantryPackageFitError(
      "INVALID_INPUT",
      "Refresh the package comparison and try again.",
    );
  }
  const basis = await getBasisContext(
    scoped,
    input.mealPlanId,
    input.canonicalIngredientId,
  );
  if (basis.basisHash !== input.expectedBasisHash) {
    throw new PantryPackageFitError(
      "STALE_BASIS",
      "The recipe or pantry changed on another device. Review the updated amounts before choosing.",
    );
  }

  let custom:
    | Readonly<{
        label: string;
        quantity: number;
        quantityInBaseUnit: number;
        unit: UsRecipeMeasurementUnit;
      }>
    | undefined;
  if (input.kind === "custom_store_amount") {
    const label = input.shoppingLabel?.trim() || `${input.quantity} ${input.unit}`;
    if (
      !Number.isFinite(input.quantity) ||
      input.quantity <= 0 ||
      input.quantity > 1_000_000 ||
      label.length > 100
    ) {
      throw new PantryPackageFitError(
        "INVALID_INPUT",
        "Enter a valid store amount and a short shopping label.",
      );
    }
    let quantityInBaseUnit: number;
    try {
      quantityInBaseUnit = roundQuantity(
        convertToCanonical({
          canonicalUnit: basis.baseUnit,
          densityGPerMl: basis.densityGramsPerMl,
          gramsPerCount: basis.gramsPerCount,
          quantity: input.quantity,
          unit: input.unit,
        }).quantity,
      );
    } catch (error) {
      if (error instanceof UnitConversionError) {
        throw new PantryPackageFitError(
          "UNIT_NOT_COMPATIBLE",
          "Choose a store amount that can be converted for this ingredient.",
        );
      }
      throw error;
    }
    if (quantityInBaseUnit + 0.001 < basis.neededQuantityInBaseUnit) {
      throw new PantryPackageFitError(
        "CUSTOM_AMOUNT_INSUFFICIENT",
        "That store amount does not cover what the current recipes still need.",
      );
    }
    custom = {
      label,
      quantity: input.quantity,
      quantityInBaseUnit,
      unit: input.unit,
    };
  }

  return scoped.db.transaction(async (transaction) => {
    const [saved] = await transaction
      .insert(pantryPackageFitChoices)
      .values({
        basisCurrentQuantityInBaseUnit:
          basis.currentQuantityInBaseUnit?.toFixed(3) ?? null,
        basisDefaultPurchaseQuantityInBaseUnit:
          basis.defaultPurchaseQuantityInBaseUnit?.toFixed(3) ?? null,
        basisHash: basis.basisHash,
        basisNeededQuantityInBaseUnit: basis.neededQuantityInBaseUnit.toFixed(3),
        basisRequiredQuantityInBaseUnit:
          basis.requiredQuantityInBaseUnit.toFixed(3),
        canonicalIngredientId: input.canonicalIngredientId,
        createdByAppUserId: scoped.scope.userId,
        customLabel: custom?.label ?? null,
        customQuantity: custom?.quantity.toFixed(3) ?? null,
        customQuantityInBaseUnit:
          custom?.quantityInBaseUnit.toFixed(3) ?? null,
        customUnit: custom?.unit ?? null,
        householdId: scoped.scope.householdId,
        kind: input.kind,
        mealPlanId: input.mealPlanId,
        updatedByAppUserId: scoped.scope.userId,
      })
      .onConflictDoUpdate({
        set: {
          basisCurrentQuantityInBaseUnit:
            basis.currentQuantityInBaseUnit?.toFixed(3) ?? null,
          basisDefaultPurchaseQuantityInBaseUnit:
            basis.defaultPurchaseQuantityInBaseUnit?.toFixed(3) ?? null,
          basisHash: basis.basisHash,
          basisNeededQuantityInBaseUnit:
            basis.neededQuantityInBaseUnit.toFixed(3),
          basisRequiredQuantityInBaseUnit:
            basis.requiredQuantityInBaseUnit.toFixed(3),
          customLabel: custom?.label ?? null,
          customQuantity: custom?.quantity.toFixed(3) ?? null,
          customQuantityInBaseUnit:
            custom?.quantityInBaseUnit.toFixed(3) ?? null,
          customUnit: custom?.unit ?? null,
          kind: input.kind,
          revision: sql`${pantryPackageFitChoices.revision} + 1`,
          updatedAt: sql`now()`,
          updatedByAppUserId: scoped.scope.userId,
        },
        target: [
          pantryPackageFitChoices.householdId,
          pantryPackageFitChoices.mealPlanId,
          pantryPackageFitChoices.canonicalIngredientId,
        ],
      })
      .returning();
    if (!saved) throw new Error("Package-fit choice was not saved");

    await transaction.insert(eventLogs).values({
      eventType: "pantry.package_fit_choice_saved",
      householdId: scoped.scope.householdId,
      payload: {
        basisHash: basis.basisHash,
        canonicalIngredientId: input.canonicalIngredientId,
        customQuantityInBaseUnit: custom?.quantityInBaseUnit ?? null,
        kind: input.kind,
        mealPlanId: input.mealPlanId,
        revision: saved.revision,
        source: "package_fit",
        userId: scoped.scope.userId,
      },
    });
    return mapChoiceRow(saved);
  });
}

export async function resolvePantryPackageFit(
  scoped: ScopedDatabase,
  input: ResolvePantryPackageFitInput,
): Promise<
  | Readonly<{ choice: PantryPackageFitChoice; intent: "alternate-store" | "keep-recipe" }>
  | Readonly<{
      intent: "edit-saved-recipe";
      quantityInBaseUnit: number;
      recipeUpdatedAt: Date;
    }>
> {
  if (input.intent === "keep-recipe") {
    const choice = await upsertPantryPackageFitChoice(scoped, {
      canonicalIngredientId: input.canonicalIngredientId,
      expectedBasisHash: input.expectedBasisHash,
      kind: "keep_recipe_buy_enough",
      mealPlanId: input.mealPlanId,
    });
    return { choice, intent: input.intent };
  }
  if (input.intent === "alternate-store") {
    const choice = await upsertPantryPackageFitChoice(scoped, {
      canonicalIngredientId: input.canonicalIngredientId,
      expectedBasisHash: input.expectedBasisHash,
      kind: "custom_store_amount",
      mealPlanId: input.mealPlanId,
      quantity: input.quantity,
      shoppingLabel: input.shoppingLabel,
      unit: input.unit,
    });
    return { choice, intent: input.intent };
  }
  try {
    const expectedRecipeUpdatedAt =
      input.expectedRecipeUpdatedAt instanceof Date
        ? input.expectedRecipeUpdatedAt
        : new Date(input.expectedRecipeUpdatedAt);
    const result = await updateRecipeIngredientForPackageFit(scoped, {
      acknowledgedPermanentChange: input.acknowledgedPermanentChange,
      expectedRecipeUpdatedAt,
      instructions: input.instructions,
      quantity: input.quantity,
      recipeId: input.recipeId,
      recipeIngredientId: input.recipeIngredientId,
      unit: input.unit,
    });
    return { ...result, intent: input.intent };
  } catch (error) {
    if (error instanceof RecipePackageFitEditError) throw error;
    throw error;
  }
}

export async function getPantryPackageFitReview(
  scoped: ScopedDatabase,
  weekStart: string,
): Promise<PantryPackageFitReview> {
  const [plan] = await scoped.db
    .select({ id: mealPlans.id })
    .from(mealPlans)
    .where(
      and(
        eq(mealPlans.householdId, scoped.scope.householdId),
        eq(mealPlans.weekStartDate, weekStart),
      ),
    )
    .limit(1);
  if (!plan) return { mealPlanId: null, mismatches: [], weekStart };

  const rows = await scoped.db
    .select({
      baseServings: recipes.baseServings,
      baseUnit: canonicalIngredients.baseUnit,
      canonicalIngredientId: canonicalIngredients.id,
      category: canonicalIngredients.category,
      defaultPurchaseDescription: purchaseFormats.description,
      defaultPurchaseQuantityInBaseUnit: purchaseFormats.quantityInBaseUnit,
      densityGramsPerMl: canonicalIngredients.densityGramsPerMl,
      gramsPerCount: canonicalIngredients.gramsPerCount,
      ingredientName: canonicalIngredients.name,
      instructions: recipes.instructions,
      isOptional: recipeIngredients.isOptional,
      planEntryId: planEntries.id,
      plannedServings: planEntries.servingsTarget,
      preparation: recipeIngredients.preparation,
      quantity: recipeIngredients.quantity,
      quantityInBaseUnit: recipeIngredients.quantityInBaseUnit,
      recipeId: recipes.id,
      recipeIngredientId: recipeIngredients.id,
      recipeTitle: recipes.title,
      recipeUpdatedAt: recipes.updatedAt,
      scalesLinearly: recipeIngredients.scalesLinearly,
      scheduledDate: planEntries.scheduledDate,
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
    .innerJoin(
      canonicalIngredients,
      eq(canonicalIngredients.id, recipeIngredients.canonicalIngredientId),
    )
    .leftJoin(
      purchaseFormats,
      and(
        eq(purchaseFormats.canonicalIngredientId, canonicalIngredients.id),
        eq(purchaseFormats.isDefault, true),
      ),
    )
    .where(
      and(
        eq(planEntries.householdId, scoped.scope.householdId),
        eq(planEntries.mealPlanId, plan.id),
        eq(planEntries.status, "planned"),
      ),
    )
    .orderBy(asc(canonicalIngredients.name), asc(planEntries.scheduledDate));
  const inventory = await scoped.db
    .select({
      canonicalIngredientId: pantryItems.canonicalIngredientId,
      quantityInBaseUnit: pantryItems.quantityInBaseUnit,
    })
    .from(pantryItems)
    .where(eq(pantryItems.householdId, scoped.scope.householdId));
  const requirementRows = aggregatePantryRequirements(
    rows.flatMap((row) =>
      row.scheduledDate === null
        ? []
        : [{
            baseServings: row.baseServings,
            canonicalIngredientId: row.canonicalIngredientId,
            isOptional: row.isOptional,
            planEntryId: row.planEntryId,
            preparation: row.preparation,
            quantity: Number(row.quantity),
            quantityInBaseUnit: Number(row.quantityInBaseUnit),
            recipeId: row.recipeId,
            recipeIngredientId: row.recipeIngredientId,
            recipeTitle: row.recipeTitle,
            scalesLinearly: row.scalesLinearly,
            scheduledDate: row.scheduledDate,
            servingsTarget: row.plannedServings,
            unit: row.unit,
          }],
    ),
    inventory.map((item) => ({
      canonicalIngredientId: item.canonicalIngredientId,
      quantityInBaseUnit: Number(item.quantityInBaseUnit),
    })),
  );
  const requirementById = new Map(
    requirementRows.map((requirement) => [
      requirement.canonicalIngredientId,
      requirement,
    ]),
  );
  const validChoices = await loadPantryPackageFitChoices(scoped, plan.id);
  const choicesById = new Map(
    validChoices.map((choice) => [choice.canonicalIngredientId, choice]),
  );

  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.plannedServings === 0) continue;
    grouped.set(row.canonicalIngredientId, [
      ...(grouped.get(row.canonicalIngredientId) ?? []),
      row,
    ]);
  }

  const mismatches: PantryPackageFitMismatch[] = [];
  for (const [canonicalIngredientId, contributors] of grouped) {
    const requiredContributors = contributors.filter((row) => !row.isOptional);
    const first = requiredContributors[0];
    if (
      !first ||
      !first.defaultPurchaseDescription ||
      first.defaultPurchaseQuantityInBaseUnit === null
    ) {
      continue;
    }
    const requirement = requirementById.get(canonicalIngredientId);
    if (!requirement) continue;
    const defaultPurchaseQuantityInBaseUnit = Number(
      first.defaultPurchaseQuantityInBaseUnit,
    );
    const analysis = analyzePantryPackageFit({
      ingredientCategory: first.category,
      packageQuantityInBaseUnit: defaultPurchaseQuantityInBaseUnit,
      requirement,
    });
    if (!analysis || requirement.currentQuantityInBaseUnit === null) continue;
    const currentQuantityInBaseUnit = requirement.currentQuantityInBaseUnit;
    const neededQuantityInBaseUnit = analysis.neededQuantityInBaseUnit;
    const requiredQuantityInBaseUnit = analysis.requiredQuantityInBaseUnit;
    const packageCount = analysis.packageCount;
    const projectedQuantityInBaseUnit = roundQuantity(
      packageCount * defaultPurchaseQuantityInBaseUnit,
    );
    const surplusQuantityInBaseUnit = analysis.unusedFinalPackageQuantityInBaseUnit;
    const basis = {
      currentQuantityInBaseUnit,
      defaultPurchaseQuantityInBaseUnit,
      neededQuantityInBaseUnit,
      requiredQuantityInBaseUnit,
    };
    const basisHash = hashBasis({
      ...basis,
      canonicalIngredientId,
      densityGramsPerMl:
        first.densityGramsPerMl === null
          ? null
          : Number(first.densityGramsPerMl),
      gramsPerCount:
        first.gramsPerCount === null ? null : Number(first.gramsPerCount),
      mealPlanId: plan.id,
    });
    const savedChoice = choicesById.get(canonicalIngredientId);
    mismatches.push({
      ...basis,
      currentQuantityInBaseUnit,
      baseUnit: first.baseUnit,
      basisHash,
      canonicalIngredientId,
      choice: savedChoice?.basisHash === basisHash ? savedChoice : null,
      compatibleUnits: compatibleUnits(
        first.baseUnit,
        first.densityGramsPerMl === null
          ? null
          : Number(first.densityGramsPerMl),
        first.gramsPerCount === null ? null : Number(first.gramsPerCount),
      ),
      contributors: requiredContributors.flatMap((row) => {
        if (!isUsRecipeUnit(row.unit)) return [];
        const storedQuantity = Number(row.quantity);
        const analyzedSuggestion = analysis.recipeQuantitySuggestions.find(
          (suggestion) =>
            suggestion.recipeIngredientId === row.recipeIngredientId,
        );
        const suggestedQuantity = analyzedSuggestion?.suggestedQuantity ?? null;
        const methodReferenceRisk = row.instructions.some((step) =>
          step.instruction
            .toLocaleLowerCase("en-US")
            .includes(first.ingredientName.toLocaleLowerCase("en-US")),
        );
        return [{
          baseServings: row.baseServings,
          instructions: row.instructions,
          methodReferenceRisk,
          perServingAfter:
            suggestedQuantity === null
              ? null
              : roundQuantity(suggestedQuantity / row.baseServings),
          perServingBefore: roundQuantity(storedQuantity / row.baseServings),
          planEntryId: row.planEntryId,
          plannedServings: row.plannedServings,
          preparation: row.preparation,
          quantity: storedQuantity,
          quantityInBaseUnit: Number(row.quantityInBaseUnit),
          recipeId: row.recipeId,
          recipeIngredientId: row.recipeIngredientId,
          recipeTitle: row.recipeTitle,
          recipeUpdatedAt: row.recipeUpdatedAt,
          scalesLinearly: row.scalesLinearly,
          scheduledDate: row.scheduledDate,
          scheduledDates: row.scheduledDate ? [row.scheduledDate] : [],
          suggestedQuantity,
          unit: row.unit,
        }];
      }),
      defaultPurchaseDescription: first.defaultPurchaseDescription,
      gramsPerCount:
        first.gramsPerCount === null ? null : Number(first.gramsPerCount),
      ingredientName: first.ingredientName,
      packageCount,
      projectedQuantityInBaseUnit,
      risk:
        first.category === "protein"
          ? "food_safety"
          : requiredContributors.some((row) => !row.scalesLinearly)
            ? "recipe_structure"
            : "standard",
      surplusQuantityInBaseUnit,
    });
  }

  return { mealPlanId: plan.id, mismatches, weekStart };
}
