import { describe, expect, it } from "vitest";

import {
  formatRecipeTextForUsKitchen,
  formatUsRecipeQuantity,
} from "./us-kitchen-display";

describe("formatUsRecipeQuantity", () => {
  it("converts metric mass to natural ounces and pounds", () => {
    expect(formatUsRecipeQuantity({ quantity: 400, unit: "g" })).toBe(
      "14 ounces",
    );
    expect(formatUsRecipeQuantity({ quantity: 453.59237, unit: "g" })).toBe(
      "1 pound",
    );
    expect(formatUsRecipeQuantity({ quantity: 1, unit: "kg" })).toBe(
      "2 1/4 pounds",
    );
  });

  it("chooses practical kitchen measures for metric volume", () => {
    expect(formatUsRecipeQuantity({ quantity: 5, unit: "ml" })).toBe(
      "1 teaspoon",
    );
    expect(formatUsRecipeQuantity({ quantity: 30, unit: "ml" })).toBe(
      "2 tablespoons",
    );
    expect(formatUsRecipeQuantity({ quantity: 250, unit: "ml" })).toBe(
      "1 cup",
    );
    expect(formatUsRecipeQuantity({ quantity: 1, unit: "l" })).toBe(
      "4 1/4 cups",
    );
  });

  it("uses recipe fractions and singular or plural labels", () => {
    expect(formatUsRecipeQuantity({ quantity: 0.5, unit: "cup" })).toBe(
      "1/2 cup",
    );
    expect(formatUsRecipeQuantity({ quantity: 1.5, unit: "cup" })).toBe(
      "1 1/2 cups",
    );
    expect(formatUsRecipeQuantity({ quantity: 16, unit: "oz" })).toBe(
      "1 pound",
    );
    expect(formatUsRecipeQuantity({ quantity: 2, unit: "count" })).toBe("2");
  });

  it("preserves distinctions between small seasoning weights", () => {
    expect(formatUsRecipeQuantity({ quantity: 2, unit: "g" })).toBe(
      "1/16 ounce",
    );
    expect(formatUsRecipeQuantity({ quantity: 3, unit: "g" })).toBe(
      "1/8 ounce",
    );
    expect(formatUsRecipeQuantity({ quantity: 5, unit: "g" })).toBe(
      "3/16 ounce",
    );
    expect(formatUsRecipeQuantity({ quantity: 8, unit: "g" })).toBe(
      "5/16 ounce",
    );
    expect(formatUsRecipeQuantity({ quantity: 10, unit: "g" })).toBe(
      "3/8 ounce",
    );
    expect(formatUsRecipeQuantity({ quantity: 14, unit: "g" })).toBe(
      "1/2 ounce",
    );
    expect(formatUsRecipeQuantity({ quantity: 15, unit: "g" })).toBe(
      "1/2 ounce",
    );
    expect(formatUsRecipeQuantity({ quantity: 0.1, unit: "oz" })).toBe(
      "1/8 ounce",
    );
  });

  it("converts representative saved metric masses without collapsing them", () => {
    expect(formatUsRecipeQuantity({ quantity: 113, unit: "g" })).toBe(
      "4 ounces",
    );
    expect(formatUsRecipeQuantity({ quantity: 340, unit: "g" })).toBe(
      "12 ounces",
    );
    expect(formatUsRecipeQuantity({ quantity: 680, unit: "g" })).toBe(
      "1 1/2 pounds",
    );
    expect(formatUsRecipeQuantity({ quantity: 900, unit: "g" })).toBe(
      "2 pounds",
    );
  });

  it("converts representative saved metric volumes to kitchen measures", () => {
    expect(formatUsRecipeQuantity({ quantity: 5, unit: "ml" })).toBe(
      "1 teaspoon",
    );
    expect(formatUsRecipeQuantity({ quantity: 10, unit: "ml" })).toBe(
      "2 teaspoons",
    );
    expect(formatUsRecipeQuantity({ quantity: 15, unit: "ml" })).toBe(
      "1 tablespoon",
    );
    expect(formatUsRecipeQuantity({ quantity: 22, unit: "ml" })).toBe(
      "1 1/2 tablespoons",
    );
    expect(formatUsRecipeQuantity({ quantity: 120, unit: "ml" })).toBe(
      "1/2 cup",
    );
    expect(formatUsRecipeQuantity({ quantity: 480, unit: "ml" })).toBe(
      "2 cups",
    );
    expect(formatUsRecipeQuantity({ quantity: 600, unit: "ml" })).toBe(
      "2 1/2 cups",
    );
  });

  it("rejects invalid presentation input", () => {
    expect(() => formatUsRecipeQuantity({ quantity: 0, unit: "cup" })).toThrow(
      RangeError,
    );
    expect(() =>
      formatUsRecipeQuantity({ quantity: 2, unit: "pinch" }),
    ).toThrow(RangeError);
  });

  it("uses a canonical fallback for a legacy unit label", () => {
    expect(
      formatUsRecipeQuantity({
        baseUnit: "ml",
        quantity: 1,
        quantityInBaseUnit: 236.588,
        unit: "legacy_scoop",
      }),
    ).toBe("1 cup");
  });
});

describe("formatRecipeTextForUsKitchen", () => {
  it("converts metric quantities and Celsius in instructions", () => {
    expect(
      formatRecipeTextForUsKitchen(
        "Bake 400 g chicken with 250 ml stock at 180°C.",
      ),
    ).toBe("Bake 14 ounces chicken with 1 cup stock at 356°F.");
  });

  it("converts ranges and metric lengths without leaving mixed units", () => {
    expect(
      formatRecipeTextForUsKitchen(
        "Add 200-250 ml broth and cut carrots into 1 to 2 cm pieces.",
      ),
    ).toBe(
      "Add 7/8 cup to 1 cup broth and cut carrots into 3/8 inch to 3/4 inch pieces.",
    );
  });

  it("handles grouped quantities and legacy meter measurements", () => {
    expect(
      formatRecipeTextForUsKitchen(
        "Use 1,000 g potatoes and keep the cord 1 m away.",
      ),
    ).toBe("Use 2 1/4 pounds potatoes and keep the cord 39 3/8 inches away.");
  });

  it("removes metric tokens from representative saved instruction prose", () => {
    const displayed = formatRecipeTextForUsKitchen(
      "Mix 2 g spice with 22 ml oil, 340 g beef, and 600 ml broth.",
    );
    expect(displayed).toBe(
      "Mix 1/16 ounce spice with 1 1/2 tablespoons oil, 12 ounces beef, and 2 1/2 cups broth.",
    );
    expect(displayed).not.toMatch(/\b(?:g|ml)\b/iu);
  });

  it("leaves prose without metric measurements unchanged", () => {
    const instruction = "Season to taste, then simmer until glossy.";
    expect(formatRecipeTextForUsKitchen(instruction)).toBe(instruction);
  });
});
