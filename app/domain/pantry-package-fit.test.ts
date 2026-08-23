import { describe, expect, it } from "vitest";

import type {
  PantryRequirementContribution,
  PantryRequirementRow,
} from "./pantry";
import { analyzePantryPackageFit } from "./pantry-package-fit";

function contribution(
  overrides: Partial<PantryRequirementContribution> = {},
): PantryRequirementContribution {
  return {
    baseServings: 4,
    isOptional: false,
    planEntryId: "entry-1",
    preparation: "trimmed",
    recipeId: "recipe-1",
    recipeIngredientId: "line-1",
    recipeTitle: "Dinner",
    requiredQuantityInBaseUnit: 453.592,
    scalesLinearly: true,
    scheduledDate: "2026-08-24",
    servingsTarget: 4,
    storedQuantity: 16,
    storedQuantityInBaseUnit: 453.592,
    storedUnit: "oz",
    ...overrides,
  };
}

function requirement(
  requiredQuantityInBaseUnit: number,
  contributions: readonly PantryRequirementContribution[] = [
    contribution({
      requiredQuantityInBaseUnit,
      storedQuantityInBaseUnit: requiredQuantityInBaseUnit,
    }),
  ],
): PantryRequirementRow {
  return {
    canonicalIngredientId: "ingredient-1",
    contributions,
    coverage: "short",
    currentQuantityInBaseUnit: 0,
    optionalOnly: false,
    recipeTitles: [...new Set(contributions.map((item) => item.recipeTitle))],
    requiredQuantityInBaseUnit,
    shortageQuantityInBaseUnit: requiredQuantityInBaseUnit,
  };
}

