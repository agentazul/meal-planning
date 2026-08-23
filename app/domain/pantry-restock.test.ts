import { describe, expect, it } from "vitest";

import { convertToCanonical } from "~/domain/units";
import {
  convertPantryBaseQuantityToUnit,
  validatePantryRestockBatchInput,
} from "./pantry-restock";

describe("convertPantryBaseQuantityToUnit", () => {
  it("converts a gram-based package into pounds", () => {
    expect(
      convertPantryBaseQuantityToUnit({
        baseUnit: "g",
        quantityInBaseUnit: 907,
        unit: "lb",
      }),
    ).toBe(2);
  });

  it("keeps a count-based package in count", () => {
    expect(
      convertPantryBaseQuantityToUnit({
        baseUnit: "count",
        quantityInBaseUnit: 3,
        unit: "count",
      }),
    ).toBe(3);
  });

  it("round-trips a count audible through grams-per-count metadata", () => {
    const displayQuantity = convertPantryBaseQuantityToUnit({
      baseUnit: "g",
      gramsPerCount: 84,
      quantityInBaseUnit: 168,
      unit: "count",
    });
    const canonical = convertToCanonical({
      canonicalUnit: "g",
      gramsPerCount: 84,
      quantity: displayQuantity,
      unit: "count",
    });

    expect(displayQuantity).toBe(2);
    expect(canonical.quantity).toBe(168);
  });
});

describe("validatePantryRestockBatchInput", () => {
  const valid = {
    batchId: "690b588d-2de1-45c0-a10f-411d696f7c21",
    items: [
      {
        canonicalIngredientId: "090824a3-c8d3-49fb-801b-0c24ff5730d4",
        inventoryMode: "purchase" as const,
        packageCount: 1,
        quantity: null,
        unit: "lb" as const,
      },
    ],
    weekStart: "2026-08-17",
  };

  it("accepts an authoritative default-package item", () => {
    expect(() => validatePantryRestockBatchInput(valid)).not.toThrow();
  });

  it("rejects duplicate ingredient rows", () => {
    expect(() =>
      validatePantryRestockBatchInput({
        ...valid,
        items: [...valid.items, ...valid.items],
      }),
    ).toThrowError("INVALID_INGREDIENT_ID");
  });

  it("rejects nonpositive audible quantities", () => {
    expect(() =>
      validatePantryRestockBatchInput({
        ...valid,
        items: [{ ...valid.items[0], quantity: 0 }],
      }),
    ).toThrowError("INVALID_QUANTITY");
  });

  it.each([0, 1.5, 101])(
    "rejects an invalid package count of %s",
    (packageCount) => {
      expect(() =>
        validatePantryRestockBatchInput({
          ...valid,
          items: [{ ...valid.items[0], packageCount }],
        }),
      ).toThrowError("INVALID_PACKAGE_COUNT");
    },
  );
});
