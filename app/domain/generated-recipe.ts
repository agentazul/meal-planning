import { z } from "zod";

import {
  convertToCanonical,
  SUPPORTED_MEASUREMENT_UNITS,
  UnitConversionError,
  type CanonicalUnit,
  type MeasurementUnit,
} from "./units";

const MAX_CANONICAL_QUANTITY = 99_999_999_999;
const MAX_CATALOG_SIZE = 999;
const MAX_GARLIC_GRAMS_PER_SERVING = 15;
const FORBIDDEN_DASH_PATTERN = /[\u2013\u2014]/u;

export const GENERATED_RECIPE_EFFORT_TIERS = [
  "weeknight",
  "weekend",
  "project",
] as const;

export type GeneratedRecipeEffortTier =
  (typeof GENERATED_RECIPE_EFFORT_TIERS)[number];

export const GENERATED_RECIPE_ACTIVE_TIME_RANGES = {
  weeknight: { maximumMinutes: 45, minimumMinutes: 0 },
  weekend: { maximumMinutes: 120, minimumMinutes: 20 },
  project: { maximumMinutes: 240, minimumMinutes: 45 },
} as const satisfies Readonly<
  Record<
    GeneratedRecipeEffortTier,
    Readonly<{ maximumMinutes: number; minimumMinutes: number }>
  >
>;

export const GENERATED_RECIPE_INGREDIENT_CATEGORIES = [
  "produce",
  "protein",
  "dairy",
  "pantry",
  "spice",
  "frozen",
  "bakery",
  "other",
] as const;

export const generatedRecipeCatalogKeySchema = z
  .string()
  .regex(/^i\d{3}$/);

const generatedTextSchema = (maximumLength: number) =>
  z
    .string()
    .min(1)
    .max(maximumLength)
    .regex(/\S/u, "Text cannot be blank")
    .regex(/^[^\u2013\u2014]*$/u, "Use a hyphen instead of an em dash or en dash");

const nullableGeneratedTextSchema = (maximumLength: number) =>
  generatedTextSchema(maximumLength).nullable();

export const generatedRecipeModelOutputSchema = z.strictObject({
  activeTimeMinutes: z.number().int().min(0).max(240),
  baseServings: z.number().int().min(1).max(10_000),
  cuisine: nullableGeneratedTextSchema(100),
  description: nullableGeneratedTextSchema(5_000),
  effortTier: z.enum(GENERATED_RECIPE_EFFORT_TIERS),
  ingredients: z
    .array(
      z.strictObject({
        catalogKey: generatedRecipeCatalogKeySchema,
        isOptional: z.boolean(),
        preparation: nullableGeneratedTextSchema(120),
        quantity: z.number().min(0.001).max(MAX_CANONICAL_QUANTITY),
        scalesLinearly: z.boolean(),
        unit: z.enum(SUPPORTED_MEASUREMENT_UNITS),
      }),
    )
    .min(1)
    .max(40),
  instructions: z
    .array(
      z.strictObject({
        instruction: generatedTextSchema(2_000),
      }),
    )
    .min(1)
    .max(40),
  minInternalTemperatureF: z.number().int().min(120).max(205).nullable(),
  primaryProteinCatalogKey: generatedRecipeCatalogKeySchema.nullable(),
  techniques: z.array(generatedTextSchema(80)).max(12),
  title: generatedTextSchema(160),
  totalTimeMinutes: z.number().int().min(1).max(10_080),
});

export type GeneratedRecipeIngredientCategory =
  (typeof GENERATED_RECIPE_INGREDIENT_CATEGORIES)[number];
export type GeneratedRecipeModelOutput = z.infer<
  typeof generatedRecipeModelOutputSchema
>;

export const generatedRecipeConstraintsSchema = z
  .strictObject({
    maxActiveTimeMinutes: z.number().int().min(0).max(240),
    requestedEffortTier: z.enum(GENERATED_RECIPE_EFFORT_TIERS),
    requestedServings: z.number().int().min(1).max(10_000),
  })
  .superRefine((constraints, context) => {
    const range =
      GENERATED_RECIPE_ACTIVE_TIME_RANGES[constraints.requestedEffortTier];
    if (
      constraints.maxActiveTimeMinutes < range.minimumMinutes ||
      constraints.maxActiveTimeMinutes > range.maximumMinutes
    ) {
      context.addIssue({
        code: "custom",
        message: `${constraints.requestedEffortTier} active-time ceiling must be from ${range.minimumMinutes} through ${range.maximumMinutes} minutes`,
        path: ["maxActiveTimeMinutes"],
      });
    }
  });

