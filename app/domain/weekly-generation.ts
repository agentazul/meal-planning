import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

import {
  GENERATED_RECIPE_ACTIVE_TIME_RANGES,
  GENERATED_RECIPE_EFFORT_TIERS,
  buildGeneratedRecipeCatalog,
  generatedRecipeCatalogKeySchema,
  getRequiredMinimumInternalTemperatureF,
  type GeneratedRecipeCanonicalReference,
  type GeneratedRecipeCatalogEntry,
  type GeneratedRecipeEffortTier,
} from "./generated-recipe";
import {
  convertToCanonical,
  SUPPORTED_MEASUREMENT_UNITS,
  UnitConversionError,
  type MeasurementUnit,
} from "./units";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CANDIDATE_KEY_PATTERN = /^c\d{3}$/;
const SLOT_KEY_PATTERN = /^d[1-5]$/;
const FORBIDDEN_DASH_PATTERN = /[\u2013\u2014]/u;
const MAX_CANONICAL_QUANTITY = 99_999_999_999;
const MAX_GARLIC_GRAMS_PER_SERVING = 15;

const generatedTextSchema = (maximumLength: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximumLength)
    .regex(/\S/u, "Text cannot be blank")
    .refine(
      (value) => !FORBIDDEN_DASH_PATTERN.test(value),
      "Use a regular hyphen instead of a long dash",
    );

const nullableGeneratedTextSchema = (maximumLength: number) =>
  generatedTextSchema(maximumLength).nullable();

export const weeklyGenerationSlotSchema = z.strictObject({
  date: z.string().regex(DATE_ONLY_PATTERN),
  effortTier: z.enum(GENERATED_RECIPE_EFFORT_TIERS),
  maxActiveTimeMinutes: z.number().int().min(5).max(240),
  servingsTarget: z.number().int().min(1).max(20),
  slotKey: z.string().regex(SLOT_KEY_PATTERN),
});

export const weeklyGenerationSlotsSchema = z
  .array(weeklyGenerationSlotSchema)
  .length(5)
  .superRefine((slots, context) => {
    const dates = new Set<string>();
    const keys = new Set<string>();

    for (const [index, slot] of slots.entries()) {
      if (dates.has(slot.date)) {
        context.addIssue({
          code: "custom",
          message: "Weekly generation dates must be unique",
          path: [index, "date"],
        });
      }
      if (keys.has(slot.slotKey)) {
        context.addIssue({
          code: "custom",
          message: "Weekly generation slot keys must be unique",
          path: [index, "slotKey"],
        });
      }
      dates.add(slot.date);
      keys.add(slot.slotKey);

      const range = GENERATED_RECIPE_ACTIVE_TIME_RANGES[slot.effortTier];
      if (
        slot.maxActiveTimeMinutes < Math.max(5, range.minimumMinutes) ||
        slot.maxActiveTimeMinutes > range.maximumMinutes
      ) {
        context.addIssue({
          code: "custom",
          message: "The slot active-time ceiling does not match its effort tier",
          path: [index, "maxActiveTimeMinutes"],
        });
      }
    }
  });

export type WeeklyGenerationSlot = z.infer<typeof weeklyGenerationSlotSchema>;

export type WeeklyGenerationDayInput = Readonly<{
  date: string;
  demand: number;
  servingsTarget: number;
}>;

export function normalizeWeeklyGenerationDietaryNotes(
  notes: readonly string[],
): readonly string[] {
  return notes
    .map((note) => note.replace(/\r\n?/g, "\n").trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, "en-US"));
}

