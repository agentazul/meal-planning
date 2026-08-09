import { describe, expect, it } from "vitest";

import {
  convertToCanonical,
  UnitConversionError,
  US_RECIPE_MEASUREMENT_UNITS,
} from "./units";

describe("US_RECIPE_MEASUREMENT_UNITS", () => {
  it("keeps household recipe entry in US customary units", () => {
    expect(US_RECIPE_MEASUREMENT_UNITS).toEqual([
      "oz",
      "lb",
      "tsp",
      "tbsp",
      "cup",
      "fl_oz",
      "count",
    ]);
  });
});

describe("convertToCanonical", () => {
  it("converts supported mass, volume, and count units", () => {
    expect(
      convertToCanonical({ quantity: 1.5, unit: "kg", canonicalUnit: "g" }),
    ).toEqual({ quantity: 1_500, unit: "g" });
    expect(
      convertToCanonical({ quantity: 2, unit: "cup", canonicalUnit: "ml" }),
    ).toEqual({ quantity: 473.176473, unit: "ml" });
    expect(
      convertToCanonical({
        quantity: 3,
        unit: "each",
        canonicalUnit: "count",
      }),
    ).toEqual({ quantity: 3, unit: "count" });
  });

  it("uses density for mass and volume conversions", () => {
    expect(
      convertToCanonical({
        quantity: 250,
        unit: "ml",
        canonicalUnit: "g",
        densityGPerMl: 0.8,
      }),
    ).toEqual({ quantity: 200, unit: "g" });
    expect(
      convertToCanonical({
        quantity: 200,
        unit: "g",
        canonicalUnit: "ml",
        densityGPerMl: 0.8,
      }),
    ).toEqual({ quantity: 250, unit: "ml" });
  });

  it("uses grams per count for count and mass conversions", () => {
    expect(
      convertToCanonical({
        quantity: 2,
        unit: "count",
        canonicalUnit: "g",
        gramsPerCount: 150,
      }),
    ).toEqual({ quantity: 300, unit: "g" });
    expect(
      convertToCanonical({
        quantity: 300,
        unit: "g",
        canonicalUnit: "count",
        gramsPerCount: 150,
      }),
    ).toEqual({ quantity: 2, unit: "count" });
  });

  it("uses both factors for volume and count conversions", () => {
    expect(
      convertToCanonical({
        quantity: 2,
        unit: "count",
        canonicalUnit: "ml",
        gramsPerCount: 120,
        densityGPerMl: 0.8,
      }),
    ).toEqual({ quantity: 300, unit: "ml" });
    expect(
      convertToCanonical({
        quantity: 300,
        unit: "ml",
        canonicalUnit: "count",
        gramsPerCount: 120,
        densityGPerMl: 0.8,
      }),
    ).toEqual({ quantity: 2, unit: "count" });
  });

  it("rejects unsupported input units with a typed error", () => {
    expect(() =>
      convertToCanonical({
        quantity: 1,
        unit: "pinch",
        canonicalUnit: "g",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<UnitConversionError>>({
        code: "UNSUPPORTED_UNIT",
      }),
    );
  });

  it("rejects conversions with missing or invalid factors", () => {
    expect(() =>
      convertToCanonical({
        quantity: 1,
        unit: "cup",
        canonicalUnit: "g",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<UnitConversionError>>({
        code: "MISSING_DENSITY",
      }),
    );

    expect(() =>
      convertToCanonical({
        quantity: 1,
        unit: "count",
        canonicalUnit: "g",
        gramsPerCount: 0,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<UnitConversionError>>({
        code: "INVALID_GRAMS_PER_COUNT",
      }),
    );
  });
});
