import { z } from "zod";

import {
  convertToCanonical,
  US_RECIPE_MEASUREMENT_UNITS,
  type CanonicalUnit,
  type UsRecipeMeasurementUnit,
} from "~/domain/units";

export const aiUsRecipeMeasurementUnitSchema = z.enum(
  US_RECIPE_MEASUREMENT_UNITS,
);

export const AI_US_RECIPE_MEASUREMENT_UNIT_LIST =
  US_RECIPE_MEASUREMENT_UNITS.join(", ");

type AiRecipeUnitMetadata = Readonly<{
  baseUnit: CanonicalUnit;
  densityGramsPerMl: number | null;
  gramsPerCount: number | null;
}>;

type AiRecipeUnitCatalogEntry = AiRecipeUnitMetadata &
  Readonly<{
    catalogKey: string;
  }>;

type AiRecipeUnitSelection = Readonly<{
  catalogKey: string;
  location: string;
  unit: string;
}>;

export type AiRecipeUnitCompatibilityIssue = Readonly<{
  allowedUnits: readonly UsRecipeMeasurementUnit[];
  catalogKey: string;
  location: string;
  unit: string;
}>;

export class AiRecipeUnitCompatibilityError extends Error {
  override readonly name = "AiRecipeUnitCompatibilityError";

  constructor(readonly issues: readonly AiRecipeUnitCompatibilityIssue[]) {
    super("Generated ingredient units do not match their catalog metadata");
  }
}

const PREFERRED_UNITS_BY_BASE: Readonly<
  Record<CanonicalUnit, readonly UsRecipeMeasurementUnit[]>
> = {
  count: ["count", "oz", "lb", "tsp", "tbsp", "cup", "fl_oz"],
  g: ["oz", "lb", "tsp", "tbsp", "cup", "fl_oz", "count"],
  ml: ["tsp", "tbsp", "cup", "fl_oz", "oz", "lb", "count"],
};

export function allowedAiRecipeMeasurementUnits(
  metadata: AiRecipeUnitMetadata,
): readonly UsRecipeMeasurementUnit[] {
  return PREFERRED_UNITS_BY_BASE[metadata.baseUnit].filter((unit) => {
    try {
      convertToCanonical({
        canonicalUnit: metadata.baseUnit,
        densityGPerMl: metadata.densityGramsPerMl,
        gramsPerCount: metadata.gramsPerCount,
        quantity: 1,
        unit,
      });
      return true;
    } catch {
      return false;
    }
  });
}

export function assertAiRecipeUnitCompatibility(input: {
  catalog: readonly AiRecipeUnitCatalogEntry[];
  ingredients: readonly AiRecipeUnitSelection[];
}): void {
  const catalogByKey = new Map(
    input.catalog.map((entry) => [entry.catalogKey, entry]),
  );
  const issues = input.ingredients.flatMap((ingredient) => {
    const catalogEntry = catalogByKey.get(ingredient.catalogKey);
    if (!catalogEntry) return [];

    const allowedUnits = allowedAiRecipeMeasurementUnits(catalogEntry);
    return allowedUnits.some((unit) => unit === ingredient.unit)
      ? []
      : [
          {
            allowedUnits,
            catalogKey: ingredient.catalogKey,
            location: ingredient.location,
            unit: ingredient.unit,
          },
        ];
  });

  if (issues.length > 0) {
    throw new AiRecipeUnitCompatibilityError(issues);
  }
}

const MULTI_LETTER_METRIC_ABBREVIATION_PATTERN =
  /(?:^|[^A-Za-z0-9_])(?:mcg|µg|μg|mg|kg|ml|mm|cm|kj)(?=$|[^A-Za-z0-9_])/iu;
const NUMBER_ADJACENT_METRIC_ABBREVIATION_PATTERN =
  /(?:\b\d[\d,]*(?:\.\d+)?|[¼½¾⅓⅔⅛⅜⅝⅞])(?:\s*(?:-|\u2013|to)\s*\d[\d,]*(?:\.\d+)?)?\s*(?:mcg|µg|μg|mg|kg|ml|mm|cm|kj|g|l|m)\b/iu;
const LOWERCASE_SINGLE_METRIC_ABBREVIATION_PATTERN =
  /(?:^|[\s(,{;:])(?:g|l)(?=$|[\s)},.;:])/u;
const UPPERCASE_SINGLE_METRIC_ABBREVIATION_PATTERN =
  /(?:^|[\s(,{;:])(?:G|L)(?=$|[\s)},.;:])/u;
const STANDALONE_METER_ABBREVIATION_PATTERN =
  /(?:^|[\s(,{;:])m(?=$|[\s)},.;:])/iu;
const METRIC_WORD_PATTERN =
  /\b(?:micrograms?|microgrammes?|milligrams?|milligrammes?|grams?|grammes?|kilograms?|kilogrammes?|milliliters?|millilitres?|liters?|litres?|millimeters?|millimetres?|centimeters?|centimetres?|meters?|metres?|kilojoules?|celsius|centigrade)\b/iu;
const CELSIUS_ABBREVIATION_PATTERN =
  /(?:°\s*c\b|\bdegrees?\s+c\b|\b\d{2,3}(?:\.\d+)?\s*c\b)/iu;

export function containsMetricRecipeMeasurement(value: string): boolean {
  return (
    MULTI_LETTER_METRIC_ABBREVIATION_PATTERN.test(value) ||
    NUMBER_ADJACENT_METRIC_ABBREVIATION_PATTERN.test(value) ||
    LOWERCASE_SINGLE_METRIC_ABBREVIATION_PATTERN.test(value) ||
    UPPERCASE_SINGLE_METRIC_ABBREVIATION_PATTERN.test(value) ||
    STANDALONE_METER_ABBREVIATION_PATTERN.test(value) ||
    METRIC_WORD_PATTERN.test(value) ||
    CELSIUS_ABBREVIATION_PATTERN.test(value)
  );
}
