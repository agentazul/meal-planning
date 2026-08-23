import { describe, expect, it } from "vitest";

import {
  aggregatePantryRequirements,
  selectPantryShoppingItems,
} from "./pantry";

describe("aggregatePantryRequirements", () => {
  it("scales linear requirements, aggregates them, and rounds totals", () => {
    const [rice] = aggregatePantryRequirements(
      [
        {
          canonicalIngredientId: "rice",
          quantityInBaseUnit: 100.111,
          scalesLinearly: true,
          isOptional: false,
          recipeTitle: "Rice bowls",
          baseServings: 4,
          servingsTarget: 6,
        },
        {
          canonicalIngredientId: "rice",
          quantityInBaseUnit: 30,
          scalesLinearly: true,
          isOptional: false,
          recipeTitle: "Curry",
          baseServings: 2,
          servingsTarget: 2,
        },
      ],
      [{ canonicalIngredientId: "rice", quantityInBaseUnit: 181 }],
    );

    expect(rice).toEqual({
      canonicalIngredientId: "rice",
      coverage: "enough",
      currentQuantityInBaseUnit: 181,
      optionalOnly: false,
      recipeTitles: ["Rice bowls", "Curry"],
      requiredQuantityInBaseUnit: 180.167,
      shortageQuantityInBaseUnit: 0,
    });
  });

  it("uses one quantity for non-linear requirements", () => {
    const [stock] = aggregatePantryRequirements(
      [
        {
          canonicalIngredientId: "stock",
          quantityInBaseUnit: 500,
          scalesLinearly: false,
          isOptional: false,
          recipeTitle: "Soup",
          baseServings: 2,
          servingsTarget: 8,
        },
      ],
      [{ canonicalIngredientId: "stock", quantityInBaseUnit: 499 }],
    );

    expect(stock).toMatchObject({
      requiredQuantityInBaseUnit: 500,
      shortageQuantityInBaseUnit: 1,
      coverage: "short",
    });
  });

  it("marks an ingredient optional only when every included line is optional", () => {
    const [garlic] = aggregatePantryRequirements(
      [
        {
          canonicalIngredientId: "garlic",
          quantityInBaseUnit: 5,
          scalesLinearly: true,
          isOptional: true,
          recipeTitle: "Pasta",
          baseServings: 2,
          servingsTarget: 2,
        },
        {
          canonicalIngredientId: "garlic",
          quantityInBaseUnit: 3,
          scalesLinearly: true,
          isOptional: false,
          recipeTitle: "Pasta",
          baseServings: 2,
          servingsTarget: 2,
        },
      ],
      [],
    );

    expect(garlic).toMatchObject({
      optionalOnly: false,
      recipeTitles: ["Pasta"],
      coverage: "uncounted",
    });
  });

  it("distinguishes a tracked empty balance from an uncounted ingredient", () => {
    const rows = aggregatePantryRequirements(
      [
        {
          canonicalIngredientId: "oil",
          quantityInBaseUnit: 20,
          scalesLinearly: true,
          isOptional: false,
          recipeTitle: "Salad",
          baseServings: 2,
          servingsTarget: 2,
        },
        {
          canonicalIngredientId: "vinegar",
          quantityInBaseUnit: 10,
          scalesLinearly: true,
          isOptional: false,
          recipeTitle: "Salad",
          baseServings: 2,
          servingsTarget: 2,
        },
      ],
      [{ canonicalIngredientId: "oil", quantityInBaseUnit: 0 }],
    );

    expect(rows).toMatchObject([
      { canonicalIngredientId: "oil", currentQuantityInBaseUnit: 0, coverage: "short" },
      {
        canonicalIngredientId: "vinegar",
        currentQuantityInBaseUnit: null,
        coverage: "uncounted",
        shortageQuantityInBaseUnit: 0,
      },
    ]);
  });

  it("skips requirements whose serving target is zero", () => {
    expect(
      aggregatePantryRequirements(
        [
          {
            canonicalIngredientId: "beans",
            quantityInBaseUnit: 250,
            scalesLinearly: true,
            isOptional: false,
            recipeTitle: "Chili",
            baseServings: 4,
            servingsTarget: 0,
          },
        ],
        [{ canonicalIngredientId: "beans", quantityInBaseUnit: 0 }],
      ),
    ).toEqual([]);
  });

  it("rejects invalid quantities and serving values", () => {
    expect(() =>
      aggregatePantryRequirements(
        [
          {
            canonicalIngredientId: "salt",
            quantityInBaseUnit: Number.NaN,
            scalesLinearly: true,
            isOptional: false,
            recipeTitle: "Dinner",
            baseServings: 2,
            servingsTarget: 2,
          },
        ],
        [],
      ),
    ).toThrow(RangeError);
    expect(() =>
      aggregatePantryRequirements(
        [
          {
            canonicalIngredientId: "salt",
            quantityInBaseUnit: 1,
            scalesLinearly: true,
            isOptional: false,
            recipeTitle: "Dinner",
            baseServings: 0,
            servingsTarget: 2,
          },
        ],
        [],
      ),
    ).toThrow("Base servings for Dinner must be a finite number greater than zero.");
    expect(() =>
      aggregatePantryRequirements([], [
        { canonicalIngredientId: "salt", quantityInBaseUnit: -1 },
      ]),
    ).toThrow(RangeError);
  });
});

