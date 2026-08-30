import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";

import {
  canonicalIngredients,
  eventLogs,
  recipeIngredients,
  recipes,
  type RecipeStep,
} from "~/db/schema";
import {
  convertToCanonical,
  UnitConversionError,
  US_RECIPE_MEASUREMENT_UNITS,
  type UsRecipeMeasurementUnit,
} from "~/domain/units";
import type { ScopedDatabase } from "~/server/context.server";
import { lockPantryInventoryForecast } from "~/server/data/pantry-inventory-lock.server";
import {
  RECIPE_GENERATION_EVENT_TYPES,
  RecipeGenerationAttemptError,
  recipeGenerationAttemptIdSchema,
} from "~/server/data/recipe-generation.server";

export type IngredientReference = Readonly<{
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
  densityGramsPerMl: number | null;
  gramsPerCount: number | null;
  id: string;
  isStaple: boolean;
  name: string;
  pluralName: string;
}>;

export type RecipeListItem = Readonly<{
  activeTimeMinutes: number;
  baseServings: number;
  cuisine: string | null;
  createdAt: Date;
  effortTier: "weeknight" | "weekend" | "project";
  id: string;
  ingredientCount: number;
  source: "generated" | "imported" | "manual";
  title: string;
  totalTimeMinutes: number;
}>;

export type RecipeIngredientInput = Readonly<{
  canonicalIngredientId: string;
  isOptional: boolean;
  preparation: string | null;
  quantity: number;
  quantityInBaseUnit: number;
  scalesLinearly: boolean;
  unit: string;
}>;

export type PositionedRecipeIngredientInput = RecipeIngredientInput &
  Readonly<{ position: number }>;

export function withRecipeIngredientPositions(
  ingredients: readonly RecipeIngredientInput[],
): readonly PositionedRecipeIngredientInput[] {
  return ingredients.map((ingredient, index) => ({
    ...ingredient,
    position: index + 1,
  }));
}

type RecipeValuesInput = Readonly<{
  activeTimeMinutes: number;
  baseServings: number;
  cuisine: string | null;
  description: string | null;
  effortTier: "weeknight" | "weekend" | "project";
  ingredients: readonly RecipeIngredientInput[];
  instructions: readonly RecipeStep[];
  minInternalTemperatureF: number | null;
  primaryProtein: string | null;
  techniques: readonly string[];
  title: string;
  totalTimeMinutes: number;
}>;

type RecipeSourceInput =
  | Readonly<{
      generationAttemptId?: never;
      source: "manual";
    }>
  | Readonly<{
      generationAttemptId: string;
      source: "generated";
    }>;

export type CreateRecipeInput = RecipeValuesInput & RecipeSourceInput;

export type UpdateRecipeIngredientForPackageFitInput = Readonly<{
  acknowledgedPermanentChange: true;
  expectedRecipeUpdatedAt: Date;
  instructions: readonly RecipeStep[];
  quantity: number;
  recipeId: string;
  recipeIngredientId: string;
  unit: UsRecipeMeasurementUnit;
}>;

export type RecipePackageFitEditErrorCode =
  | "INVALID_INPUT"
  | "NO_CHANGE"
  | "RECIPE_NOT_FOUND"
  | "STALE_RECIPE"
  | "UNIT_NOT_COMPATIBLE";

export class RecipePackageFitEditError extends Error {
  override readonly name = "RecipePackageFitEditError";

  constructor(
    readonly code: RecipePackageFitEditErrorCode,
    readonly userMessage: string,
  ) {
    super(userMessage);
  }
}

function validatePackageFitRecipeEdit(
  input: UpdateRecipeIngredientForPackageFitInput,
): void {
  if (
    input.acknowledgedPermanentChange !== true ||
    !Number.isFinite(input.quantity) ||
    input.quantity <= 0 ||
    input.quantity > 1_000_000 ||
    !US_RECIPE_MEASUREMENT_UNITS.includes(input.unit) ||
    !(input.expectedRecipeUpdatedAt instanceof Date) ||
    !Number.isFinite(input.expectedRecipeUpdatedAt.getTime()) ||
    input.instructions.length < 1 ||
    input.instructions.length > 100
  ) {
    throw new RecipePackageFitEditError(
      "INVALID_INPUT",
      "Review the permanent recipe change and try again.",
    );
  }

  const positions = new Set<number>();
  for (const step of input.instructions) {
    if (
      !Number.isInteger(step.position) ||
      step.position <= 0 ||
      positions.has(step.position) ||
      typeof step.instruction !== "string" ||
      step.instruction.trim().length < 1 ||
      step.instruction.length > 5_000
    ) {
      throw new RecipePackageFitEditError(
        "INVALID_INPUT",
        "Recipe instructions must contain unique, ordered, non-empty steps.",
      );
    }
    positions.add(step.position);
  }
}