export function buildDefaultWeeklyGenerationSlots(
  days: readonly WeeklyGenerationDayInput[],
): readonly WeeklyGenerationSlot[] {
  const eligible = days
    .filter(
      (day) =>
        DATE_ONLY_PATTERN.test(day.date) &&
        Number.isFinite(day.demand) &&
        Number.isInteger(day.servingsTarget) &&
        day.servingsTarget > 0,
    )
    .sort((left, right) => {
      const demandDifference = right.demand - left.demand;
      return demandDifference !== 0
        ? demandDifference
        : left.date.localeCompare(right.date);
    })
    .slice(0, 5)
    .sort((left, right) => left.date.localeCompare(right.date));

  if (eligible.length !== 5) {
    throw new WeeklyGenerationValidationError(
      "INVALID_SLOTS",
      "Five dinner dates with present household members are required",
    );
  }

  return weeklyGenerationSlotsSchema.parse(
    eligible.map((day, index) => {
      const date = Temporal.PlainDate.from(day.date);
      const isWeekend = date.dayOfWeek === 6 || date.dayOfWeek === 7;
      return {
        date: day.date,
        effortTier: isWeekend ? "weekend" : "weeknight",
        maxActiveTimeMinutes: isWeekend ? 90 : 45,
        servingsTarget: day.servingsTarget,
        slotKey: `d${index + 1}`,
      };
    }),
  );
}

export const weeklyCandidateIngredientModelSchema = z.strictObject({
  catalogKey: generatedRecipeCatalogKeySchema,
  isOptional: z.boolean(),
  preparation: nullableGeneratedTextSchema(120),
  quantity: z.number().min(0.001).max(MAX_CANONICAL_QUANTITY),
  scalesLinearly: z.boolean(),
  unit: z.enum(SUPPORTED_MEASUREMENT_UNITS),
});

export const weeklyCandidateModelSchema = z.strictObject({
  activeTimeMinutes: z.number().int().min(0).max(240),
  baseServings: z.number().int().min(1).max(20),
  cuisine: nullableGeneratedTextSchema(100),
  effortTier: z.enum(GENERATED_RECIPE_EFFORT_TIERS),
  ingredients: z.array(weeklyCandidateIngredientModelSchema).min(3).max(30),
  minInternalTemperatureF: z.number().int().min(120).max(205).nullable(),
  primaryProteinCatalogKey: generatedRecipeCatalogKeySchema.nullable(),
  slotDate: z.string().regex(DATE_ONLY_PATTERN),
  techniques: z.array(generatedTextSchema(80)).min(1).max(8),
  title: generatedTextSchema(160),
  totalTimeMinutes: z.number().int().min(1).max(1_440),
});

export type WeeklyCandidateModel = z.infer<typeof weeklyCandidateModelSchema>;

export type WeeklyGenerationCatalogReference =
  GeneratedRecipeCanonicalReference & Readonly<{ isStaple: boolean }>;

export type WeeklyGenerationCatalogEntry = GeneratedRecipeCatalogEntry &
  Readonly<{ isStaple: boolean }>;

export function buildWeeklyGenerationCatalog(
  references: readonly WeeklyGenerationCatalogReference[],
): readonly WeeklyGenerationCatalogEntry[] {
  const stapleById = new Map(
    references.map((reference) => [reference.id, reference.isStaple]),
  );
  return buildGeneratedRecipeCatalog(references).map((entry) => ({
    ...entry,
    isStaple: stapleById.get(entry.id) ?? false,
  }));
}

export const normalizedWeeklyCandidateIngredientSchema = z.strictObject({
  baseUnit: z.enum(["g", "ml", "count"]),
  canonicalIngredientId: z.uuid(),
  catalogKey: generatedRecipeCatalogKeySchema,
  isOptional: z.boolean(),
  isStaple: z.boolean(),
  name: generatedTextSchema(200),
  preparation: nullableGeneratedTextSchema(120),
  quantity: z.number().positive().max(MAX_CANONICAL_QUANTITY),
  quantityInBaseUnit: z.number().positive().max(MAX_CANONICAL_QUANTITY),
  scalesLinearly: z.boolean(),
  unit: z.enum(SUPPORTED_MEASUREMENT_UNITS),
});

