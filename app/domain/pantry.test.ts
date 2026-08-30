import { describe, expect, it } from "vitest";

import {
  aggregatePantryRequirements,
  forecastPantryBalances,
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

describe("forecastPantryBalances", () => {
  const forecastRequirement = (
    canonicalIngredientId: string,
    quantityInBaseUnit: number,
    scheduledDate: string,
    overrides: Partial<PantryRecipeRequirement> = {},
  ): PantryRecipeRequirement => ({
    baseServings: 4,
    canonicalIngredientId,
    isOptional: false,
    planEntryId: `plan-${canonicalIngredientId}-${scheduledDate}`,
    preparation: null,
    quantity: quantityInBaseUnit,
    quantityInBaseUnit,
    recipeId: `recipe-${canonicalIngredientId}-${scheduledDate}`,
    recipeIngredientId: `line-${canonicalIngredientId}-${scheduledDate}`,
    recipeTitle: `${canonicalIngredientId} dinner`,
    scalesLinearly: true,
    scheduledDate,
    servingsTarget: 4,
    unit: "g",
    ...overrides,
  });

  const balance = (
    canonicalIngredientId: string,
    recordedQuantityInBaseUnit: number,
    recipeUsageThroughDate = "2026-08-23",
  ) => ({
    canonicalIngredientId,
    recordedQuantityInBaseUnit,
    recipeUsageThroughDate,
  });

  it("projects fully used chicken and broccoli to tracked zero", () => {
    expect(
      forecastPantryBalances({
        balances: [balance("chicken", 300), balance("broccoli", 200)],
        beforeDate: "2026-08-31",
        requirements: [
          forecastRequirement("chicken", 300, "2026-08-24"),
          forecastRequirement("broccoli", 200, "2026-08-25"),
        ],
      }),
    ).toEqual([
      {
        canonicalIngredientId: "chicken",
        estimatedUsageInBaseUnit: 300,
        projectedQuantityInBaseUnit: 0,
        recipeUsageThroughDate: "2026-08-23",
        recordedQuantityInBaseUnit: 300,
      },
      {
        canonicalIngredientId: "broccoli",
        estimatedUsageInBaseUnit: 200,
        projectedQuantityInBaseUnit: 0,
        recipeUsageThroughDate: "2026-08-23",
        recordedQuantityInBaseUnit: 200,
      },
    ]);
  });

  it("leaves half of tracked spinach and rice", () => {
    expect(
      forecastPantryBalances({
        balances: [balance("spinach", 200), balance("rice", 400)],
        beforeDate: "2026-08-31",
        requirements: [
          forecastRequirement("spinach", 100, "2026-08-24"),
          forecastRequirement("rice", 200, "2026-08-25"),
        ],
      }).map((item) => [
        item.canonicalIngredientId,
        item.projectedQuantityInBaseUnit,
      ]),
    ).toEqual([
      ["spinach", 100],
      ["rice", 200],
    ]);
  });

  it("aggregates scaled usage across multiple scheduled meals", () => {
    const [rice] = forecastPantryBalances({
      balances: [balance("rice", 500)],
      beforeDate: "2026-08-31",
      requirements: [
        forecastRequirement("rice", 100, "2026-08-24", {
          baseServings: 4,
          servingsTarget: 3,
        }),
        forecastRequirement("rice", 100, "2026-08-27", {
          baseServings: 4,
          servingsTarget: 5,
        }),
      ],
    });

    expect(rice).toMatchObject({
      estimatedUsageInBaseUnit: 200,
      projectedQuantityInBaseUnit: 300,
    });
  });

  it("excludes optional and zero-serving recipe lines", () => {
    const [cilantro] = forecastPantryBalances({
      balances: [balance("cilantro", 30)],
      beforeDate: "2026-08-31",
      requirements: [
        forecastRequirement("cilantro", 10, "2026-08-24", {
          isOptional: true,
        }),
        forecastRequirement("cilantro", 10, "2026-08-25", {
          servingsTarget: 0,
        }),
      ],
    });

    expect(cilantro).toMatchObject({
      estimatedUsageInBaseUnit: 0,
      projectedQuantityInBaseUnit: 30,
    });
  });

  it("uses one stored quantity for a nonlinear recipe line", () => {
    const [stock] = forecastPantryBalances({
      balances: [balance("stock", 750)],
      beforeDate: "2026-08-31",
      requirements: [
        forecastRequirement("stock", 500, "2026-08-24", {
          baseServings: 2,
          scalesLinearly: false,
          servingsTarget: 8,
        }),
      ],
    });

    expect(stock).toMatchObject({
      estimatedUsageInBaseUnit: 500,
      projectedQuantityInBaseUnit: 250,
    });
  });

  it("excludes usage on the checkpoint boundary", () => {
    const [beans] = forecastPantryBalances({
      balances: [balance("beans", 300, "2026-08-25")],
      beforeDate: "2026-08-31",
      requirements: [
        forecastRequirement("beans", 100, "2026-08-25"),
        forecastRequirement("beans", 100, "2026-08-26"),
      ],
    });

    expect(beans).toMatchObject({
      estimatedUsageInBaseUnit: 100,
      projectedQuantityInBaseUnit: 200,
    });
  });

  it("excludes usage on the before-date boundary", () => {
    const [pasta] = forecastPantryBalances({
      balances: [balance("pasta", 300)],
      beforeDate: "2026-08-31",
      requirements: [
        forecastRequirement("pasta", 100, "2026-08-30"),
        forecastRequirement("pasta", 100, "2026-08-31"),
      ],
    });

    expect(pasta).toMatchObject({
      estimatedUsageInBaseUnit: 100,
      projectedQuantityInBaseUnit: 200,
    });
  });

  it("treats a later manual correction as the new usage checkpoint", () => {
    const requirements = [
      forecastRequirement("rice", 100, "2026-08-24"),
      forecastRequirement("rice", 100, "2026-08-28"),
    ];
    const [corrected] = forecastPantryBalances({
      balances: [balance("rice", 350, "2026-08-27")],
      beforeDate: "2026-08-31",
      requirements,
    });

    expect(corrected).toEqual({
      canonicalIngredientId: "rice",
      estimatedUsageInBaseUnit: 100,
      projectedQuantityInBaseUnit: 250,
      recipeUsageThroughDate: "2026-08-27",
      recordedQuantityInBaseUnit: 350,
    });
  });

  it("clamps projected quantities at zero", () => {
    const [chicken] = forecastPantryBalances({
      balances: [balance("chicken", 100)],
      beforeDate: "2026-08-31",
      requirements: [forecastRequirement("chicken", 250, "2026-08-24")],
    });

    expect(chicken).toMatchObject({
      estimatedUsageInBaseUnit: 250,
      projectedQuantityInBaseUnit: 0,
    });
  });

  it("rounds usage and the unrounded projected balance to three decimals", () => {
    const [rice] = forecastPantryBalances({
      balances: [balance("rice", 5)],
      beforeDate: "2026-08-31",
      requirements: [
        forecastRequirement("rice", 1.2345, "2026-08-24", {
          quantity: 1.2345,
        }),
      ],
    });

    expect(rice).toMatchObject({
      estimatedUsageInBaseUnit: 1.234,
      projectedQuantityInBaseUnit: 3.766,
    });
  });

  it("preserves input ordering and a tracked zero balance", () => {
    const balances = [
      balance("oil", 0),
      balance("flour", 500),
      balance("salt", 20),
    ];

    const result = forecastPantryBalances({
      balances,
      beforeDate: "2026-08-31",
      requirements: [],
    });

    expect(result.map((item) => item.canonicalIngredientId)).toEqual([
      "oil",
      "flour",
      "salt",
    ]);
    expect(result[0]).toMatchObject({
      recordedQuantityInBaseUnit: 0,
      projectedQuantityInBaseUnit: 0,
    });
    expect(balances).toEqual([
      balance("oil", 0),
      balance("flour", 500),
      balance("salt", 20),
    ]);
  });

  it("rejects invalid quantities and date-only inputs", () => {
    expect(() =>
      forecastPantryBalances({
        balances: [balance("rice", Number.NaN)],
        beforeDate: "2026-08-31",
        requirements: [],
      }),
    ).toThrow(RangeError);
    expect(() =>
      forecastPantryBalances({
        balances: [balance("rice", 100, "2026-02-30")],
        beforeDate: "2026-08-31",
        requirements: [],
      }),
    ).toThrow();
    expect(() =>
      forecastPantryBalances({
        balances: [balance("rice", 100)],
        beforeDate: "08/31/2026",
        requirements: [],
      }),
    ).toThrow('Expected a date in YYYY-MM-DD format, received "08/31/2026"');
    expect(() =>
      forecastPantryBalances({
        balances: [balance("rice", 100)],
        beforeDate: "2026-08-31",
        requirements: [
          forecastRequirement("rice", Number.POSITIVE_INFINITY, "2026-08-24"),
        ],
      }),
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
