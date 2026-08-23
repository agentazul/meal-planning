import { describe, expect, it, vi } from "vitest";

import { eventLogs, recipeIngredients, recipes } from "~/db/schema";
import type { ScopedDatabase } from "~/server/context.server";
import {
  type CreateRecipeInput,
  createHouseholdRecipe,
  type RecipeIngredientInput,
  RecipePackageFitEditError,
  updateRecipeIngredientForPackageFit,
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

function packageFitEditFixture(
  recipeUpdatedAt = new Date("2026-08-23T12:00:00.000Z"),
  rowOverrides: Readonly<Record<string, unknown>> = {},
) {
  const updates: Array<{ table: unknown; values: unknown }> = [];
  const inserts: InsertRecord[] = [];
  const transaction = {
    execute: vi.fn(async () => []),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        inserts.push({ table, values });
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => {
        const builder: Record<string, unknown> = {};
        const chain = () => builder;
        builder.innerJoin = chain;
        builder.where = chain;
        builder.limit = vi.fn(async () => [
          {
            baseUnit: "g",
            canonicalIngredientId: INGREDIENT_ID,
            densityGramsPerMl: null,
            gramsPerCount: "58.000",
            instructions: [{ instruction: "Use two lemons.", position: 1 }],
            preparation: null,
            quantity: "4.000",
            quantityInBaseUnit: "232.000",
            recipeUpdatedAt,
            unit: "count",
            ...rowOverrides,
          },
        ]);
        return builder;
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: unknown) => {
        updates.push({ table, values });
        return {
          where: vi.fn(() =>
            table === recipes
              ? {
                  returning: vi.fn(async () => [
                    { updatedAt: new Date("2026-08-23T12:01:00.000Z") },
                  ]),
                }
              : Promise.resolve(),
          ),
        };
      }),
    })),
  };
  return {
    inserts,
    scoped: {
      db: {
        transaction: vi.fn(
          async (callback: (value: typeof transaction) => Promise<unknown>) =>
            callback(transaction),
        ),
      },
      scope: { householdId: HOUSEHOLD_ID, userId: USER_ID },
    } as unknown as ScopedDatabase,
    transaction,
    updates,
  };
}

describe("updateRecipeIngredientForPackageFit", () => {
  it("permanently updates the normalized ingredient and instructions with an audit", async () => {
    const expectedRecipeUpdatedAt = new Date("2026-08-23T12:00:00.000Z");
    const fixture = packageFitEditFixture(expectedRecipeUpdatedAt);

    await expect(
      updateRecipeIngredientForPackageFit(fixture.scoped, {
        acknowledgedPermanentChange: true,
        expectedRecipeUpdatedAt,
        instructions: [{ instruction: "Use two lemons and reduce the sauce.", position: 1 }],
        quantity: 2,
        recipeId: RECIPE_ID,
        recipeIngredientId: "233a1655-f091-4230-bdc6-957f26ba539d",
        unit: "count",
      }),
    ).resolves.toMatchObject({ quantityInBaseUnit: 116 });

    expect(
      fixture.updates.find((update) => update.table === recipeIngredients)?.values,
    ).toEqual({
      quantity: "2.000",
      quantityInBaseUnit: "116.000",
      unit: "count",
    });
    expect(
      fixture.inserts.find((insert) => insert.table === eventLogs)?.values,
    ).toMatchObject({
      eventType: "recipe.package_fit_edited",
      payload: {
        after: { quantity: 2, quantityInBaseUnit: 116, unit: "count" },
        before: { quantity: 4, quantityInBaseUnit: 232, unit: "count" },
        source: "package_fit",
      },
    });
  });

  it("rejects an optimistic version mismatch before writing", async () => {
    const fixture = packageFitEditFixture(
      new Date("2026-08-23T12:05:00.000Z"),
    );

    await expect(
      updateRecipeIngredientForPackageFit(fixture.scoped, {
        acknowledgedPermanentChange: true,
        expectedRecipeUpdatedAt: new Date("2026-08-23T12:00:00.000Z"),
        instructions: [{ instruction: "Use two lemons.", position: 1 }],
        quantity: 2,
        recipeId: RECIPE_ID,
        recipeIngredientId: "233a1655-f091-4230-bdc6-957f26ba539d",
        unit: "count",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<RecipePackageFitEditError>>({
        code: "STALE_RECIPE",
      }),
    );
    expect(fixture.updates).toEqual([]);
    expect(fixture.inserts).toEqual([]);
  });

  it("rejects an equivalent display amount and unchanged method without writing", async () => {
    const expectedRecipeUpdatedAt = new Date("2026-08-23T12:00:00.000Z");
    const fixture = packageFitEditFixture(expectedRecipeUpdatedAt, {
      gramsPerCount: null,
      quantity: "0.750",
      quantityInBaseUnit: "340.194",
      unit: "lb",
    });

    await expect(
      updateRecipeIngredientForPackageFit(fixture.scoped, {
        acknowledgedPermanentChange: true,
        expectedRecipeUpdatedAt,
        instructions: [{ instruction: "Use two lemons.", position: 1 }],
        quantity: 0.75,
        recipeId: RECIPE_ID,
        recipeIngredientId: "233a1655-f091-4230-bdc6-957f26ba539d",
        unit: "lb",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<RecipePackageFitEditError>>({
        code: "NO_CHANGE",
      }),
    );
    expect(fixture.updates).toEqual([]);
    expect(fixture.inserts).toEqual([]);
  });

  it("normalizes display precision before canonical conversion and persistence", async () => {
    const expectedRecipeUpdatedAt = new Date("2026-08-23T12:00:00.000Z");
    const fixture = packageFitEditFixture(expectedRecipeUpdatedAt);

    await updateRecipeIngredientForPackageFit(fixture.scoped, {
      acknowledgedPermanentChange: true,
      expectedRecipeUpdatedAt,
      instructions: [{ instruction: "Use the lemons.", position: 1 }],
      quantity: 2.0004,
      recipeId: RECIPE_ID,
      recipeIngredientId: "233a1655-f091-4230-bdc6-957f26ba539d",
      unit: "count",
    });

    expect(
      fixture.updates.find((update) => update.table === recipeIngredients)?.values,
    ).toEqual({
      quantity: "2.000",
      quantityInBaseUnit: "116.000",
      unit: "count",
    });
    expect(
      fixture.inserts.find((insert) => insert.table === eventLogs)?.values,
    ).toMatchObject({
      payload: {
        after: { quantity: 2, quantityInBaseUnit: 116, unit: "count" },
      },
    });
  });
});
