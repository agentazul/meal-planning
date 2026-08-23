import { describe, expect, it } from "vitest";

import {
  aggregatePantryRequirements,
  selectPantryShoppingItems,
  type PantryRecipeRequirement,
} from "./pantry";

let requirementSequence = 0;

function requirement(
  overrides: Partial<PantryRecipeRequirement> &
    Pick<
      PantryRecipeRequirement,
      "canonicalIngredientId" | "quantityInBaseUnit" | "recipeTitle"
    >,
): PantryRecipeRequirement {
  requirementSequence += 1;
  return {
    baseServings: 2,
    isOptional: false,
    planEntryId: `plan-${requirementSequence}`,
    preparation: null,
    quantity: overrides.quantityInBaseUnit,
    recipeId: `recipe-${requirementSequence}`,
    recipeIngredientId: `line-${requirementSequence}`,
    scalesLinearly: true,
    scheduledDate: `2026-08-${String(requirementSequence).padStart(2, "0")}`,
    servingsTarget: 2,
    unit: "g",
    ...overrides,
  };
}

describe("aggregatePantryRequirements", () => {
  it("scales linear requirements, aggregates them, and rounds totals", () => {
    const [rice] = aggregatePantryRequirements(
      [
        requirement({
          canonicalIngredientId: "rice",
          quantityInBaseUnit: 100.111,
          scalesLinearly: true,
          isOptional: false,
          recipeTitle: "Rice bowls",
          baseServings: 4,
          servingsTarget: 6,
        }),
        requirement({
          canonicalIngredientId: "rice",
          quantityInBaseUnit: 30,
          scalesLinearly: true,
          isOptional: false,
          recipeTitle: "Curry",
          baseServings: 2,
          servingsTarget: 2,
        }),
      ],
      [{ canonicalIngredientId: "rice", quantityInBaseUnit: 181 }],
    );

    expect(rice).toMatchObject({
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
        requirement({
          canonicalIngredientId: "stock",
          quantityInBaseUnit: 500,
          scalesLinearly: false,
          isOptional: false,
          recipeTitle: "Soup",
          baseServings: 2,
          servingsTarget: 8,
        }),
      ],
      [{ canonicalIngredientId: "stock", quantityInBaseUnit: 499 }],
    );

    expect(stock).toMatchObject({
      requiredQuantityInBaseUnit: 500,
      shortageQuantityInBaseUnit: 1,
      coverage: "short",
    });
  });

  it("treats rounded package equivalents within 0.1% as covered", () => {
    const [greenBean] = aggregatePantryRequirements(
      [
        requirement({
          canonicalIngredientId: "green-bean",
          quantityInBaseUnit: 453.592,
          recipeTitle: "Green beans",
          baseServings: 4,
          servingsTarget: 3,
        }),
      ],
      [{ canonicalIngredientId: "green-bean", quantityInBaseUnit: 340 }],
    );

    expect(greenBean).toMatchObject({
      coverage: "enough",
      currentQuantityInBaseUnit: 340,
      requiredQuantityInBaseUnit: 340.194,
      shortageQuantityInBaseUnit: 0,
    });
  });

  it("preserves the exact rounded shortage outside the coverage tolerance", () => {
    const [greenBean] = aggregatePantryRequirements(
      [
        requirement({
          canonicalIngredientId: "green-bean",
          quantityInBaseUnit: 453.592,
          recipeTitle: "Green beans",
          baseServings: 4,
          servingsTarget: 3,
        }),
      ],
      [{ canonicalIngredientId: "green-bean", quantityInBaseUnit: 339 }],
    );

    expect(greenBean).toMatchObject({
      coverage: "short",
      currentQuantityInBaseUnit: 339,
      requiredQuantityInBaseUnit: 340.194,
      shortageQuantityInBaseUnit: 1.194,
    });
  });

  it("marks an ingredient optional only when every included line is optional", () => {
    const [garlic] = aggregatePantryRequirements(
      [
        requirement({
          canonicalIngredientId: "garlic",
          quantityInBaseUnit: 5,
          scalesLinearly: true,
          isOptional: true,
          recipeTitle: "Pasta",
          baseServings: 2,
          servingsTarget: 2,
        }),
        requirement({
          canonicalIngredientId: "garlic",
          quantityInBaseUnit: 3,
          scalesLinearly: true,
          isOptional: false,
          recipeTitle: "Pasta",
          baseServings: 2,
          servingsTarget: 2,
        }),
      ],
      [],
    );

    expect(garlic).toMatchObject({
      optionalOnly: false,
      recipeTitles: ["Pasta"],
      coverage: "uncounted",
      requiredQuantityInBaseUnit: 3,
    });
    expect(garlic?.contributions).toHaveLength(2);
    expect(garlic?.contributions.map((item) => item.isOptional)).toEqual([
      true,
      false,
    ]);
  });

  it("preserves per-plan-entry recipe contribution provenance", () => {
    const [beans] = aggregatePantryRequirements(
      [
        requirement({
          baseServings: 4,
          canonicalIngredientId: "green-bean",
          isOptional: false,
          planEntryId: "monday-entry",
          preparation: "trimmed",
          quantity: 16,
          quantityInBaseUnit: 453.592,
          recipeId: "recipe-green-beans",
          recipeIngredientId: "line-green-beans",
          recipeTitle: "Steamed Green Beans",
          scalesLinearly: true,
          scheduledDate: "2026-08-24",
          servingsTarget: 3,
          unit: "oz",
        }),
      ],
      [],
    );

    expect(beans?.contributions).toEqual([
      {
        baseServings: 4,
        isOptional: false,
        planEntryId: "monday-entry",
        preparation: "trimmed",
        recipeId: "recipe-green-beans",
        recipeIngredientId: "line-green-beans",
        recipeTitle: "Steamed Green Beans",
        requiredQuantityInBaseUnit: 340.194,
        scalesLinearly: true,
        scheduledDate: "2026-08-24",
        servingsTarget: 3,
        storedQuantity: 16,
        storedQuantityInBaseUnit: 453.592,
        storedUnit: "oz",
      },
    ]);
  });

  it("distinguishes a tracked empty balance from an uncounted ingredient", () => {
    const rows = aggregatePantryRequirements(
      [
        requirement({
          canonicalIngredientId: "oil",
          quantityInBaseUnit: 20,
          scalesLinearly: true,
          isOptional: false,
          recipeTitle: "Salad",
          baseServings: 2,
          servingsTarget: 2,
        }),
        requirement({
          canonicalIngredientId: "vinegar",
          quantityInBaseUnit: 10,
          scalesLinearly: true,
          isOptional: false,
          recipeTitle: "Salad",
          baseServings: 2,
          servingsTarget: 2,
        }),
      ],
      [{ canonicalIngredientId: "oil", quantityInBaseUnit: 0 }],
    );

    expect(rows).toMatchObject([
      {
        canonicalIngredientId: "oil",
        currentQuantityInBaseUnit: 0,
        coverage: "short",
      },
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
          requirement({
            canonicalIngredientId: "beans",
            quantityInBaseUnit: 250,
            scalesLinearly: true,
            isOptional: false,
            recipeTitle: "Chili",
            baseServings: 4,
            servingsTarget: 0,
          }),
        ],
        [{ canonicalIngredientId: "beans", quantityInBaseUnit: 0 }],
      ),
    ).toEqual([]);
  });

  it("rejects invalid quantities and serving values", () => {
    expect(() =>
      aggregatePantryRequirements(
        [
          requirement({
            canonicalIngredientId: "salt",
            quantityInBaseUnit: Number.NaN,
            scalesLinearly: true,
            isOptional: false,
            recipeTitle: "Dinner",
            baseServings: 2,
            servingsTarget: 2,
          }),
        ],
        [],
      ),
    ).toThrow(RangeError);
    expect(() =>
      aggregatePantryRequirements(
        [
          requirement({
            canonicalIngredientId: "salt",
            quantityInBaseUnit: 1,
            scalesLinearly: true,
            isOptional: false,
            recipeTitle: "Dinner",
            baseServings: 0,
            servingsTarget: 2,
          }),
        ],
        [],
      ),
    ).toThrow(
      "Base servings for Dinner must be a finite number greater than zero.",
    );
    expect(() =>
      aggregatePantryRequirements(
        [],
        [{ canonicalIngredientId: "salt", quantityInBaseUnit: -1 }],
      ),
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
    contributions: [],
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

  it("keeps optional-only rows needing attention separate with coverage intact", () => {
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
  });

  it("does not mutate the input rows", () => {
    const rows = [row("oil", "short"), row("salt", "enough")];
    const before = [...rows];

    selectPantryShoppingItems(rows);

    expect(rows).toEqual(before);
  });
});