export const normalizedWeeklyCandidateSchema = z.strictObject({
  activeTimeMinutes: z.number().int().min(0).max(240),
  baseServings: z.number().int().min(1).max(20),
  candidateKey: z.string().regex(CANDIDATE_KEY_PATTERN),
  cuisine: nullableGeneratedTextSchema(100),
  effortTier: z.enum(GENERATED_RECIPE_EFFORT_TIERS),
  ingredients: z.array(normalizedWeeklyCandidateIngredientSchema).min(3).max(30),
  minInternalTemperatureF: z.number().int().min(120).max(205).nullable(),
  primaryProtein: nullableGeneratedTextSchema(200),
  primaryProteinCatalogKey: generatedRecipeCatalogKeySchema.nullable(),
  slotDate: z.string().regex(DATE_ONLY_PATTERN),
  techniques: z.array(generatedTextSchema(80)).min(1).max(8),
  title: generatedTextSchema(160),
  totalTimeMinutes: z.number().int().min(1).max(1_440),
});

export const normalizedWeeklyCandidatePoolSchema = z
  .array(normalizedWeeklyCandidateSchema)
  .length(15);

export type NormalizedWeeklyCandidate = z.infer<
  typeof normalizedWeeklyCandidateSchema
>;

export type WeeklyGenerationValidationErrorCode =
  | "DUPLICATE_CANDIDATE_TITLE"
  | "DUPLICATE_INGREDIENT"
  | "EFFORT_MISMATCH"
  | "IMPLAUSIBLE_QUANTITY"
  | "INVALID_CANDIDATE_POOL"
  | "INVALID_SLOTS"
  | "INVALID_TIME"
  | "INVALID_UNIT"
  | "MISSING_INTERNAL_TEMPERATURE"
  | "PRIMARY_PROTEIN_INVALID"
  | "SERVINGS_MISMATCH"
  | "SLOT_COVERAGE"
  | "UNKNOWN_CATALOG_KEY"
  | "UNSAFE_INTERNAL_TEMPERATURE";

export class WeeklyGenerationValidationError extends Error {
  override readonly name = "WeeklyGenerationValidationError";

  constructor(
    readonly code: WeeklyGenerationValidationErrorCode,
    message: string,
    readonly path: readonly (number | string)[] = [],
  ) {
    super(message);
  }
}

