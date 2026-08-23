export type PantryRecipeRequirement = Readonly<{
  baseServings: number;
  canonicalIngredientId: string;
  isOptional: boolean;
  planEntryId: string;
  preparation: string | null;
  quantity: number;
  quantityInBaseUnit: number;
  recipeId: string;
  recipeIngredientId: string;
  recipeTitle: string;
  scalesLinearly: boolean;
  scheduledDate: string;
  servingsTarget: number;
  unit: string;
}>;

export const PANTRY_QUANTITY_MAX = 1_000_000;
export const CUSTOM_PANTRY_ITEM_NAME_MAX = 100;

export type PantryBaseUnit = "g" | "ml" | "count";

export function normalizeCustomPantryItemName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function pantryBaseUnitForMeasurement(
  unit: "count" | "cup" | "fl_oz" | "lb" | "oz" | "tbsp" | "tsp",
): PantryBaseUnit {
  if (unit === "count") return "count";
  if (unit === "oz" || unit === "lb") return "g";
  return "ml";
}

export type PantryInventoryBalance = Readonly<{
  canonicalIngredientId: string;
  quantityInBaseUnit: number;
}>;

export type PantryCoverage = "uncounted" | "short" | "enough";

export type PantryRequirementContribution = Readonly<{
  baseServings: number;
  isOptional: boolean;
  planEntryId: string;
  preparation: string | null;
  recipeId: string;
  recipeIngredientId: string;
  recipeTitle: string;
  requiredQuantityInBaseUnit: number;
  scalesLinearly: boolean;
  scheduledDate: string;
  servingsTarget: number;
  storedQuantity: number;
  storedQuantityInBaseUnit: number;
  storedUnit: string;
}>;

export type PantryRequirementRow = Readonly<{
  canonicalIngredientId: string;
  contributions: readonly PantryRequirementContribution[];
  coverage: PantryCoverage;
  currentQuantityInBaseUnit: number | null;
  optionalOnly: boolean;
  recipeTitles: readonly string[];
  requiredQuantityInBaseUnit: number;
  shortageQuantityInBaseUnit: number;
}>;

export type PantryShoppingSelection = Readonly<{
  buyItems: readonly PantryRequirementRow[];
  checkFirstItems: readonly PantryRequirementRow[];
  optionalItems: readonly PantryRequirementRow[];
  coveredCount: number;
}>;

/**
 * Selects the actionable rows for a live weekly shopping view. Required
 * shortages are buy items, required uncounted ingredients need a pantry
 * check first, and optional-only rows stay separate so their coverage can be
 * explained without turning them into required purchases.
 */
