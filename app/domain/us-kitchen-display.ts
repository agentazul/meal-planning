import {
  convertToCanonical,
  type CanonicalUnit,
  type MeasurementUnit,
} from "./units";

type DisplayUnit =
  | "cup"
  | "fluid_ounce"
  | "inch"
  | "ounce"
  | "pound"
  | "tablespoon"
  | "teaspoon";

type FractionOption = Readonly<{
  label: string;
  value: number;
}>;

const EIGHTH_FRACTIONS: readonly FractionOption[] = [
  { label: "", value: 0 },
  { label: "1/8", value: 1 / 8 },
  { label: "1/4", value: 1 / 4 },
  { label: "1/3", value: 1 / 3 },
  { label: "3/8", value: 3 / 8 },
  { label: "1/2", value: 1 / 2 },
  { label: "5/8", value: 5 / 8 },
  { label: "2/3", value: 2 / 3 },
  { label: "3/4", value: 3 / 4 },
  { label: "7/8", value: 7 / 8 },
  { label: "", value: 1 },
];

const QUARTER_FRACTIONS: readonly FractionOption[] = [
  { label: "", value: 0 },
  { label: "1/4", value: 1 / 4 },
  { label: "1/2", value: 1 / 2 },
  { label: "3/4", value: 3 / 4 },
  { label: "", value: 1 },
];

const SIXTEENTH_FRACTIONS: readonly FractionOption[] = [
  { label: "", value: 0 },
  { label: "1/16", value: 1 / 16 },
  { label: "1/8", value: 2 / 16 },
  { label: "3/16", value: 3 / 16 },
  { label: "1/4", value: 4 / 16 },
  { label: "5/16", value: 5 / 16 },
  { label: "3/8", value: 6 / 16 },
  { label: "7/16", value: 7 / 16 },
  { label: "1/2", value: 8 / 16 },
  { label: "9/16", value: 9 / 16 },
  { label: "5/8", value: 10 / 16 },
  { label: "11/16", value: 11 / 16 },
  { label: "3/4", value: 12 / 16 },
  { label: "13/16", value: 13 / 16 },
  { label: "7/8", value: 14 / 16 },
  { label: "15/16", value: 15 / 16 },
  { label: "", value: 1 },
];

const UNIT_DIMENSIONS: Readonly<
  Record<MeasurementUnit, "count" | "mass" | "volume">
> = {
  count: "count",
  cup: "volume",
  fl_oz: "volume",
  g: "mass",
  kg: "mass",
  l: "volume",
  lb: "mass",
  mg: "mass",
  ml: "volume",
  oz: "mass",
  tbsp: "volume",
  tsp: "volume",
};

const METRIC_UNIT_ALIASES: Readonly<Record<string, MeasurementUnit>> = {
  g: "g",
  gram: "g",
  grams: "g",
  kg: "kg",
  kilogram: "kg",
  kilograms: "kg",
  l: "l",
  liter: "l",
  liters: "l",
  litre: "l",
  litres: "l",
  mg: "mg",
  milligram: "mg",
  milligrams: "mg",
  ml: "ml",
  milliliter: "ml",
  milliliters: "ml",
  millilitre: "ml",
  millilitres: "ml",
};

const UNIT_LABELS: Readonly<
  Record<DisplayUnit, Readonly<{ plural: string; singular: string }>>
> = {
  cup: { plural: "cups", singular: "cup" },
  fluid_ounce: { plural: "fluid ounces", singular: "fluid ounce" },
  inch: { plural: "inches", singular: "inch" },
  ounce: { plural: "ounces", singular: "ounce" },
  pound: { plural: "pounds", singular: "pound" },
  tablespoon: { plural: "tablespoons", singular: "tablespoon" },
  teaspoon: { plural: "teaspoons", singular: "teaspoon" },
};