function normalizedName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function normalizeCandidate(
  input: WeeklyCandidateModel,
  candidateKey: string,
  catalogByKey: ReadonlyMap<string, WeeklyGenerationCatalogEntry>,
  slotByDate: ReadonlyMap<string, WeeklyGenerationSlot>,
): NormalizedWeeklyCandidate {
  const slot = slotByDate.get(input.slotDate);
  if (!slot) {
    throw new WeeklyGenerationValidationError(
      "SLOT_COVERAGE",
      "A candidate references a date outside the generated week",
      ["slotDate"],
    );
  }
  if (input.baseServings !== slot.servingsTarget) {
    throw new WeeklyGenerationValidationError(
      "SERVINGS_MISMATCH",
      `Candidate yield must be exactly ${slot.servingsTarget} servings`,
      ["baseServings"],
    );
  }
  if (input.effortTier !== slot.effortTier) {
    throw new WeeklyGenerationValidationError(
      "EFFORT_MISMATCH",
      `Candidate effort must be ${slot.effortTier}`,
      ["effortTier"],
    );
  }
  const effortRange = GENERATED_RECIPE_ACTIVE_TIME_RANGES[input.effortTier];
  if (
    input.activeTimeMinutes < effortRange.minimumMinutes ||
    input.activeTimeMinutes > slot.maxActiveTimeMinutes ||
    input.totalTimeMinutes < input.activeTimeMinutes
  ) {
    throw new WeeklyGenerationValidationError(
      "INVALID_TIME",
      "Candidate cooking time does not fit its selected night",
      ["activeTimeMinutes"],
    );
  }

  const seenKeys = new Set<string>();
  const usedEntries: WeeklyGenerationCatalogEntry[] = [];
  const ingredients = input.ingredients.map((ingredient, index) => {
    if (seenKeys.has(ingredient.catalogKey)) {
      throw new WeeklyGenerationValidationError(
        "DUPLICATE_INGREDIENT",
        `Candidate ingredient ${ingredient.catalogKey} appears more than once`,
        ["ingredients", index, "catalogKey"],
      );
    }
    seenKeys.add(ingredient.catalogKey);

    const reference = catalogByKey.get(ingredient.catalogKey);
    if (!reference) {
      throw new WeeklyGenerationValidationError(
        "UNKNOWN_CATALOG_KEY",
        `Candidate ingredient ${ingredient.catalogKey} is not canonical`,
        ["ingredients", index, "catalogKey"],
      );
    }

    let quantityInBaseUnit: number;
    try {
      quantityInBaseUnit = Number(
        convertToCanonical({
          canonicalUnit: reference.baseUnit,
          densityGPerMl: reference.densityGramsPerMl,
          gramsPerCount: reference.gramsPerCount,
          quantity: ingredient.quantity,
          unit: ingredient.unit,
        }).quantity.toFixed(3),
      );
    } catch (error) {
      const code = error instanceof UnitConversionError ? `: ${error.code}` : "";
      throw new WeeklyGenerationValidationError(
        "INVALID_UNIT",
        `${reference.name} could not be converted${code}`,
        ["ingredients", index, "unit"],
      );
    }

    if (
      !Number.isFinite(quantityInBaseUnit) ||
      quantityInBaseUnit <= 0 ||
      quantityInBaseUnit > MAX_CANONICAL_QUANTITY
    ) {
      throw new WeeklyGenerationValidationError(
        "INVALID_UNIT",
        `${reference.name} converts outside the supported range`,
        ["ingredients", index, "quantity"],
      );
    }
    if (
      reference.baseUnit === "g" &&
      normalizedName(reference.name) === "garlic" &&
      quantityInBaseUnit / slot.servingsTarget > MAX_GARLIC_GRAMS_PER_SERVING
    ) {
      throw new WeeklyGenerationValidationError(
        "IMPLAUSIBLE_QUANTITY",
        `Garlic cannot exceed ${MAX_GARLIC_GRAMS_PER_SERVING} grams per serving`,
        ["ingredients", index, "quantity"],
      );
    }

    usedEntries.push(reference);
    return {
      baseUnit: reference.baseUnit,
      canonicalIngredientId: reference.id,
      catalogKey: reference.catalogKey,
      isOptional: ingredient.isOptional,
      isStaple: reference.isStaple,
      name: reference.name.trim(),
      preparation: ingredient.preparation?.trim() ?? null,
      quantity: ingredient.quantity,
      quantityInBaseUnit,
      scalesLinearly: ingredient.scalesLinearly,
      unit: ingredient.unit as MeasurementUnit,
    };
  });

  let primaryProtein: string | null = null;
  if (input.primaryProteinCatalogKey !== null) {
    const reference = catalogByKey.get(input.primaryProteinCatalogKey);
    if (
      !reference ||
      reference.category !== "protein" ||
      !seenKeys.has(input.primaryProteinCatalogKey)
    ) {
      throw new WeeklyGenerationValidationError(
        "PRIMARY_PROTEIN_INVALID",
        "The primary protein must be a protein included in the candidate",
        ["primaryProteinCatalogKey"],
      );
    }
    primaryProtein = reference.name.trim();
  }

  const requiredTemperature = usedEntries.reduce(
    (current, entry) =>
      Math.max(
        current,
        getRequiredMinimumInternalTemperatureF(entry.name, entry.category) ?? 0,
      ),
    0,
  );
  if (requiredTemperature > 0 && input.minInternalTemperatureF === null) {
    throw new WeeklyGenerationValidationError(
      "MISSING_INTERNAL_TEMPERATURE",
      "A candidate with raw animal protein needs an internal temperature",
      ["minInternalTemperatureF"],
    );
  }
  if (
    requiredTemperature > 0 &&
    input.minInternalTemperatureF !== null &&
    input.minInternalTemperatureF < requiredTemperature
  ) {
    throw new WeeklyGenerationValidationError(
      "UNSAFE_INTERNAL_TEMPERATURE",
      `Internal temperature must be at least ${requiredTemperature} degrees Fahrenheit`,
      ["minInternalTemperatureF"],
    );
  }

  return normalizedWeeklyCandidateSchema.parse({
    activeTimeMinutes: input.activeTimeMinutes,
    baseServings: input.baseServings,
    candidateKey,
    cuisine: input.cuisine?.trim() ?? null,
    effortTier: input.effortTier,
    ingredients,
    minInternalTemperatureF: input.minInternalTemperatureF,
    primaryProtein,
    primaryProteinCatalogKey: input.primaryProteinCatalogKey,
    slotDate: input.slotDate,
    techniques: [...new Set(input.techniques.map((value) => value.trim()))],
    title: input.title.trim(),
    totalTimeMinutes: input.totalTimeMinutes,
  });
}