export function selectPantryShoppingItems(
  rows: readonly PantryRequirementRow[],
): PantryShoppingSelection {
  const buyItems: PantryRequirementRow[] = [];
  const checkFirstItems: PantryRequirementRow[] = [];
  const optionalItems: PantryRequirementRow[] = [];
  let coveredCount = 0;

  for (const row of rows) {
    if (row.coverage === "enough") {
      coveredCount += 1;
      continue;
    }

    if (row.optionalOnly) {
      optionalItems.push(row);
    } else if (row.coverage === "short") {
      buyItems.push(row);
    } else {
      checkFirstItems.push(row);
    }
  }

  return { buyItems, checkFirstItems, optionalItems, coveredCount };
}

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a finite number greater than zero.`);
  }
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `${label} must be a finite number greater than or equal to zero.`,
    );
  }
}

function roundToThreeDecimals(value: number): number {
  return Number(value.toFixed(3));
}

const PANTRY_COVERAGE_RELATIVE_TOLERANCE = 0.001;
const PANTRY_COVERAGE_ABSOLUTE_TOLERANCE = 0.001;

function pantryShortageQuantity(
  requiredQuantityInBaseUnit: number,
  currentQuantityInBaseUnit: number,
): number {
  const shortageQuantityInBaseUnit = roundToThreeDecimals(
    Math.max(requiredQuantityInBaseUnit - currentQuantityInBaseUnit, 0),
  );
  const tolerance = Math.max(
    PANTRY_COVERAGE_ABSOLUTE_TOLERANCE,
    requiredQuantityInBaseUnit * PANTRY_COVERAGE_RELATIVE_TOLERANCE,
  );

  return shortageQuantityInBaseUnit <= tolerance
    ? 0
    : shortageQuantityInBaseUnit;
}

/**
 * Aggregates recipe requirements for a plan and compares them with tracked
 * household inventory. An ingredient without a balance is intentionally
 * uncounted; a balance of zero is a tracked empty ingredient.
 */
export function aggregatePantryRequirements(
  requirements: readonly PantryRecipeRequirement[],
  inventoryBalances: readonly PantryInventoryBalance[],
): readonly PantryRequirementRow[] {
  const inventoryByIngredient = new Map<string, number>();

  for (const balance of inventoryBalances) {
    assertFiniteNonNegative(
      balance.quantityInBaseUnit,
      `Inventory quantity for ${balance.canonicalIngredientId}`,
    );
    inventoryByIngredient.set(
      balance.canonicalIngredientId,
      (inventoryByIngredient.get(balance.canonicalIngredientId) ?? 0) +
        balance.quantityInBaseUnit,
    );
  }

  const rows = new Map<
    string,
    {
      contributions: PantryRequirementContribution[];
      optional: number;
      recipeTitles: Set<string>;
      required: number;
    }
  >();

  for (const requirement of requirements) {
    assertFinitePositive(
      requirement.quantityInBaseUnit,
      `Required quantity for ${requirement.canonicalIngredientId}`,
    );
    assertFinitePositive(
      requirement.quantity,
      `Stored recipe quantity for ${requirement.recipeTitle}`,
    );
    assertFinitePositive(
      requirement.baseServings,
      `Base servings for ${requirement.recipeTitle}`,
    );
    assertFiniteNonNegative(
      requirement.servingsTarget,
      `Serving target for ${requirement.recipeTitle}`,
    );

    if (requirement.servingsTarget === 0) continue;

    const required = requirement.scalesLinearly
      ? requirement.quantityInBaseUnit *
        (requirement.servingsTarget / requirement.baseServings)
      : requirement.quantityInBaseUnit;
    const contribution: PantryRequirementContribution = {
      baseServings: requirement.baseServings,
      isOptional: requirement.isOptional,
      planEntryId: requirement.planEntryId,
      preparation: requirement.preparation,
      recipeId: requirement.recipeId,
      recipeIngredientId: requirement.recipeIngredientId,
      recipeTitle: requirement.recipeTitle,
      requiredQuantityInBaseUnit: roundToThreeDecimals(required),
      scalesLinearly: requirement.scalesLinearly,
      scheduledDate: requirement.scheduledDate,
      servingsTarget: requirement.servingsTarget,
      storedQuantity: requirement.quantity,
      storedQuantityInBaseUnit: requirement.quantityInBaseUnit,
      storedUnit: requirement.unit,
    };
    const existing = rows.get(requirement.canonicalIngredientId);

    if (existing) {
      if (requirement.isOptional) existing.optional += required;
      else existing.required += required;
      existing.contributions.push(contribution);
      existing.recipeTitles.add(requirement.recipeTitle);
    } else {
      rows.set(requirement.canonicalIngredientId, {
        contributions: [contribution],
        optional: requirement.isOptional ? required : 0,
        recipeTitles: new Set([requirement.recipeTitle]),
        required: requirement.isOptional ? 0 : required,
      });
    }
  }

  return [...rows.entries()].map(([canonicalIngredientId, aggregate]) => {
    const optionalOnly = aggregate.required === 0;
    const requiredQuantityInBaseUnit = roundToThreeDecimals(
      optionalOnly ? aggregate.optional : aggregate.required,
    );
    const currentQuantityInBaseUnit =
      inventoryByIngredient.get(canonicalIngredientId) ?? null;
    const shortageQuantityInBaseUnit =
      currentQuantityInBaseUnit === null
        ? 0
        : pantryShortageQuantity(
            requiredQuantityInBaseUnit,
            currentQuantityInBaseUnit,
          );

    return {
      canonicalIngredientId,
      contributions: aggregate.contributions,
      coverage:
        currentQuantityInBaseUnit === null
          ? "uncounted"
          : shortageQuantityInBaseUnit > 0
            ? "short"
            : "enough",
      currentQuantityInBaseUnit,
      optionalOnly,
      recipeTitles: [...aggregate.recipeTitles],
      requiredQuantityInBaseUnit,
      shortageQuantityInBaseUnit,
    };
  });
}
