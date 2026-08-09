export type CanonicalUnit = "g" | "ml" | "count";
export type MassUnit = "mg" | "g" | "kg" | "oz" | "lb";
export type VolumeUnit = "ml" | "l" | "tsp" | "tbsp" | "cup" | "fl_oz";
export type CountUnit = "count";
export type MeasurementUnit = MassUnit | VolumeUnit | CountUnit;

export const SUPPORTED_MEASUREMENT_UNITS = [
  "mg",
  "g",
  "kg",
  "oz",
  "lb",
  "ml",
  "l",
  "tsp",
  "tbsp",
  "cup",
  "fl_oz",
  "count",
] as const satisfies readonly MeasurementUnit[];

export const US_RECIPE_MEASUREMENT_UNITS = [
  "oz",
  "lb",
  "tsp",
  "tbsp",
  "cup",
  "fl_oz",
  "count",
] as const satisfies readonly MeasurementUnit[];

export type UsRecipeMeasurementUnit =
  (typeof US_RECIPE_MEASUREMENT_UNITS)[number];

type UnitDimension = "mass" | "volume" | "count";

interface UnitDefinition {
  dimension: UnitDimension;
  toDimensionBase: number;
}

export interface UnitConversionInput {
  quantity: number;
  unit: string;
  canonicalUnit: string;
  densityGPerMl?: number | null;
  gramsPerCount?: number | null;
}

export interface CanonicalQuantity {
  quantity: number;
  unit: CanonicalUnit;
}

export type UnitConversionErrorCode =
  | "INVALID_DENSITY"
  | "INVALID_GRAMS_PER_COUNT"
  | "INVALID_QUANTITY"
  | "MISSING_DENSITY"
  | "MISSING_GRAMS_PER_COUNT"
  | "UNSUPPORTED_CANONICAL_UNIT"
  | "UNSUPPORTED_CONVERSION"
  | "UNSUPPORTED_UNIT";

export class UnitConversionError extends Error {
  override readonly name = "UnitConversionError";

  constructor(
    readonly code: UnitConversionErrorCode,
    message: string,
    readonly sourceUnit?: string,
    readonly canonicalUnit?: string,
  ) {
    super(message);
  }
}

const UNIT_DEFINITIONS: Readonly<Record<MeasurementUnit, UnitDefinition>> = {
  mg: { dimension: "mass", toDimensionBase: 0.001 },
  g: { dimension: "mass", toDimensionBase: 1 },
  kg: { dimension: "mass", toDimensionBase: 1_000 },
  oz: { dimension: "mass", toDimensionBase: 28.349523125 },
  lb: { dimension: "mass", toDimensionBase: 453.59237 },
  ml: { dimension: "volume", toDimensionBase: 1 },
  l: { dimension: "volume", toDimensionBase: 1_000 },
  tsp: { dimension: "volume", toDimensionBase: 4.92892159375 },
  tbsp: { dimension: "volume", toDimensionBase: 14.78676478125 },
  cup: { dimension: "volume", toDimensionBase: 236.5882365 },
  fl_oz: { dimension: "volume", toDimensionBase: 29.5735295625 },
  count: { dimension: "count", toDimensionBase: 1 },
};

const UNIT_ALIASES: Readonly<Record<string, MeasurementUnit>> = {
  mg: "mg",
  milligram: "mg",
  milligrams: "mg",
  g: "g",
  gram: "g",
  grams: "g",
  kg: "kg",
  kilogram: "kg",
  kilograms: "kg",
  oz: "oz",
  ounce: "oz",
  ounces: "oz",
  lb: "lb",
  lbs: "lb",
  pound: "lb",
  pounds: "lb",
  ml: "ml",
  milliliter: "ml",
  milliliters: "ml",
  millilitre: "ml",
  millilitres: "ml",
  l: "l",
  liter: "l",
  liters: "l",
  litre: "l",
  litres: "l",
  tsp: "tsp",
  teaspoon: "tsp",
  teaspoons: "tsp",
  tbsp: "tbsp",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
  cup: "cup",
  cups: "cup",
  "fl oz": "fl_oz",
  fl_oz: "fl_oz",
  "fluid ounce": "fl_oz",
  "fluid ounces": "fl_oz",
  count: "count",
  each: "count",
  ea: "count",
  item: "count",
  items: "count",
};

function isCanonicalUnit(value: string): value is CanonicalUnit {
  return value === "g" || value === "ml" || value === "count";
}

function normalizeUnit(value: string): MeasurementUnit {
  const key = value.trim().toLowerCase().replace(/\s+/g, " ");
  const unit = UNIT_ALIASES[key];
  if (!unit) {
    throw new UnitConversionError(
      "UNSUPPORTED_UNIT",
      `Unsupported measurement unit: ${value}`,
      value,
    );
  }
  return unit;
}