export function normalizeWeeklyCandidatePool(input: {
  catalog: readonly WeeklyGenerationCatalogEntry[];
  candidates: readonly WeeklyCandidateModel[];
  slots: readonly WeeklyGenerationSlot[];
}): readonly NormalizedWeeklyCandidate[] {
  const parsedSlots = weeklyGenerationSlotsSchema.safeParse(input.slots);
  const parsedCandidates = z.array(weeklyCandidateModelSchema).length(15).safeParse(
    input.candidates,
  );
  if (!parsedSlots.success || !parsedCandidates.success) {
    throw new WeeklyGenerationValidationError(
      "INVALID_CANDIDATE_POOL",
      "The weekly candidate pool is malformed",
    );
  }

  const catalogByKey = new Map(input.catalog.map((entry) => [entry.catalogKey, entry]));
  if (catalogByKey.size !== input.catalog.length || catalogByKey.size < 1) {
    throw new WeeklyGenerationValidationError(
      "INVALID_CANDIDATE_POOL",
      "The weekly ingredient catalog is malformed",
    );
  }
  const slotByDate = new Map(parsedSlots.data.map((slot) => [slot.date, slot]));
  const normalized = parsedCandidates.data.map((candidate, index) =>
    normalizeCandidate(
      candidate,
      `c${String(index + 1).padStart(3, "0")}`,
      catalogByKey,
      slotByDate,
    ),
  );

  const titles = new Set<string>();
  for (const [index, candidate] of normalized.entries()) {
    const title = normalizedName(candidate.title);
    if (titles.has(title)) {
      throw new WeeklyGenerationValidationError(
        "DUPLICATE_CANDIDATE_TITLE",
        `Candidate title is duplicated: ${candidate.title}`,
        [index, "title"],
      );
    }
    titles.add(title);
  }

  for (const slot of parsedSlots.data) {
    if (normalized.filter((candidate) => candidate.slotDate === slot.date).length !== 3) {
      throw new WeeklyGenerationValidationError(
        "SLOT_COVERAGE",
        `Exactly three candidates are required for ${slot.date}`,
      );
    }
  }

  return normalizedWeeklyCandidatePoolSchema.parse(normalized);
}

export const weeklyGenerationSelectionItemSchema = z.strictObject({
  candidateKey: z.string().regex(CANDIDATE_KEY_PATTERN),
  slotDate: z.string().regex(DATE_ONLY_PATTERN),
});

export const weeklyGenerationSelectionScoreSchema = z.strictObject({
  cuisineVariety: z.number().int().nonnegative(),
  proteinVariety: z.number().int().nonnegative(),
  sharedIngredientNames: z.array(generatedTextSchema(200)).max(12),
  techniqueVariety: z.number().int().nonnegative(),
  value: z.number().int(),
});

export const weeklyGenerationSelectionSchema = z.strictObject({
  items: z.array(weeklyGenerationSelectionItemSchema).length(5),
  score: weeklyGenerationSelectionScoreSchema,
});

export type WeeklyGenerationSelection = z.infer<
  typeof weeklyGenerationSelectionSchema
>;