export type GeneratedRecipeConstraints = z.infer<
  typeof generatedRecipeConstraintsSchema
>;

export type GeneratedRecipeCanonicalReference = Readonly<{
  baseUnit: CanonicalUnit;
  category: GeneratedRecipeIngredientCategory;
  densityGramsPerMl: number | null;
  gramsPerCount: number | null;
  id: string;
  name: string;
}>;

export type GeneratedRecipeCatalogEntry = GeneratedRecipeCanonicalReference &
  Readonly<{
    catalogKey: string;
    requiredMinimumInternalTemperatureF: number | null;
  }>;

export type NormalizedGeneratedRecipeIngredient = Readonly<{
  canonicalIngredientId: string;
  isOptional: boolean;
  preparation: string | null;
  quantity: number;
  quantityInBaseUnit: number;
  scalesLinearly: boolean;
  unit: MeasurementUnit;
}>;

export type NormalizedGeneratedRecipeInstruction = Readonly<{
  instruction: string;
  position: number;
}>;

export type NormalizedGeneratedRecipeDraft = Readonly<{
  activeTimeMinutes: number;
  baseServings: number;
  cuisine: string | null;
  description: string | null;
  effortTier: GeneratedRecipeEffortTier;
  ingredients: readonly NormalizedGeneratedRecipeIngredient[];
  instructions: readonly NormalizedGeneratedRecipeInstruction[];
  minInternalTemperatureF: number | null;
  primaryProtein: string | null;
  techniques: readonly string[];
  title: string;
  totalTimeMinutes: number;
}>;

export type GeneratedRecipeValidationErrorCode =
  | "ACTIVE_TIME_BELOW_MINIMUM"
  | "ACTIVE_TIME_EXCEEDED"
  | "DUPLICATE_INGREDIENT"
  | "EFFORT_MISMATCH"
  | "INVALID_CANONICAL_QUANTITY"
  | "INVALID_CATALOG"
  | "INVALID_CONSTRAINTS"
  | "INVALID_MODEL_OUTPUT"
  | "INVALID_TIME_RANGE"
  | "INVALID_UNIT_CONVERSION"
  | "IMPLAUSIBLE_INGREDIENT_QUANTITY"
  | "MISSING_INTERNAL_TEMPERATURE"
  | "PRIMARY_PROTEIN_NOT_INCLUDED"
  | "PRIMARY_PROTEIN_NOT_PROTEIN"
  | "SERVINGS_MISMATCH"
  | "UNKNOWN_CATALOG_KEY"
  | "UNSAFE_INTERNAL_TEMPERATURE";

export class GeneratedRecipeValidationError extends Error {
  override readonly name = "GeneratedRecipeValidationError";

  constructor(
    readonly code: GeneratedRecipeValidationErrorCode,
    message: string,
    readonly path: readonly (number | string)[] = [],
  ) {
    super(message);
  }
}

const canonicalReferenceSchema = z.object({
  baseUnit: z.enum(["g", "ml", "count"]),
  category: z.enum(GENERATED_RECIPE_INGREDIENT_CATEGORIES),
  densityGramsPerMl: z.number().positive().nullable(),
  gramsPerCount: z.number().positive().nullable(),
  id: z.uuid(),
  name: z.string().min(1).regex(/\S/u),
});

const catalogEntrySchema = z.strictObject({
  baseUnit: z.enum(["g", "ml", "count"]),
  catalogKey: generatedRecipeCatalogKeySchema,
  category: z.enum(GENERATED_RECIPE_INGREDIENT_CATEGORIES),
  densityGramsPerMl: z.number().positive().nullable(),
  gramsPerCount: z.number().positive().nullable(),
  id: z.uuid(),
  name: z.string().min(1).regex(/\S/u),
  requiredMinimumInternalTemperatureF: z
    .number()
    .int()
    .min(32)
    .max(500)
    .nullable(),
});

function normalizeReferenceName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

