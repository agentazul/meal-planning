import { describe, expect, it, vi } from "vitest";

import { eventLogs, recipeIngredients, recipes } from "~/db/schema";
import type { ScopedDatabase } from "~/server/context.server";
import {
  type CreateRecipeInput,
  createHouseholdRecipe,
  type RecipeIngredientInput,
  withRecipeIngredientPositions,
} from "./recipes.server";

const ATTEMPT_ID = "f716e7e4-df64-4c84-9a09-4661d0cb3dd1";
const HOUSEHOLD_ID = "f8044a3a-b8e1-4bea-a3db-d8f4f322b411";
const INGREDIENT_ID = "090824a3-c8d3-49fb-801b-0c24ff5730d4";
const RECIPE_ID = "f72a0dde-bbcf-44d4-9686-92018abc6f71";
const USER_ID = "f69ec2b8-a84c-448b-a26c-6571cd8de311";

function ingredient(name: string): RecipeIngredientInput {
  return {
    canonicalIngredientId: name,
    isOptional: false,
    preparation: null,
    quantity: 1,
    quantityInBaseUnit: 1,
    scalesLinearly: true,
    unit: "count",
  };
}

describe("withRecipeIngredientPositions", () => {
  it("assigns stable one-based positions without changing input order", () => {
    const positioned = withRecipeIngredientPositions([
      ingredient("chicken"),
      ingredient("lemon"),
      ingredient("oil"),
    ]);

    expect(
      positioned.map(({ canonicalIngredientId, position }) => ({
        canonicalIngredientId,
        position,
      })),
    ).toEqual([
      { canonicalIngredientId: "chicken", position: 1 },
      { canonicalIngredientId: "lemon", position: 2 },
      { canonicalIngredientId: "oil", position: 3 },
    ]);
  });
});

function recipeInput(
  source: "generated" | "manual",
): CreateRecipeInput {
  const values = {
    activeTimeMinutes: 20,
    baseServings: 4,
    cuisine: "American",
    description: "A dependable dinner.",
    effortTier: "weeknight" as const,
    ingredients: [ingredient(INGREDIENT_ID)],
    instructions: [{ instruction: "Cook until done.", position: 1 }],
    minInternalTemperatureF: 165,
    primaryProtein: "Chicken",
    techniques: ["roasting"],
    title: "Roast chicken",
    totalTimeMinutes: 45,
  };

  return source === "manual"
    ? { ...values, source }
    : { ...values, generationAttemptId: ATTEMPT_ID, source };
}

type InsertRecord = Readonly<{ table: unknown; values: unknown }>;

function persistenceFixture(attemptQueryResults: readonly unknown[][] = []) {
  const pendingAttemptResults = [...attemptQueryResults];
  const inserts: InsertRecord[] = [];
  const transaction = {
    execute: vi.fn(async () => []),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        inserts.push({ table, values });
        return table === recipes
          ? {
              returning: vi.fn(async () => [{ id: RECIPE_ID }]),
            }
          : Promise.resolve();
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => pendingAttemptResults.shift() ?? []),
        })),
      })),
    })),
  };
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [{ id: INGREDIENT_ID }]),
      })),
    })),
    transaction: vi.fn(
      async (callback: (value: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
  };

  return {
    inserts,
    scoped: {
      db,
      scope: { householdId: HOUSEHOLD_ID, userId: USER_ID },
    } as unknown as ScopedDatabase,
    transaction,
  };
}

describe("createHouseholdRecipe source provenance", () => {
  it("persists and records an explicitly manual recipe", async () => {
    const fixture = persistenceFixture();

    await expect(
      createHouseholdRecipe(fixture.scoped, recipeInput("manual")),
    ).resolves.toBe(RECIPE_ID);

    expect(
      fixture.inserts.find((insert) => insert.table === recipes)?.values,
    ).toMatchObject({ source: "manual" });
    expect(
      fixture.inserts.find((insert) => insert.table === eventLogs)?.values,
    ).toEqual({
      eventType: "recipe.created",
      householdId: HOUSEHOLD_ID,
      payload: {
        ingredientCount: 1,
        recipeId: RECIPE_ID,
        source: "manual",
      },
    });
    expect(
      fixture.inserts.find((insert) => insert.table === recipeIngredients),
    ).toBeDefined();
  });

  it("requires scoped success provenance and records the attempt for generated saves", async () => {
    const fixture = persistenceFixture([[{ id: "success-event" }], []]);

    await expect(
      createHouseholdRecipe(fixture.scoped, recipeInput("generated")),
    ).resolves.toBe(RECIPE_ID);

    expect(fixture.transaction.execute).toHaveBeenCalledOnce();
    expect(
      fixture.inserts.find((insert) => insert.table === recipes)?.values,
    ).toMatchObject({ source: "generated" });
    expect(
      fixture.inserts.find((insert) => insert.table === eventLogs)?.values,
    ).toEqual({
      eventType: "recipe.created",
      householdId: HOUSEHOLD_ID,
      payload: {
        generationAttemptId: ATTEMPT_ID,
        ingredientCount: 1,
        recipeId: RECIPE_ID,
        source: "generated",
      },
    });
  });

  it("does not save a generated recipe without a successful scoped attempt", async () => {
    const fixture = persistenceFixture([[]]);

    await expect(
      createHouseholdRecipe(fixture.scoped, recipeInput("generated")),
    ).rejects.toMatchObject({
      code: "not_successful",
    });
    expect(fixture.inserts).toEqual([]);
  });

  it("prevents a successful attempt from being saved twice", async () => {
    const fixture = persistenceFixture([
      [{ id: "success-event" }],
      [{ id: "existing-recipe-event" }],
    ]);

    await expect(
      createHouseholdRecipe(fixture.scoped, recipeInput("generated")),
    ).rejects.toMatchObject({
      code: "already_saved",
    });
    expect(fixture.inserts).toEqual([]);
  });
});