export const weeklyGenerationRerollHistorySchema = z.record(
  z.string().regex(DATE_ONLY_PATTERN),
  z.array(z.string().regex(CANDIDATE_KEY_PATTERN)).max(3),
);

export type WeeklyGenerationRerollHistory = z.infer<
  typeof weeklyGenerationRerollHistorySchema
>;

function scoreCandidates(
  candidates: readonly NormalizedWeeklyCandidate[],
): WeeklyGenerationSelection["score"] {
  const proteins = new Set(
    candidates.flatMap((candidate) =>
      candidate.primaryProtein ? [normalizedName(candidate.primaryProtein)] : [],
    ),
  );
  const cuisines = new Set(
    candidates.flatMap((candidate) =>
      candidate.cuisine ? [normalizedName(candidate.cuisine)] : [],
    ),
  );
  const techniques = new Set(
    candidates.flatMap((candidate) => candidate.techniques.map(normalizedName)),
  );
  const ingredientUse = new Map<string, { count: number; name: string }>();
  for (const candidate of candidates) {
    for (const ingredient of candidate.ingredients) {
      if (ingredient.isStaple || ingredient.isOptional) continue;
      const current = ingredientUse.get(ingredient.canonicalIngredientId);
      ingredientUse.set(ingredient.canonicalIngredientId, {
        count: (current?.count ?? 0) + 1,
        name: ingredient.name,
      });
    }
  }
  const shared = [...ingredientUse.values()]
    .filter((entry) => entry.count > 1)
    .sort(
      (left, right) =>
        right.count - left.count || left.name.localeCompare(right.name),
    );
  const sharedOccurrenceCount = shared.reduce(
    (total, entry) => total + entry.count - 1,
    0,
  );

  return {
    cuisineVariety: cuisines.size,
    proteinVariety: proteins.size,
    sharedIngredientNames: shared.slice(0, 12).map((entry) => entry.name),
    techniqueVariety: techniques.size,
    value:
      proteins.size * 100 +
      cuisines.size * 30 +
      techniques.size * 10 +
      shared.length * 25 +
      sharedOccurrenceCount * 5,
  };
}

function selectionTieKey(candidates: readonly NormalizedWeeklyCandidate[]): string {
  return candidates.map((candidate) => candidate.candidateKey).join("|");
}

function candidateCombinations(
  groups: readonly (readonly NormalizedWeeklyCandidate[])[],
  groupIndex = 0,
  chosen: readonly NormalizedWeeklyCandidate[] = [],
): readonly (readonly NormalizedWeeklyCandidate[])[] {
  if (groupIndex >= groups.length) return [chosen];
  const group = groups[groupIndex] ?? [];
  return group.flatMap((candidate) =>
    candidateCombinations(groups, groupIndex + 1, [...chosen, candidate]),
  );
}

export function chooseWeeklyGenerationSelection(
  candidatesInput: readonly NormalizedWeeklyCandidate[],
  slotsInput: readonly WeeklyGenerationSlot[],
): WeeklyGenerationSelection {
  const candidates = normalizedWeeklyCandidatePoolSchema.parse(candidatesInput);
  const slots = weeklyGenerationSlotsSchema.parse(slotsInput);
  const groups = slots.map((slot) =>
    candidates
      .filter((candidate) => candidate.slotDate === slot.date)
      .sort((left, right) => left.candidateKey.localeCompare(right.candidateKey)),
  );
  const combinations = candidateCombinations(groups);
  if (combinations.length === 0) {
    throw new WeeklyGenerationValidationError(
      "SLOT_COVERAGE",
      "The candidate pool cannot cover all five dinner dates",
    );
  }

  const ranked = combinations
    .map((combination) => ({
      candidates: combination,
      score: scoreCandidates(combination),
      tieKey: selectionTieKey(combination),
    }))
    .sort(
      (left, right) =>
        right.score.value - left.score.value ||
        left.tieKey.localeCompare(right.tieKey),
    );
  const winner = ranked[0];
  if (!winner) {
    throw new WeeklyGenerationValidationError(
      "INVALID_CANDIDATE_POOL",
      "A weekly candidate selection could not be computed",
    );
  }

  return weeklyGenerationSelectionSchema.parse({
    items: winner.candidates.map((candidate) => ({
      candidateKey: candidate.candidateKey,
      slotDate: candidate.slotDate,
    })),
    score: winner.score,
  });
}