describe("analyzePantryPackageFit", () => {
  it("reviews two 12 ounce bags for a 16 ounce green-bean recipe", () => {
    const result = analyzePantryPackageFit({
      ingredientCategory: "produce",
      packageQuantityInBaseUnit: 340,
      requirement: requirement(453.592),
    });

    expect(result).toMatchObject({
      packageCount: 2,
      reason: "one-fewer-package-nearly-covers",
      reducedPurchaseQuantityInBaseUnit: 340,
      recipeQuantitySuggestions: [
        {
          riskFlags: [],
          storedQuantity: 16,
          storedUnit: "oz",
          suggestedQuantity: 11.993,
          suggestedQuantityInBaseUnit: 340,
        },
      ],
    });
    expect(result?.oneFewerPackageCoverageRatio).toBeCloseTo(0.75, 3);
    expect(result?.unusedFinalPackageRatio).toBeGreaterThan(0.66);
  });

  it.each([
    ["ground turkey", 680.389],
    ["salmon fillet", 566.99],
    ["shrimp", 566.99],
  ])("flags a permanent %s reduction as a protein risk", (_name, needed) => {
    const storedQuantity = needed === 680.389 ? 1.5 : 1.25;
    const result = analyzePantryPackageFit({
      ingredientCategory: "protein",
      packageQuantityInBaseUnit: 454,
      requirement: requirement(needed, [
        contribution({
          preparation: null,
          requiredQuantityInBaseUnit: needed,
          storedQuantity,
          storedQuantityInBaseUnit: needed,
          storedUnit: "lb",
        }),
      ]),
    });

    expect(result).not.toBeNull();
    expect(result?.packageCount).toBe(2);
    expect(result?.recipeQuantitySuggestions[0]?.riskFlags).toContain(
      "protein",
    );
    expect(
      result?.recipeQuantitySuggestions[0]?.suggestedQuantityInBaseUnit,
    ).toBe(454);
  });

  it("treats the exact two-thirds coverage and half-unused boundaries as reviewable", () => {
    const result = analyzePantryPackageFit({
      ingredientCategory: "pantry",
      packageQuantityInBaseUnit: 100,
      requirement: requirement(150),
    });

    expect(result?.oneFewerPackageCoverageRatio).toBeCloseTo(2 / 3, 10);
    expect(result?.unusedFinalPackageRatio).toBe(0.5);
    expect(result?.reason).toBe("one-fewer-package-nearly-covers");
  });

  it("recognizes two lemons as a covering alternative to an oversized bag", () => {
    const result = analyzePantryPackageFit({
      alternateStoreAmounts: [
        {
          label: "2 large lemons",
          quantity: 2,
          quantityInBaseUnit: 116,
          unit: "count",
        },
      ],
      ingredientCategory: "produce",
      packageQuantityInBaseUnit: 907,
      requirement: requirement(113.4, [
        contribution({
          requiredQuantityInBaseUnit: 113.4,
          storedQuantity: 4,
          storedQuantityInBaseUnit: 113.4,
          storedUnit: "oz",
        }),
      ]),
    });

    expect(result).toMatchObject({
      coveringAlternateStoreAmounts: [
        { label: "2 large lemons", quantity: 2, unit: "count" },
      ],
      packageCount: 1,
      reason: "oversized-single-package",
      recipeQuantitySuggestions: [],
    });
  });

  it("excludes uncounted and optional-only demand", () => {
    const uncounted = {
      ...requirement(453.592),
      coverage: "uncounted" as const,
      currentQuantityInBaseUnit: null,
      shortageQuantityInBaseUnit: 0,
    };
    const optional = {
      ...requirement(453.592),
      optionalOnly: true,
    };

    expect(
      analyzePantryPackageFit({
        ingredientCategory: "produce",
        packageQuantityInBaseUnit: 340,
        requirement: uncounted,
      }),
    ).toBeNull();
    expect(
      analyzePantryPackageFit({
        ingredientCategory: "produce",
        packageQuantityInBaseUnit: 340,
        requirement: optional,
      }),
    ).toBeNull();
  });

  it("retains independent contributor choices without mutating the row", () => {
    const contributions = [
      contribution({
        recipeId: "recipe-a",
        recipeIngredientId: "line-a",
        recipeTitle: "Dinner A",
        requiredQuantityInBaseUnit: 300,
        storedQuantity: 300,
        storedQuantityInBaseUnit: 300,
        storedUnit: "g",
      }),
      contribution({
        planEntryId: "entry-2",
        recipeId: "recipe-b",
        recipeIngredientId: "line-b",
        recipeTitle: "Dinner B",
        requiredQuantityInBaseUnit: 200,
        storedQuantity: 200,
        storedQuantityInBaseUnit: 200,
        storedUnit: "g",
      }),
    ] as const;
    const row = requirement(500, contributions);
    const before = structuredClone(row);

    const result = analyzePantryPackageFit({
      ingredientCategory: "produce",
      packageQuantityInBaseUnit: 340,
      requirement: row,
    });

    expect(
      result?.recipeQuantitySuggestions.map((item) => item.recipeId),
    ).toEqual(["recipe-a", "recipe-b"]);
    expect(row).toEqual(before);
  });

  it("flags nonlinear, fractional-count, and repeated recipe-line effects", () => {
    const repeated = [
      contribution({
        planEntryId: "entry-1",
        recipeIngredientId: "shared-line",
        requiredQuantityInBaseUnit: 2,
        scalesLinearly: false,
        storedQuantity: 2,
        storedQuantityInBaseUnit: 2,
        storedUnit: "count",
      }),
      contribution({
        planEntryId: "entry-2",
        recipeIngredientId: "shared-line",
        requiredQuantityInBaseUnit: 2,
        scalesLinearly: false,
        scheduledDate: "2026-08-26",
        storedQuantity: 2,
        storedQuantityInBaseUnit: 2,
        storedUnit: "count",
      }),
    ];
    const result = analyzePantryPackageFit({
      ingredientCategory: "produce",
      packageQuantityInBaseUnit: 3,
      requirement: requirement(4, repeated),
    });

    expect(result?.recipeQuantitySuggestions[0]?.suggestedQuantity).toBe(1.5);
    expect(result?.recipeQuantitySuggestions[0]?.riskFlags).toEqual([
      "nonlinear",
      "fractional-count",
      "repeated-recipe-line-use",
    ]);
  });
});