export async function listIngredientReferences(
  scoped: ScopedDatabase,
): Promise<readonly IngredientReference[]> {
  const rows = await scoped.db
    .select({
      baseUnit: canonicalIngredients.baseUnit,
      category: canonicalIngredients.category,
      densityGramsPerMl: canonicalIngredients.densityGramsPerMl,
      gramsPerCount: canonicalIngredients.gramsPerCount,
      id: canonicalIngredients.id,
      isStaple: canonicalIngredients.isStaple,
      name: canonicalIngredients.name,
      pluralName: canonicalIngredients.pluralName,
    })
    .from(canonicalIngredients)
    .orderBy(
      asc(canonicalIngredients.category),
      asc(canonicalIngredients.name),
    );

  return rows.map((row) => ({
    ...row,
    densityGramsPerMl:
      row.densityGramsPerMl === null ? null : Number(row.densityGramsPerMl),
    gramsPerCount:
      row.gramsPerCount === null ? null : Number(row.gramsPerCount),
  }));
}

export async function listHouseholdRecipes(
  scoped: ScopedDatabase,
): Promise<readonly RecipeListItem[]> {
  const rows = await scoped.db
    .select({
      activeTimeMinutes: recipes.activeTimeMinutes,
      baseServings: recipes.baseServings,
      cuisine: recipes.cuisine,
      createdAt: recipes.createdAt,
      effortTier: recipes.effortTier,
      id: recipes.id,
      ingredientCount: count(recipeIngredients.id),
      source: recipes.source,
      title: recipes.title,
      totalTimeMinutes: recipes.totalTimeMinutes,
    })
    .from(recipes)
    .leftJoin(
      recipeIngredients,
      and(
        eq(recipeIngredients.householdId, recipes.householdId),
        eq(recipeIngredients.recipeId, recipes.id),
      ),
    )
    .where(eq(recipes.householdId, scoped.scope.householdId))
    .groupBy(recipes.id)
    .orderBy(desc(recipes.createdAt), asc(recipes.title));

  return rows;
}

export async function getHouseholdRecipe(
  scoped: ScopedDatabase,
  recipeId: string,
) {
  const [recipe] = await scoped.db
    .select()
    .from(recipes)
    .where(
      and(
        eq(recipes.householdId, scoped.scope.householdId),
        eq(recipes.id, recipeId),
      ),
    )
    .limit(1);

  if (!recipe) {
    return null;
  }

  const ingredients = await scoped.db
    .select({
      baseUnit: canonicalIngredients.baseUnit,
      canonicalIngredientId: recipeIngredients.canonicalIngredientId,
      id: recipeIngredients.id,
      isOptional: recipeIngredients.isOptional,
      name: canonicalIngredients.name,
      position: recipeIngredients.position,
      preparation: recipeIngredients.preparation,
      quantity: recipeIngredients.quantity,
      quantityInBaseUnit: recipeIngredients.quantityInBaseUnit,
      scalesLinearly: recipeIngredients.scalesLinearly,
      unit: recipeIngredients.unit,
    })
    .from(recipeIngredients)
    .innerJoin(
      canonicalIngredients,
      eq(recipeIngredients.canonicalIngredientId, canonicalIngredients.id),
    )
    .where(
      and(
        eq(recipeIngredients.householdId, scoped.scope.householdId),
        eq(recipeIngredients.recipeId, recipe.id),
      ),
    )
    .orderBy(asc(recipeIngredients.position), asc(recipeIngredients.id));

  return {
    ...recipe,
    ingredients: ingredients.map((ingredient) => ({
      ...ingredient,
      quantity: Number(ingredient.quantity),
      quantityInBaseUnit: Number(ingredient.quantityInBaseUnit),
    })),
  };
}