export function createWeeklyGenerationRerollHistory(
  selection: WeeklyGenerationSelection,
): WeeklyGenerationRerollHistory {
  return weeklyGenerationRerollHistorySchema.parse(
    Object.fromEntries(
      selection.items.map((item) => [item.slotDate, [item.candidateKey]]),
    ),
  );
}

export function rerollWeeklyGenerationSlot(input: {
  candidates: readonly NormalizedWeeklyCandidate[];
  history: WeeklyGenerationRerollHistory;
  selection: WeeklyGenerationSelection;
  slotDate: string;
}): Readonly<{
  history: WeeklyGenerationRerollHistory;
  selection: WeeklyGenerationSelection;
}> | null {
  const candidates = normalizedWeeklyCandidatePoolSchema.parse(input.candidates);
  const selection = weeklyGenerationSelectionSchema.parse(input.selection);
  const history = weeklyGenerationRerollHistorySchema.parse(input.history);
  const selectedByDate = new Map(
    selection.items.map((item) => [item.slotDate, item.candidateKey]),
  );
  if (!selectedByDate.has(input.slotDate)) return null;

  const used = new Set(history[input.slotDate] ?? []);
  const alternatives = candidates.filter(
    (candidate) =>
      candidate.slotDate === input.slotDate && !used.has(candidate.candidateKey),
  );
  if (alternatives.length === 0) return null;

  const candidateByKey = new Map(
    candidates.map((candidate) => [candidate.candidateKey, candidate]),
  );
  const ranked = alternatives
    .map((alternative) => {
      const nextItems = selection.items.map((item) =>
        item.slotDate === input.slotDate
          ? { ...item, candidateKey: alternative.candidateKey }
          : item,
      );
      const selectedCandidates = nextItems.map((item) => {
        const candidate = candidateByKey.get(item.candidateKey);
        if (!candidate) {
          throw new WeeklyGenerationValidationError(
            "INVALID_CANDIDATE_POOL",
            "A selected candidate is missing from the pool",
          );
        }
        return candidate;
      });
      return {
        items: nextItems,
        score: scoreCandidates(selectedCandidates),
        tieKey: alternative.candidateKey,
      };
    })
    .sort(
      (left, right) =>
        right.score.value - left.score.value ||
        left.tieKey.localeCompare(right.tieKey),
    );
  const winner = ranked[0];
  if (!winner) return null;

  const nextSelection = weeklyGenerationSelectionSchema.parse({
    items: winner.items,
    score: winner.score,
  });
  const nextHistory = weeklyGenerationRerollHistorySchema.parse({
    ...history,
    [input.slotDate]: [
      ...(history[input.slotDate] ?? []),
      nextSelection.items.find((item) => item.slotDate === input.slotDate)
        ?.candidateKey,
    ].filter((value): value is string => Boolean(value)),
  });

  return { history: nextHistory, selection: nextSelection };
}

export function selectedWeeklyCandidates(input: {
  candidates: readonly NormalizedWeeklyCandidate[];
  selection: WeeklyGenerationSelection;
}): readonly NormalizedWeeklyCandidate[] {
  const candidates = normalizedWeeklyCandidatePoolSchema.parse(input.candidates);
  const selection = weeklyGenerationSelectionSchema.parse(input.selection);
  const byKey = new Map(
    candidates.map((candidate) => [candidate.candidateKey, candidate]),
  );
  return selection.items.map((item) => {
    const candidate = byKey.get(item.candidateKey);
    if (!candidate || candidate.slotDate !== item.slotDate) {
      throw new WeeklyGenerationValidationError(
        "INVALID_CANDIDATE_POOL",
        "A selected candidate does not match its dinner date",
      );
    }
    return candidate;
  });
}