describe("selectPantryShoppingItems", () => {
  const row = (
    canonicalIngredientId: string,
    coverage: "uncounted" | "short" | "enough",
    optionalOnly = false,
  ) => ({
    canonicalIngredientId,
    coverage,
    currentQuantityInBaseUnit:
      coverage === "uncounted" ? null : coverage === "short" ? 0 : 10,
    optionalOnly,
    recipeTitles: ["Dinner"],
    requiredQuantityInBaseUnit: 10,
    shortageQuantityInBaseUnit: coverage === "short" ? 10 : 0,
  });

  it("selects tracked zero and partial shortages as exact buy items", () => {
    const trackedEmpty = row("oil", "short");
    const partial = { ...row("rice", "short"), shortageQuantityInBaseUnit: 2 };

    expect(selectPantryShoppingItems([trackedEmpty, partial])).toEqual({
      buyItems: [trackedEmpty, partial],
      checkFirstItems: [],
      optionalItems: [],
      coveredCount: 0,
    });
  });

  it("keeps uncounted required ingredients as check-first items", () => {
    const uncounted = row("vinegar", "uncounted");

    expect(selectPantryShoppingItems([uncounted])).toEqual({
      buyItems: [],
      checkFirstItems: [uncounted],
      optionalItems: [],
      coveredCount: 0,
    });
  });

  it("excludes enough rows and counts them as covered", () => {
    const enough = row("salt", "enough");

    expect(selectPantryShoppingItems([enough])).toEqual({
      buyItems: [],
      checkFirstItems: [],
      optionalItems: [],
      coveredCount: 1,
    });
  });

  it(
    "keeps optional-only rows needing attention separate with coverage intact",
    () => {
      const optionalShort = row("cilantro", "short", true);
      const optionalUncounted = row("lime", "uncounted", true);

      expect(
        selectPantryShoppingItems([optionalShort, optionalUncounted]),
      ).toEqual({
        buyItems: [],
        checkFirstItems: [],
        optionalItems: [optionalShort, optionalUncounted],
        coveredCount: 0,
      });
      expect(optionalShort.coverage).toBe("short");
      expect(optionalUncounted.coverage).toBe("uncounted");
    },
  );

  it("does not mutate the input rows", () => {
    const rows = [row("oil", "short"), row("salt", "enough")];
    const before = [...rows];

    selectPantryShoppingItems(rows);

    expect(rows).toEqual(before);
  });
});