function requireDensity(
  value: number | null | undefined,
  sourceUnit: string,
  canonicalUnit: CanonicalUnit,
): number {
  if (value === null || value === undefined) {
    throw new UnitConversionError(
      "MISSING_DENSITY",
      "This conversion requires densityGPerMl",
      sourceUnit,
      canonicalUnit,
    );
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new UnitConversionError(
      "INVALID_DENSITY",
      "densityGPerMl must be a positive finite number",
      sourceUnit,
      canonicalUnit,
    );
  }
  return value;
}

function requireGramsPerCount(
  value: number | null | undefined,
  sourceUnit: string,
  canonicalUnit: CanonicalUnit,
): number {
  if (value === null || value === undefined) {
    throw new UnitConversionError(
      "MISSING_GRAMS_PER_COUNT",
      "This conversion requires gramsPerCount",
      sourceUnit,
      canonicalUnit,
    );
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new UnitConversionError(
      "INVALID_GRAMS_PER_COUNT",
      "gramsPerCount must be a positive finite number",
      sourceUnit,
      canonicalUnit,
    );
  }
  return value;
}

export function convertToCanonical({
  quantity,
  unit: sourceUnitInput,
  canonicalUnit: canonicalUnitInput,
  densityGPerMl,
  gramsPerCount,
}: UnitConversionInput): CanonicalQuantity {
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new UnitConversionError(
      "INVALID_QUANTITY",
      "Quantity must be a nonnegative finite number",
      sourceUnitInput,
      canonicalUnitInput,
    );
  }

  if (!isCanonicalUnit(canonicalUnitInput)) {
    throw new UnitConversionError(
      "UNSUPPORTED_CANONICAL_UNIT",
      `Unsupported canonical unit: ${canonicalUnitInput}`,
      sourceUnitInput,
      canonicalUnitInput,
    );
  }

  const sourceUnit = normalizeUnit(sourceUnitInput);
  const definition = UNIT_DEFINITIONS[sourceUnit];
  const quantityInDimensionBase = quantity * definition.toDimensionBase;
  const targetDimension = UNIT_DEFINITIONS[canonicalUnitInput].dimension;

  if (definition.dimension === targetDimension) {
    return { quantity: quantityInDimensionBase, unit: canonicalUnitInput };
  }

  if (definition.dimension === "volume" && targetDimension === "mass") {
    return {
      quantity:
        quantityInDimensionBase *
        requireDensity(densityGPerMl, sourceUnitInput, canonicalUnitInput),
      unit: canonicalUnitInput,
    };
  }

  if (definition.dimension === "mass" && targetDimension === "volume") {
    return {
      quantity:
        quantityInDimensionBase /
        requireDensity(densityGPerMl, sourceUnitInput, canonicalUnitInput),
      unit: canonicalUnitInput,
    };
  }

  if (definition.dimension === "count" && targetDimension === "mass") {
    return {
      quantity:
        quantityInDimensionBase *
        requireGramsPerCount(
          gramsPerCount,
          sourceUnitInput,
          canonicalUnitInput,
        ),
      unit: canonicalUnitInput,
    };
  }

  if (definition.dimension === "mass" && targetDimension === "count") {
    return {
      quantity:
        quantityInDimensionBase /
        requireGramsPerCount(
          gramsPerCount,
          sourceUnitInput,
          canonicalUnitInput,
        ),
      unit: canonicalUnitInput,
    };
  }

  if (definition.dimension === "count" && targetDimension === "volume") {
    const grams =
      quantityInDimensionBase *
      requireGramsPerCount(gramsPerCount, sourceUnitInput, canonicalUnitInput);
    return {
      quantity:
        grams /
        requireDensity(densityGPerMl, sourceUnitInput, canonicalUnitInput),
      unit: canonicalUnitInput,
    };
  }

  if (definition.dimension === "volume" && targetDimension === "count") {
    const grams =
      quantityInDimensionBase *
      requireDensity(densityGPerMl, sourceUnitInput, canonicalUnitInput);
    return {
      quantity:
        grams /
        requireGramsPerCount(
          gramsPerCount,
          sourceUnitInput,
          canonicalUnitInput,
        ),
      unit: canonicalUnitInput,
    };
  }

  throw new UnitConversionError(
    "UNSUPPORTED_CONVERSION",
    `Cannot convert ${sourceUnitInput} to ${canonicalUnitInput}`,
    sourceUnitInput,
    canonicalUnitInput,
  );
}