export function getRequiredMinimumInternalTemperatureF(
  ingredientName: string,
  category: GeneratedRecipeIngredientCategory,
): number | null {
  if (category !== "protein") {
    return null;
  }

  const name = normalizeReferenceName(ingredientName);

  if (
    name.startsWith("canned ") ||
    name.startsWith("deli ") ||
    name === "rotisserie chicken" ||
    name === "frozen meatball" ||
    name === "hot dog" ||
    name === "kielbasa"
  ) {
    return null;
  }

  if (/\b(?:chicken|turkey|duck)\b/u.test(name)) {
    return 165;
  }

  if (
    name.startsWith("ground ") ||
    name === "breakfast sausage" ||
    name === "italian sausage"
  ) {
    return 160;
  }

  if (/\bpork\b/u.test(name)) {
    return 145;
  }

  if (
    /\b(?:salmon|cod|tilapia|shrimp|scallop)\b/u.test(name) ||
    name === "tuna steak"
  ) {
    return 145;
  }

  return null;
}

function invalidCatalog(message: string): never {
  throw new GeneratedRecipeValidationError("INVALID_CATALOG", message);
}

export function buildGeneratedRecipeCatalog(
  references: readonly GeneratedRecipeCanonicalReference[],
): readonly GeneratedRecipeCatalogEntry[] {
  const parsedReferences = z
    .array(canonicalReferenceSchema)
    .min(1)
    .max(MAX_CATALOG_SIZE)
    .safeParse(references);

  if (!parsedReferences.success) {
    return invalidCatalog("Canonical ingredient references are malformed");
  }

  const ids = new Set<string>();
  const names = new Set<string>();

  for (const reference of parsedReferences.data) {
    const normalizedName = normalizeReferenceName(reference.name);
    if (ids.has(reference.id)) {
      return invalidCatalog(`Duplicate canonical ingredient ID: ${reference.id}`);
    }
    if (names.has(normalizedName)) {
      return invalidCatalog(`Duplicate canonical ingredient name: ${reference.name}`);
    }
    ids.add(reference.id);
    names.add(normalizedName);
  }

  const sorted = [...parsedReferences.data].sort((left, right) => {
    const leftKey = `${left.category}\u0000${normalizeReferenceName(left.name)}\u0000${left.id}`;
    const rightKey = `${right.category}\u0000${normalizeReferenceName(right.name)}\u0000${right.id}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

  return sorted.map((reference, index) => ({
    ...reference,
    catalogKey: `i${String(index + 1).padStart(3, "0")}`,
    requiredMinimumInternalTemperatureF:
      getRequiredMinimumInternalTemperatureF(reference.name, reference.category),
  }));
}

function indexCatalog(
  catalog: readonly GeneratedRecipeCatalogEntry[],
): ReadonlyMap<string, GeneratedRecipeCatalogEntry> {
  const parsedCatalog = z
    .array(catalogEntrySchema)
    .min(1)
    .max(MAX_CATALOG_SIZE)
    .safeParse(catalog);

  if (!parsedCatalog.success) {
    return invalidCatalog("Generated recipe catalog is malformed");
  }

  const byKey = new Map<string, GeneratedRecipeCatalogEntry>();
  const ids = new Set<string>();

  for (const entry of parsedCatalog.data) {
    if (byKey.has(entry.catalogKey)) {
      return invalidCatalog(`Duplicate generated catalog key: ${entry.catalogKey}`);
    }
    if (ids.has(entry.id)) {
      return invalidCatalog(`Duplicate canonical ingredient ID: ${entry.id}`);
    }
    if (
      entry.requiredMinimumInternalTemperatureF !==
      getRequiredMinimumInternalTemperatureF(entry.name, entry.category)
    ) {
      return invalidCatalog(`Food safety metadata does not match ${entry.name}`);
    }
    byKey.set(entry.catalogKey, entry);
    ids.add(entry.id);
  }

  return byKey;
}

function normalizeGeneratedText(value: string): string {
  return value.trim();
}

function normalizeOptionalGeneratedText(value: string | null): string | null {
  return value === null ? null : normalizeGeneratedText(value);
}

function parseModelOutput(input: unknown): GeneratedRecipeModelOutput {
  const parsed = generatedRecipeModelOutputSchema.safeParse(input);
  if (!parsed.success) {
    throw new GeneratedRecipeValidationError(
      "INVALID_MODEL_OUTPUT",
      "The generated recipe does not match the required schema",
    );
  }
  return parsed.data;
}

function parseConstraints(input: GeneratedRecipeConstraints): GeneratedRecipeConstraints {
  const parsed = generatedRecipeConstraintsSchema.safeParse(input);
  if (!parsed.success) {
    throw new GeneratedRecipeValidationError(
      "INVALID_CONSTRAINTS",
      "Generated recipe constraints are malformed",
    );
  }
  return parsed.data;
}

export function normalizeGeneratedRecipeDraft(
  input: unknown,
  catalog: readonly GeneratedRecipeCatalogEntry[],
  constraintsInput: GeneratedRecipeConstraints,
): NormalizedGeneratedRecipeDraft {
  const output = parseModelOutput(input);
  const constraints = parseConstraints(constraintsInput);
  const catalogByKey = indexCatalog(catalog);

  if (output.baseServings !== constraints.requestedServings) {
    throw new GeneratedRecipeValidationError(
      "SERVINGS_MISMATCH",
      `Generated yield must be exactly ${constraints.requestedServings} servings`,
      ["baseServings"],
    );
  }

  if (output.effortTier !== constraints.requestedEffortTier) {
    throw new GeneratedRecipeValidationError(
      "EFFORT_MISMATCH",
      `Generated effort must be ${constraints.requestedEffortTier}`,
      ["effortTier"],
    );
  }

  const effortRange = GENERATED_RECIPE_ACTIVE_TIME_RANGES[output.effortTier];
  if (output.activeTimeMinutes < effortRange.minimumMinutes) {
    throw new GeneratedRecipeValidationError(
      "ACTIVE_TIME_BELOW_MINIMUM",
      `Generated ${output.effortTier} active time must be at least ${effortRange.minimumMinutes} minutes`,
      ["activeTimeMinutes"],
    );
  }

  if (output.activeTimeMinutes > constraints.maxActiveTimeMinutes) {
    throw new GeneratedRecipeValidationError(
      "ACTIVE_TIME_EXCEEDED",
      `Generated active time must be ${constraints.maxActiveTimeMinutes} minutes or less`,
      ["activeTimeMinutes"],
    );
  }

  if (output.totalTimeMinutes < output.activeTimeMinutes) {
    throw new GeneratedRecipeValidationError(
      "INVALID_TIME_RANGE",
      "Generated total time cannot be shorter than active time",
      ["totalTimeMinutes"],
    );
  }

  const seenIngredientKeys = new Set<string>();
  const usedCatalogEntries: GeneratedRecipeCatalogEntry[] = [];
  const normalizedIngredients: NormalizedGeneratedRecipeIngredient[] = [];

  for (const [index, ingredient] of output.ingredients.entries()) {
    if (seenIngredientKeys.has(ingredient.catalogKey)) {
      throw new GeneratedRecipeValidationError(
        "DUPLICATE_INGREDIENT",
        `Generated ingredient ${ingredient.catalogKey} appears more than once`,
        ["ingredients", index, "catalogKey"],
      );
    }
    seenIngredientKeys.add(ingredient.catalogKey);

    const reference = catalogByKey.get(ingredient.catalogKey);
    if (!reference) {
      throw new GeneratedRecipeValidationError(
        "UNKNOWN_CATALOG_KEY",
        `Generated ingredient ${ingredient.catalogKey} is not canonical`,
        ["ingredients", index, "catalogKey"],
      );
    }

    let quantityInBaseUnit: number;
    try {
      const converted = convertToCanonical({
        canonicalUnit: reference.baseUnit,
        densityGPerMl: reference.densityGramsPerMl,
        gramsPerCount: reference.gramsPerCount,
        quantity: ingredient.quantity,
        unit: ingredient.unit,
      });
      quantityInBaseUnit = Number(converted.quantity.toFixed(3));
    } catch (error) {
      const detail =
        error instanceof UnitConversionError ? `: ${error.code}` : "";
      throw new GeneratedRecipeValidationError(
        "INVALID_UNIT_CONVERSION",
        `${reference.name} could not be converted to ${reference.baseUnit}${detail}`,
        ["ingredients", index, "unit"],
      );
    }

    if (
      !Number.isFinite(quantityInBaseUnit) ||
      quantityInBaseUnit <= 0 ||
      quantityInBaseUnit > MAX_CANONICAL_QUANTITY
    ) {
      throw new GeneratedRecipeValidationError(
        "INVALID_CANONICAL_QUANTITY",
        `${reference.name} converts outside the supported quantity range`,
        ["ingredients", index, "quantity"],
      );
    }

    // This is a narrow generation safeguard, not a general culinary ratio model.
    if (
      reference.baseUnit === "g" &&
      normalizeReferenceName(reference.name) === "garlic" &&
      quantityInBaseUnit / constraints.requestedServings >
        MAX_GARLIC_GRAMS_PER_SERVING
    ) {
      throw new GeneratedRecipeValidationError(
        "IMPLAUSIBLE_INGREDIENT_QUANTITY",
        `Garlic cannot exceed ${MAX_GARLIC_GRAMS_PER_SERVING} grams per serving`,
        ["ingredients", index, "quantity"],
      );
    }

    usedCatalogEntries.push(reference);
    normalizedIngredients.push({
      canonicalIngredientId: reference.id,
      isOptional: ingredient.isOptional,
      preparation: normalizeOptionalGeneratedText(ingredient.preparation),
      quantity: ingredient.quantity,
      quantityInBaseUnit,
      scalesLinearly: ingredient.scalesLinearly,
      unit: ingredient.unit,
    });
  }

  let primaryProtein: string | null = null;
  if (output.primaryProteinCatalogKey !== null) {
    const primaryProteinReference = catalogByKey.get(
      output.primaryProteinCatalogKey,
    );
    if (!primaryProteinReference) {
      throw new GeneratedRecipeValidationError(
        "UNKNOWN_CATALOG_KEY",
        `Primary protein ${output.primaryProteinCatalogKey} is not canonical`,
        ["primaryProteinCatalogKey"],
      );
    }
    if (primaryProteinReference.category !== "protein") {
      throw new GeneratedRecipeValidationError(
        "PRIMARY_PROTEIN_NOT_PROTEIN",
        "The primary protein must reference a protein catalog entry",
        ["primaryProteinCatalogKey"],
      );
    }
    if (!seenIngredientKeys.has(output.primaryProteinCatalogKey)) {
      throw new GeneratedRecipeValidationError(
        "PRIMARY_PROTEIN_NOT_INCLUDED",
        "The primary protein must appear in the generated ingredient list",
        ["primaryProteinCatalogKey"],
      );
    }
    primaryProtein = primaryProteinReference.name;
  }

  const requiredMinimumTemperature = usedCatalogEntries.reduce(
    (current, entry) =>
      Math.max(current, entry.requiredMinimumInternalTemperatureF ?? 0),
    0,
  );

  if (
    requiredMinimumTemperature > 0 &&
    output.minInternalTemperatureF === null
  ) {
    throw new GeneratedRecipeValidationError(
      "MISSING_INTERNAL_TEMPERATURE",
      "A generated recipe with raw animal protein needs an internal temperature",
      ["minInternalTemperatureF"],
    );
  }

  if (
    requiredMinimumTemperature > 0 &&
    output.minInternalTemperatureF !== null &&
    output.minInternalTemperatureF < requiredMinimumTemperature
  ) {
    throw new GeneratedRecipeValidationError(
      "UNSAFE_INTERNAL_TEMPERATURE",
      `Internal temperature must be at least ${requiredMinimumTemperature} degrees Fahrenheit`,
      ["minInternalTemperatureF"],
    );
  }

  const normalizedTechniques = [
    ...new Set(output.techniques.map(normalizeGeneratedText)),
  ];

  return {
    activeTimeMinutes: output.activeTimeMinutes,
    baseServings: output.baseServings,
    cuisine: normalizeOptionalGeneratedText(output.cuisine),
    description: normalizeOptionalGeneratedText(output.description),
    effortTier: output.effortTier,
    ingredients: normalizedIngredients,
    instructions: output.instructions.map((step, index) => ({
      instruction: normalizeGeneratedText(step.instruction),
      position: index + 1,
    })),
    minInternalTemperatureF: output.minInternalTemperatureF,
    primaryProtein,
    techniques: normalizedTechniques,
    title: normalizeGeneratedText(output.title),
    totalTimeMinutes: output.totalTimeMinutes,
  };
}
