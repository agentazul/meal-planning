export type PantryRecipeRequirement = Readonly<{
  baseServings: number;
  canonicalIngredientId: string;
  isOptional: boolean;
  quantityInBaseUnit: number;
  recipeTitle: string;
  scalesLinearly: boolean;
  servingsTarget: number;
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

export type PantryRequirementRow = Readonly<{
  canonicalIngredientId: string;
  coverage: PantryCoverage;
  currentQuantityInBaseUnit: number | null;
  optionalOnly: boolean;
  recipeTitles: readonly string[];
  requiredQuantityInBaseUnit: number;
  shortageQuantityInBaseUnit: number;
}>;

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a finite number greater than zero.`);
  }
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite number greater than or equal to zero.`);
  }
}

function roundToThreeDecimals(value: number): number {
  return Number(value.toFixed(3));
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
    { optionalOnly: boolean; recipeTitles: Set<string>; required: number }
  >();

  for (const requirement of requirements) {
    assertFinitePositive(
      requirement.quantityInBaseUnit,
      `Required quantity for ${requirement.canonicalIngredientId}`,
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
    const existing = rows.get(requirement.canonicalIngredientId);

    if (existing) {
      existing.required += required;
      existing.optionalOnly &&= requirement.isOptional;
      existing.recipeTitles.add(requirement.recipeTitle);
    } else {
      rows.set(requirement.canonicalIngredientId, {
        optionalOnly: requirement.isOptional,
        recipeTitles: new Set([requirement.recipeTitle]),
        required,
      });
    }
  }

  return [...rows.entries()].map(([canonicalIngredientId, aggregate]) => {
    const requiredQuantityInBaseUnit = roundToThreeDecimals(aggregate.required);
    const currentQuantityInBaseUnit =
      inventoryByIngredient.get(canonicalIngredientId) ?? null;
    const shortageQuantityInBaseUnit = roundToThreeDecimals(
      currentQuantityInBaseUnit === null
        ? 0
        : Math.max(requiredQuantityInBaseUnit - currentQuantityInBaseUnit, 0),
    );

    return {
      canonicalIngredientId,
      coverage:
        currentQuantityInBaseUnit === null
          ? "uncounted"
          : shortageQuantityInBaseUnit > 0
            ? "short"
            : "enough",
      currentQuantityInBaseUnit,
      optionalOnly: aggregate.optionalOnly,
      recipeTitles: [...aggregate.recipeTitles],
      requiredQuantityInBaseUnit,
      shortageQuantityInBaseUnit,
    };
  });
}
