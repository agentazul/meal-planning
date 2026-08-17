import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";

import {
  canonicalIngredients,
  eventLogs,
  recipeIngredients,
  recipes,
  type RecipeStep,
} from "~/db/schema";
import type { ScopedDatabase } from "~/server/context.server";
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