export async function createHouseholdRecipe(
  scoped: ScopedDatabase,
  input: CreateRecipeInput,
): Promise<string> {
  const uniqueIngredientIds = [
    ...new Set(
      input.ingredients.map((ingredient) => ingredient.canonicalIngredientId),
    ),
  ];

  const resolvedIngredients = await scoped.db
    .select({ id: canonicalIngredients.id })
    .from(canonicalIngredients)
    .where(inArray(canonicalIngredients.id, uniqueIngredientIds));

  if (resolvedIngredients.length !== uniqueIngredientIds.length) {
    throw new Error("One or more recipe ingredients are not canonical");
  }

  return scoped.db.transaction(async (transaction) => {
    if (input.source === "generated") {
      const parsedAttemptId = recipeGenerationAttemptIdSchema.safeParse(
        input.generationAttemptId,
      );
      if (!parsedAttemptId.success) {
        throw new RecipeGenerationAttemptError("invalid_attempt");
      }

      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`recipe-generation-attempt:${parsedAttemptId.data}`}, 0))`,
      );

      const [successfulAttempt] = await transaction
        .select({ id: eventLogs.id })
        .from(eventLogs)
        .where(
          and(
            eq(eventLogs.householdId, scoped.scope.householdId),
            eq(eventLogs.eventType, RECIPE_GENERATION_EVENT_TYPES.succeeded),
            sql`${eventLogs.payload} ->> 'attemptId' = ${parsedAttemptId.data}`,
            sql`${eventLogs.payload} ->> 'userId' = ${scoped.scope.userId}`,
          ),
        )
        .limit(1);

      if (!successfulAttempt) {
        throw new RecipeGenerationAttemptError("not_successful");
      }

      const [existingSave] = await transaction
        .select({ id: eventLogs.id })
        .from(eventLogs)
        .where(
          and(
            eq(eventLogs.householdId, scoped.scope.householdId),
            eq(eventLogs.eventType, "recipe.created"),
            sql`${eventLogs.payload} ->> 'generationAttemptId' = ${parsedAttemptId.data}`,
          ),
        )
        .limit(1);

      if (existingSave) {
        throw new RecipeGenerationAttemptError("already_saved");
      }
    }

    const [created] = await transaction
      .insert(recipes)
      .values({
        activeTimeMinutes: input.activeTimeMinutes,
        baseServings: input.baseServings,
        cuisine: input.cuisine,
        description: input.description,
        effortTier: input.effortTier,
        householdId: scoped.scope.householdId,
        instructions: input.instructions,
        minInternalTemperatureF: input.minInternalTemperatureF,
        primaryProtein: input.primaryProtein,
        source: input.source,
        techniques: [...input.techniques],
        title: input.title.trim(),
        totalTimeMinutes: input.totalTimeMinutes,
      })
      .returning({ id: recipes.id });

    if (!created) {
      throw new Error("Recipe was not created");
    }

    await transaction.insert(recipeIngredients).values(
      withRecipeIngredientPositions(input.ingredients).map((ingredient) => ({
        canonicalIngredientId: ingredient.canonicalIngredientId,
        householdId: scoped.scope.householdId,
        isOptional: ingredient.isOptional,
        position: ingredient.position,
        preparation: ingredient.preparation,
        quantity: ingredient.quantity.toFixed(3),
        quantityInBaseUnit: ingredient.quantityInBaseUnit.toFixed(3),
        recipeId: created.id,
        scalesLinearly: ingredient.scalesLinearly,
        unit: ingredient.unit,
      })),
    );

    await transaction.insert(eventLogs).values({
      eventType: "recipe.created",
      householdId: scoped.scope.householdId,
      payload: {
        ...(input.source === "generated"
          ? { generationAttemptId: input.generationAttemptId }
          : {}),
        ingredientCount: input.ingredients.length,
        recipeId: created.id,
        source: input.source,
      },
    });

    return created.id;
  });
}

/**
 * Permanently edits a saved recipe after the household accepts a package-fit
 * suggestion. Every plan entry that references the recipe sees this change.
 */
export async function updateRecipeIngredientForPackageFit(
  scoped: ScopedDatabase,
  input: UpdateRecipeIngredientForPackageFitInput,
): Promise<Readonly<{ quantityInBaseUnit: number; recipeUpdatedAt: Date }>> {
  validatePackageFitRecipeEdit(input);

  return scoped.db.transaction(async (transaction) => {
    await lockPantryInventoryForecast(transaction, scoped.scope.householdId);
    await transaction.execute(
      sql`select 1 from ${recipes} where ${recipes.householdId} = ${scoped.scope.householdId} and ${recipes.id} = ${input.recipeId} for update`,
    );

    const [row] = await transaction
      .select({
        baseUnit: canonicalIngredients.baseUnit,
        canonicalIngredientId: recipeIngredients.canonicalIngredientId,
        densityGramsPerMl: canonicalIngredients.densityGramsPerMl,
        gramsPerCount: canonicalIngredients.gramsPerCount,
        instructions: recipes.instructions,
        preparation: recipeIngredients.preparation,
        quantity: recipeIngredients.quantity,
        quantityInBaseUnit: recipeIngredients.quantityInBaseUnit,
        recipeUpdatedAt: recipes.updatedAt,
        unit: recipeIngredients.unit,
      })
      .from(recipes)
      .innerJoin(
        recipeIngredients,
        and(
          eq(recipeIngredients.householdId, recipes.householdId),
          eq(recipeIngredients.recipeId, recipes.id),
        ),
      )
      .innerJoin(
        canonicalIngredients,
        eq(recipeIngredients.canonicalIngredientId, canonicalIngredients.id),
      )
      .where(
        and(
          eq(recipes.householdId, scoped.scope.householdId),
          eq(recipes.id, input.recipeId),
          eq(recipeIngredients.id, input.recipeIngredientId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new RecipePackageFitEditError(
        "RECIPE_NOT_FOUND",
        "That saved recipe ingredient is no longer available.",
      );
    }
    if (
      row.recipeUpdatedAt.getTime() !== input.expectedRecipeUpdatedAt.getTime()
    ) {
      throw new RecipePackageFitEditError(
        "STALE_RECIPE",
        "Someone changed this recipe on another device. Review the latest version before saving.",
      );
    }

    const normalizedQuantity = Number(input.quantity.toFixed(3));
    const normalizedInstructions = input.instructions.map((step) => ({
      instruction: step.instruction.trim(),
      position: step.position,
    }));
    let quantityInBaseUnit: number;
    try {
      quantityInBaseUnit = Number(
        convertToCanonical({
          canonicalUnit: row.baseUnit,
          densityGPerMl:
            row.densityGramsPerMl === null
              ? null
              : Number(row.densityGramsPerMl),
          gramsPerCount:
            row.gramsPerCount === null ? null : Number(row.gramsPerCount),
          quantity: normalizedQuantity,
          unit: input.unit,
        }).quantity.toFixed(3),
      );
    } catch (error) {
      if (error instanceof UnitConversionError) {
        throw new RecipePackageFitEditError(
          "UNIT_NOT_COMPATIBLE",
          "Choose a measurement that can be converted for this ingredient.",
        );
      }
      throw error;
    }
    if (quantityInBaseUnit <= 0) {
      throw new RecipePackageFitEditError(
        "INVALID_INPUT",
        "Enter a larger ingredient amount.",
      );
    }

    const instructionsChanged =
      normalizedInstructions.length !== row.instructions.length ||
      normalizedInstructions.some((step, index) => {
        const existing = row.instructions[index];
        return (
          !existing ||
          step.position !== existing.position ||
          step.instruction !== existing.instruction.trim()
        );
      });
    const ingredientChanged =
      normalizedQuantity !== Number(row.quantity) ||
      input.unit !== row.unit ||
      quantityInBaseUnit !== Number(row.quantityInBaseUnit);

    if (!ingredientChanged && !instructionsChanged) {
      throw new RecipePackageFitEditError(
        "NO_CHANGE",
        "The saved-recipe amount and method are already the same.",
      );
    }

    await transaction
      .update(recipeIngredients)
      .set({
        quantity: normalizedQuantity.toFixed(3),
        quantityInBaseUnit: quantityInBaseUnit.toFixed(3),
        unit: input.unit,
      })
      .where(
        and(
          eq(recipeIngredients.householdId, scoped.scope.householdId),
          eq(recipeIngredients.recipeId, input.recipeId),
          eq(recipeIngredients.id, input.recipeIngredientId),
        ),
      );

    const [updated] = await transaction
      .update(recipes)
      .set({
        instructions: normalizedInstructions,
        updatedAt: sql`greatest(now(), ${recipes.updatedAt} + interval '1 millisecond')`,
      })
      .where(
        and(
          eq(recipes.householdId, scoped.scope.householdId),
          eq(recipes.id, input.recipeId),
          eq(recipes.updatedAt, input.expectedRecipeUpdatedAt),
        ),
      )
      .returning({ updatedAt: recipes.updatedAt });

    if (!updated) {
      throw new RecipePackageFitEditError(
        "STALE_RECIPE",
        "Someone changed this recipe on another device. Review the latest version before saving.",
      );
    }

    await transaction.insert(eventLogs).values({
      eventType: "recipe.package_fit_edited",
      householdId: scoped.scope.householdId,
      payload: {
        after: {
          instructions: normalizedInstructions,
          quantity: normalizedQuantity,
          quantityInBaseUnit,
          unit: input.unit,
        },
        before: {
          instructions: row.instructions,
          preparation: row.preparation,
          quantity: Number(row.quantity),
          quantityInBaseUnit: Number(row.quantityInBaseUnit),
          unit: row.unit,
        },
        canonicalIngredientId: row.canonicalIngredientId,
        recipeId: input.recipeId,
        recipeIngredientId: input.recipeIngredientId,
        source: "package_fit",
        userId: scoped.scope.userId,
      },
    });

    return { quantityInBaseUnit, recipeUpdatedAt: updated.updatedAt };
  });
}
