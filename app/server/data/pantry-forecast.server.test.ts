import { describe, expect, it, vi } from "vitest";

import type { ScopedDatabase } from "~/server/context.server";
import { listPantryBalanceForecast } from "./pantry-forecast.server";

const HOUSEHOLD_ID = "f8044a3a-b8e1-4bea-a3db-d8f4f322b411";

function databaseFixture(
  balances: readonly Readonly<Record<string, unknown>>[],
  requirements: readonly Readonly<Record<string, unknown>>[],
) {
  const select = vi.fn((selection: Readonly<Record<string, unknown>>) => {
    if ("recordedQuantityInBaseUnit" in selection) {
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(async () => balances),
          })),
        })),
      };
    }
    return {
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(async () => requirements),
            })),
          })),
        })),
      })),
    };
  });
  return {
    database: { select } as unknown as ScopedDatabase["db"],
    select,
  };
}

function requirement(input: {
  canonicalIngredientId: string;
  quantityInBaseUnit: number;
  scheduledDate: string;
}) {
  return {
    baseServings: 4,
    canonicalIngredientId: input.canonicalIngredientId,
    isOptional: false,
    planEntryId: `plan-${input.canonicalIngredientId}`,
    preparation: null,
    quantity: input.quantityInBaseUnit.toFixed(3),
    quantityInBaseUnit: input.quantityInBaseUnit.toFixed(3),
    recipeId: `recipe-${input.canonicalIngredientId}`,
    recipeIngredientId: `line-${input.canonicalIngredientId}`,
    recipeTitle: `Dinner ${input.canonicalIngredientId}`,
    scalesLinearly: true,
    scheduledDate: input.scheduledDate,
    servingsTarget: 4,
    unit: "g",
  };
}

describe("listPantryBalanceForecast", () => {
  it("projects bought amounts through prior scheduled recipe demand", async () => {
    const subject = databaseFixture(
      [
        {
          canonicalIngredientId: "chicken",
          recordedQuantityInBaseUnit: "900.000",
          recipeUsageThroughDate: "2026-08-22",
        },
        {
          canonicalIngredientId: "spinach",
          recordedQuantityInBaseUnit: "300.000",
          recipeUsageThroughDate: "2026-08-22",
        },
        {
          canonicalIngredientId: "rice",
          recordedQuantityInBaseUnit: "800.000",
          recipeUsageThroughDate: "2026-08-22",
        },
        {
          canonicalIngredientId: "broccoli",
          recordedQuantityInBaseUnit: "400.000",
          recipeUsageThroughDate: "2026-08-22",
        },
      ],
      [
        requirement({
          canonicalIngredientId: "chicken",
          quantityInBaseUnit: 900,
          scheduledDate: "2026-08-24",
        }),
        requirement({
          canonicalIngredientId: "spinach",
          quantityInBaseUnit: 120,
          scheduledDate: "2026-08-25",
        }),
        requirement({
          canonicalIngredientId: "rice",
          quantityInBaseUnit: 400,
          scheduledDate: "2026-08-26",
        }),
        requirement({
          canonicalIngredientId: "broccoli",
          quantityInBaseUnit: 400,
          scheduledDate: "2026-08-27",
        }),
      ],
    );

    await expect(
      listPantryBalanceForecast(subject.database, {
        beforeDate: "2026-08-30",
        householdId: HOUSEHOLD_ID,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        canonicalIngredientId: "chicken",
        projectedQuantityInBaseUnit: 0,
      }),
      expect.objectContaining({
        canonicalIngredientId: "spinach",
        projectedQuantityInBaseUnit: 180,
      }),
      expect.objectContaining({
        canonicalIngredientId: "rice",
        projectedQuantityInBaseUnit: 400,
      }),
      expect.objectContaining({
        canonicalIngredientId: "broccoli",
        projectedQuantityInBaseUnit: 0,
      }),
    ]);
  });

  it("does not query recipe commitments when nothing has been counted", async () => {
    const subject = databaseFixture([], []);

    await expect(
      listPantryBalanceForecast(subject.database, {
        beforeDate: "2026-08-30",
        householdId: HOUSEHOLD_ID,
      }),
    ).resolves.toEqual([]);
    expect(subject.select).toHaveBeenCalledOnce();
  });
});
