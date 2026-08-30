import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  canonicalIngredients,
  eventLogs,
  mealPlans,
  pantryItems,
  pantryPackageFitChoices,
  planEntries,
} from "~/db/schema";
import type { ScopedDatabase } from "~/server/context.server";
import {
  getPantryPackageFitReview,
  PantryPackageFitError,
  upsertPantryPackageFitChoice,
} from "./pantry-package-fit.server";

const HOUSEHOLD_ID = "f8044a3a-b8e1-4bea-a3db-d8f4f322b411";
const USER_ID = "f69ec2b8-a84c-448b-a26c-6571cd8de311";
const MEAL_PLAN_ID = "db1bd1f4-3eb4-44c7-b323-d99439f16ef9";
const INGREDIENT_ID = "090824a3-c8d3-49fb-801b-0c24ff5730d4";
const RECIPE_ID = "f72a0dde-bbcf-44d4-9686-92018abc6f71";
const RECIPE_INGREDIENT_ID = "233a1655-f091-4230-bdc6-957f26ba539d";
const PLAN_ENTRY_ID = "87ec76ff-92da-4524-b844-556723863e7c";
const UPDATED_AT = new Date("2026-08-23T12:00:00.000Z");

function basisHash(neededQuantityInBaseUnit = 113.4): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        canonicalIngredientId: INGREDIENT_ID,
        currentQuantityInBaseUnit: 0,
        defaultPurchaseQuantityInBaseUnit: 907,
        densityGramsPerMl: null,
        gramsPerCount: 58,
        mealPlanId: MEAL_PLAN_ID,
        neededQuantityInBaseUnit,
        requiredQuantityInBaseUnit: neededQuantityInBaseUnit,
      }),
    )
    .digest("hex");
}

function reviewRow(quantityInBaseUnit = "113.400") {
  return {
    baseServings: 4,
    baseUnit: "g" as const,
    canonicalIngredientId: INGREDIENT_ID,
    category: "produce" as const,
    defaultPurchaseDescription: "2 lb bag",
    defaultPurchaseQuantityInBaseUnit: "907.000",
    densityGramsPerMl: null,
    gramsPerCount: "58.000",
    ingredientName: "Lemon",
    instructions: [{ instruction: "Finish with lemon.", position: 1 }],
    isOptional: false,
    planEntryId: PLAN_ENTRY_ID,
    plannedServings: 4,
    preparation: null,
    quantity: "2.000",
    quantityInBaseUnit,
    recipeId: RECIPE_ID,
    recipeIngredientId: RECIPE_INGREDIENT_ID,
    recipeTitle: "Lemon chicken",
    recipeUpdatedAt: UPDATED_AT,
    scalesLinearly: true,
    scheduledDate: "2026-08-24",
    servingsTarget: 4,
    unit: "count",
  };
}

function fixture(
  options?: Readonly<{
    basisRequirementBaseQuantity?: string;
    includeOptionalContribution?: boolean;
    pantryRecordedQuantity?: string;
    priorUsageQuantity?: string;
    requirementBaseQuantity?: string;
    selectedChoices?: unknown[];
  }>,
) {
  const requirementBaseQuantity = options?.requirementBaseQuantity ?? "113.400";
  const inserted: Array<{ table: unknown; values: Record<string, unknown> }> =
    [];
  const selectedChoices = options?.selectedChoices ?? [];
  let planEntryReadCount = 0;

  const rowsFor = (table: unknown): unknown[] => {
    if (table === mealPlans) {
      return [{ id: MEAL_PLAN_ID, weekStartDate: "2026-08-23" }];
    }
    if (table === canonicalIngredients) {
      return [
        {
          baseUnit: "g",
          defaultPurchaseDescription: "2 lb bag",
          defaultPurchaseQuantityInBaseUnit: "907.000",
          densityGramsPerMl: null,
          gramsPerCount: "58.000",
          ingredientName: "Lemon",
        },
      ];
    }
    if (table === planEntries) {
      planEntryReadCount += 1;
      if (planEntryReadCount === 2 && options?.priorUsageQuantity) {
        return [
          {
            ...reviewRow(options.priorUsageQuantity),
            planEntryId: "9da861c4-47b1-402a-8f6a-5086a2a1d028",
            recipeId: "e9224918-b1a7-410b-8fb0-2d7b05ac04db",
            recipeIngredientId: "0ec8c34d-2032-41ca-b6de-f90f46744096",
            recipeTitle: "Earlier lemon dinner",
            scheduledDate: "2026-08-20",
          },
        ];
      }
      const quantityForThisRead =
        planEntryReadCount > 1 && options?.basisRequirementBaseQuantity
          ? options.basisRequirementBaseQuantity
          : requirementBaseQuantity;
      return [
        reviewRow(quantityForThisRead),
        ...(options?.includeOptionalContribution
          ? [
              {
                ...reviewRow("58.000"),
                isOptional: true,
                planEntryId: "2c0da34f-97ad-4254-9dd4-3e9066dc4786",
                recipeId: "105f06a4-45d1-4b99-83f3-78e94085f4c7",
                recipeIngredientId: "764e87ef-c5ad-4d76-ab67-98689266f861",
                recipeTitle: "Optional lemon garnish",
              },
            ]
          : []),
      ];
    }
    if (table === pantryItems) {
      return [
        {
          canonicalIngredientId: INGREDIENT_ID,
          recordedQuantityInBaseUnit:
            options?.pantryRecordedQuantity ?? "0.000",
          recipeUsageThroughDate: "2026-08-16",
        },
      ];
    }
    if (table === pantryPackageFitChoices) return selectedChoices;
    return [];
  };

  const db: Record<string, unknown> = {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: Record<string, unknown>) => {
        inserted.push({ table, values });
        if (table === pantryPackageFitChoices) {
          const saved = {
            ...values,
            createdAt: UPDATED_AT,
            revision: 1,
            updatedAt: UPDATED_AT,
          };
          return {
            onConflictDoUpdate: vi.fn(() => ({
              returning: vi.fn(async () => [saved]),
            })),
          };
        }
        return Promise.resolve();
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const rows = rowsFor(table);
        const builder: Record<string, unknown> = {};
        const chain = () => builder;
        builder.from = chain;
        builder.innerJoin = chain;
        builder.leftJoin = chain;
        builder.where = chain;
        builder.orderBy = chain;
        builder.limit = vi.fn(async (count: number) => rows.slice(0, count));
        builder.then = (
          resolve: (value: unknown[]) => unknown,
          reject: (error: unknown) => unknown,
        ) => Promise.resolve(rows).then(resolve, reject);
        return builder;
      }),
    })),
  };
  db.transaction = vi.fn(
    async (callback: (transaction: typeof db) => Promise<unknown>) =>
      callback(db),
  );

  return {
    inserted,
    scoped: {
      db,
      scope: { householdId: HOUSEHOLD_ID, userId: USER_ID },
    } as unknown as ScopedDatabase,
  };
}

