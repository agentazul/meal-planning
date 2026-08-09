import { z } from "zod";

import { US_RECIPE_MEASUREMENT_UNITS } from "~/domain/units";

export const aiUsRecipeMeasurementUnitSchema = z.enum(
  US_RECIPE_MEASUREMENT_UNITS,
);

export const AI_US_RECIPE_MEASUREMENT_UNIT_LIST =
  US_RECIPE_MEASUREMENT_UNITS.join(", ");

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