const NUMBER_PATTERN = String.raw`(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
const METRIC_UNIT_PATTERN =
  String.raw`(?:milligrams?|mg|kilograms?|kg|grams?|g|millilit(?:er|re)s?|ml|lit(?:er|re)s?|l)`;
const METRIC_RANGE_PATTERN = new RegExp(
  String.raw`\b(${NUMBER_PATTERN})\s*(?:-|to)\s*(${NUMBER_PATTERN})\s*(${METRIC_UNIT_PATTERN})\b`,
  "giu",
);
const METRIC_QUANTITY_PATTERN = new RegExp(
  String.raw`\b(${NUMBER_PATTERN})\s*(${METRIC_UNIT_PATTERN})\b`,
  "giu",
);
const CELSIUS_RANGE_PATTERN = new RegExp(
  String.raw`(-?${NUMBER_PATTERN})\s*(?:-|to)\s*(-?${NUMBER_PATTERN})\s*°?\s*(?:c|celsius)\b`,
  "giu",
);
const CELSIUS_PATTERN = new RegExp(
  String.raw`(-?${NUMBER_PATTERN})\s*°?\s*(?:c|celsius)\b`,
  "giu",
);
const LENGTH_RANGE_PATTERN = new RegExp(
  String.raw`\b(${NUMBER_PATTERN})\s*(?:-|to)\s*(${NUMBER_PATTERN})\s*(mm|millimeters?|millimetres?|cm|centimeters?|centimetres?|m|meters?|metres?)\b`,
  "giu",
);
const LENGTH_PATTERN = new RegExp(
  String.raw`\b(${NUMBER_PATTERN})\s*(mm|millimeters?|millimetres?|cm|centimeters?|centimetres?|m|meters?|metres?)\b`,
  "giu",
);

const GRAMS_PER_OUNCE = convertToCanonical({
  canonicalUnit: "g",
  quantity: 1,
  unit: "oz",
}).quantity;
const GRAMS_PER_POUND = convertToCanonical({
  canonicalUnit: "g",
  quantity: 1,
  unit: "lb",
}).quantity;
const MILLILITERS_PER_TEASPOON = convertToCanonical({
  canonicalUnit: "ml",
  quantity: 1,
  unit: "tsp",
}).quantity;
const MILLILITERS_PER_TABLESPOON = convertToCanonical({
  canonicalUnit: "ml",
  quantity: 1,
  unit: "tbsp",
}).quantity;
const MILLILITERS_PER_CUP = convertToCanonical({
  canonicalUnit: "ml",
  quantity: 1,
  unit: "cup",
}).quantity;
const MILLILITERS_PER_FLUID_OUNCE = convertToCanonical({
  canonicalUnit: "ml",
  quantity: 1,
  unit: "fl_oz",
}).quantity;

function isMeasurementUnit(value: string): value is MeasurementUnit {
  return Object.hasOwn(UNIT_DIMENSIONS, value);
}

function closestFraction(
  fractionalValue: number,
  options: readonly FractionOption[],
): FractionOption {
  return options.reduce((closest, option) =>
    Math.abs(option.value - fractionalValue) <
    Math.abs(closest.value - fractionalValue)
      ? option
      : closest,
  );
}

function formatFractionalAmount(
  value: number,
  fractions: readonly FractionOption[],
): Readonly<{ text: string; value: number }> {
  const smallestFraction = fractions.find((fraction) => fraction.value > 0);
  if (!smallestFraction) {
    throw new Error("At least one positive display fraction is required");
  }
  if (value <= smallestFraction.value / 2) {
    return {
      text: `less than ${smallestFraction.label}`,
      value: smallestFraction.value / 2,
    };
  }

  let whole = Math.floor(value);
  const closest = closestFraction(value - whole, fractions);
  if (closest.value === 1) {
    whole += 1;
  }
  const fraction = closest.value === 1 ? "" : closest.label;
  const text = [whole > 0 ? String(whole) : "", fraction]
    .filter(Boolean)
    .join(" ");

  return {
    text: text || "0",
    value: whole + (closest.value === 1 ? 0 : closest.value),
  };
}

function formatUnitQuantity(
  value: number,
  unit: DisplayUnit,
  fractions: readonly FractionOption[],
): string {
  const amount = formatFractionalAmount(value, fractions);
  const labels = UNIT_LABELS[unit];
  const label = amount.value > 1 ? labels.plural : labels.singular;
  return `${amount.text} ${label}`;
}

function canonicalQuantity(
  quantity: number,
  unit: MeasurementUnit,
  canonicalUnit: CanonicalUnit,
): number {
  return convertToCanonical({ canonicalUnit, quantity, unit }).quantity;
}

function formatMass(quantity: number, unit: MeasurementUnit): string {
  const grams = canonicalQuantity(quantity, unit, "g");
  const ounces = grams / GRAMS_PER_OUNCE;
  const shouldUsePounds = unit === "lb" || ounces >= 16;
  if (!shouldUsePounds && ounces < 1) {
    return formatUnitQuantity(ounces, "ounce", SIXTEENTH_FRACTIONS);
  }
  return shouldUsePounds
    ? formatUnitQuantity(
        grams / GRAMS_PER_POUND,
        "pound",
        EIGHTH_FRACTIONS,
      )
    : formatUnitQuantity(ounces, "ounce", QUARTER_FRACTIONS);
}

function formatVolume(quantity: number, unit: MeasurementUnit): string {
  const milliliters = canonicalQuantity(quantity, unit, "ml");

  if (unit === "fl_oz" && quantity < 8) {
    return formatUnitQuantity(
      milliliters / MILLILITERS_PER_FLUID_OUNCE,
      "fluid_ounce",
      QUARTER_FRACTIONS,
    );
  }
  if (
    unit === "tsp" ||
    (unit !== "cup" && milliliters < MILLILITERS_PER_TABLESPOON)
  ) {
    return formatUnitQuantity(
      milliliters / MILLILITERS_PER_TEASPOON,
      "teaspoon",
      EIGHTH_FRACTIONS,
    );
  }
  if (
    unit === "tbsp" ||
    (unit !== "cup" && milliliters < MILLILITERS_PER_CUP / 4)
  ) {
    return formatUnitQuantity(
      milliliters / MILLILITERS_PER_TABLESPOON,
      "tablespoon",
      QUARTER_FRACTIONS,
    );
  }
  return formatUnitQuantity(
    milliliters / MILLILITERS_PER_CUP,
    "cup",
    EIGHTH_FRACTIONS,
  );
}

export function formatUsRecipeQuantity(input: {
  baseUnit?: CanonicalUnit;
  quantity: number;
  quantityInBaseUnit?: number;
  unit: string;
}): string {
  const hasOriginalUnit = isMeasurementUnit(input.unit);
  const unit = hasOriginalUnit ? input.unit : input.baseUnit;
  const quantity = hasOriginalUnit ? input.quantity : input.quantityInBaseUnit;
  if (!unit || !isMeasurementUnit(unit)) {
    throw new RangeError(`Unsupported recipe unit: ${input.unit}`);
  }
  if (quantity === undefined || !Number.isFinite(quantity) || quantity <= 0) {
    throw new RangeError("Recipe quantity must be a positive finite number");
  }

  const dimension = UNIT_DIMENSIONS[unit];
  if (dimension === "mass") return formatMass(quantity, unit);
  if (dimension === "volume") return formatVolume(quantity, unit);

  return formatFractionalAmount(quantity, EIGHTH_FRACTIONS).text;
}

function metricAliasToUnit(value: string): MeasurementUnit {
  const unit = METRIC_UNIT_ALIASES[value.toLowerCase()];
  if (!unit) throw new RangeError(`Unsupported metric recipe unit: ${value}`);
  return unit;
}

function celsiusToFahrenheit(value: number): number {
  return Math.round((value * 9) / 5 + 32);
}

function parseDisplayedNumber(value: string): number {
  return Number(value.replaceAll(",", ""));
}

function lengthToInches(quantity: number, unit: string): string {
  const normalized = unit.toLowerCase();
  const inches =
    normalized.startsWith("mm") || normalized.startsWith("milli")
      ? quantity / 25.4
      : normalized.startsWith("cm") || normalized.startsWith("centi")
        ? quantity / 2.54
        : quantity * 39.3700787402;
  return formatUnitQuantity(inches, "inch", EIGHTH_FRACTIONS);
}

export function formatRecipeTextForUsKitchen(value: string): string {
  return value
    .replace(
      CELSIUS_RANGE_PATTERN,
      (_, from: string, to: string) =>
        `${celsiusToFahrenheit(parseDisplayedNumber(from))}°F to ${celsiusToFahrenheit(parseDisplayedNumber(to))}°F`,
    )
    .replace(
      CELSIUS_PATTERN,
      (_, quantity: string) =>
        `${celsiusToFahrenheit(parseDisplayedNumber(quantity))}°F`,
    )
    .replace(
      LENGTH_RANGE_PATTERN,
      (_, from: string, to: string, unit: string) =>
        `${lengthToInches(parseDisplayedNumber(from), unit)} to ${lengthToInches(parseDisplayedNumber(to), unit)}`,
    )
    .replace(
      LENGTH_PATTERN,
      (_, quantity: string, unit: string) =>
        lengthToInches(parseDisplayedNumber(quantity), unit),
    )
    .replace(
      METRIC_RANGE_PATTERN,
      (_, from: string, to: string, unitLabel: string) => {
        const unit = metricAliasToUnit(unitLabel);
        return `${formatUsRecipeQuantity({ quantity: parseDisplayedNumber(from), unit })} to ${formatUsRecipeQuantity({ quantity: parseDisplayedNumber(to), unit })}`;
      },
    )
    .replace(
      METRIC_QUANTITY_PATTERN,
      (_, quantity: string, unitLabel: string) =>
        formatUsRecipeQuantity({
          quantity: parseDisplayedNumber(quantity),
          unit: metricAliasToUnit(unitLabel),
        }),
    );
}