describe("pantry package-fit persistence", () => {
  it("persists 2 large lemons as 2 count and authoritative 116g, not the default bag", async () => {
    const test = fixture();

    const choice = await upsertPantryPackageFitChoice(test.scoped, {
      canonicalIngredientId: INGREDIENT_ID,
      expectedBasisHash: basisHash(),
      kind: "custom_store_amount",
      mealPlanId: MEAL_PLAN_ID,
      quantity: 2,
      shoppingLabel: "2 large lemons",
      unit: "count",
    });

    expect(choice).toMatchObject({
      customLabel: "2 large lemons",
      customQuantity: 2,
      customQuantityInBaseUnit: 116,
      customUnit: "count",
      defaultPurchaseQuantityInBaseUnit: 907,
      kind: "custom_store_amount",
    });
    expect(
      test.inserted.find((item) => item.table === pantryPackageFitChoices)
        ?.values,
    ).toMatchObject({
      customLabel: "2 large lemons",
      customQuantity: "2.000",
      customQuantityInBaseUnit: "116.000",
      customUnit: "count",
    });
    expect(test.inserted.some((item) => item.table === eventLogs)).toBe(true);
  });

  it("rejects a choice when its authoritative package basis is stale", async () => {
    const test = fixture();

    await expect(
      upsertPantryPackageFitChoice(test.scoped, {
        canonicalIngredientId: INGREDIENT_ID,
        expectedBasisHash: "0".repeat(64),
        kind: "keep_recipe_buy_enough",
        mealPlanId: MEAL_PLAN_ID,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PantryPackageFitError>>({
        code: "STALE_BASIS",
      }),
    );
    expect(test.inserted).toEqual([]);
  });

  it("opens review only for a material package mismatch", async () => {
    const material = fixture();
    const notMaterial = fixture({ requirementBaseQuantity: "600.000" });

    await expect(
      getPantryPackageFitReview(material.scoped, "2026-08-23"),
    ).resolves.toMatchObject({
      mismatches: [
        {
          ingredientName: "Lemon",
          packageCount: 1,
          surplusQuantityInBaseUnit: 793.6,
        },
      ],
    });
    await expect(
      getPantryPackageFitReview(notMaterial.scoped, "2026-08-23"),
    ).resolves.toMatchObject({ mismatches: [] });
  });

  it("uses the balance left after earlier scheduled recipe demand", async () => {
    const test = fixture({
      pantryRecordedQuantity: "100.000",
      priorUsageQuantity: "40.000",
    });

    const review = await getPantryPackageFitReview(test.scoped, "2026-08-23");

    expect(review.mismatches[0]).toMatchObject({
      currentQuantityInBaseUnit: 60,
      neededQuantityInBaseUnit: 53.4,
      requiredQuantityInBaseUnit: 113.4,
    });
  });

  it("does not offer an optional recipe line as the edit for a required mismatch", async () => {
    const test = fixture({ includeOptionalContribution: true });

    const review = await getPantryPackageFitReview(test.scoped, "2026-08-23");

    expect(review.mismatches).toHaveLength(1);
    expect(review.mismatches[0]?.requiredQuantityInBaseUnit).toBe(113.4);
    expect(
      review.mismatches[0]?.contributors.map((item) => item.recipeTitle),
    ).toEqual(["Lemon chicken"]);
  });

  it("does not attach a concurrently revalidated choice to a different displayed basis", async () => {
    const test = fixture({
      basisRequirementBaseQuantity: "600.000",
      selectedChoices: [
        {
          basisCurrentQuantityInBaseUnit: "0.000",
          basisDefaultPurchaseQuantityInBaseUnit: "907.000",
          basisHash: basisHash(600),
          basisNeededQuantityInBaseUnit: "600.000",
          basisRequiredQuantityInBaseUnit: "600.000",
          canonicalIngredientId: INGREDIENT_ID,
          customLabel: null,
          customQuantity: null,
          customQuantityInBaseUnit: null,
          customUnit: null,
          kind: "keep_recipe_buy_enough",
          mealPlanId: MEAL_PLAN_ID,
          revision: 1,
          updatedAt: UPDATED_AT,
        },
      ],
    });

    const review = await getPantryPackageFitReview(test.scoped, "2026-08-23");

    expect(review.mismatches).toHaveLength(1);
    expect(review.mismatches[0]?.basisHash).toBe(basisHash());
    expect(review.mismatches[0]?.choice).toBeNull();
  });
});
