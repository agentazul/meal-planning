import { PANTRY_QUANTITY_MAX, type PantryBaseUnit } from "~/domain/pantry";
import {
  convertToCanonical,
  US_RECIPE_MEASUREMENT_UNITS,
  type UsRecipeMeasurementUnit,
} from "~/domain/units";

export const PANTRY_RESTOCK_BATCH_MAX_ITEMS = 100;
export const PANTRY_RESTOCK_PACKAGE_COUNT_MAX = 100;

export type PantryRestockInventoryMode = "purchase" | "total";

export type PantryRestockItemInput = Readonly<{
  canonicalIngredientId: string;
  inventoryMode: PantryRestockInventoryMode;
  packageCount: number;
  quantity: number | null;
  unit: UsRecipeMeasurementUnit;
}>;

export type PantryRestockBatchInput = Readonly<{
  batchId: string;
  items: readonly PantryRestockItemInput[];
  weekStart: string;
}>;

export type PantryRestockValidationErrorCode =
  | "INVALID_BATCH_ID"
  | "INVALID_INGREDIENT_ID"
  | "INVALID_INVENTORY_MODE"
  | "INVALID_ITEM_COUNT"
  | "INVALID_PACKAGE_COUNT"
  | "INVALID_QUANTITY"
  | "INVALID_UNIT"
  | "INVALID_WEEK_START";

export class PantryRestockValidationError extends Error {
  override readonly name = "PantryRestockValidationError";

  constructor(readonly code: PantryRestockValidationErrorCode) {
    super(code);
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function validatePantryRestockBatchInput(
  input: PantryRestockBatchInput,
): void {
  if (!UUID_PATTERN.test(input.batchId)) {
    throw new PantryRestockValidationError("INVALID_BATCH_ID");
  }
  if (!isCalendarDate(input.weekStart)) {
    throw new PantryRestockValidationError("INVALID_WEEK_START");
  }
  if (
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > PANTRY_RESTOCK_BATCH_MAX_ITEMS
  ) {
    throw new PantryRestockValidationError("INVALID_ITEM_COUNT");
  }

  const ingredientIds = new Set<string>();
  for (const item of input.items) {
    if (!UUID_PATTERN.test(item.canonicalIngredientId)) {
      throw new PantryRestockValidationError("INVALID_INGREDIENT_ID");
    }
    if (ingredientIds.has(item.canonicalIngredientId)) {
      throw new PantryRestockValidationError("INVALID_INGREDIENT_ID");
    }
    ingredientIds.add(item.canonicalIngredientId);

    if (item.inventoryMode !== "purchase" && item.inventoryMode !== "total") {
      throw new PantryRestockValidationError("INVALID_INVENTORY_MODE");
    }
    if (
      !Number.isInteger(item.packageCount) ||
      item.packageCount < 1 ||
      item.packageCount > PANTRY_RESTOCK_PACKAGE_COUNT_MAX
    ) {
      throw new PantryRestockValidationError("INVALID_PACKAGE_COUNT");
    }
    if (
      !US_RECIPE_MEASUREMENT_UNITS.includes(
        item.unit as UsRecipeMeasurementUnit,
      )
    ) {
      throw new PantryRestockValidationError("INVALID_UNIT");
    }
    if (
      item.quantity !== null &&
      (!Number.isFinite(item.quantity) ||
        item.quantity <= 0 ||
        item.quantity > PANTRY_QUANTITY_MAX)
    ) {
      throw new PantryRestockValidationError("INVALID_QUANTITY");
    }
  }
}

export type PantryRestockConversionInput = Readonly<{
  baseUnit: PantryBaseUnit;
  densityGramsPerMl?: number | null;
  gramsPerCount?: number | null;
  quantityInBaseUnit: number;
  unit: UsRecipeMeasurementUnit;
}>;

/** Converts a canonical pantry balance into a selected editable display unit. */
export function convertPantryBaseQuantityToUnit({
  baseUnit,
  densityGramsPerMl,
  gramsPerCount,
  quantityInBaseUnit,
  unit,
}: PantryRestockConversionInput): number {
  if (!Number.isFinite(quantityInBaseUnit) || quantityInBaseUnit < 0) {
    throw new RangeError("quantityInBaseUnit must be nonnegative and finite.");
  }
  const oneUnitInBase = convertToCanonical({
    canonicalUnit: baseUnit,
    densityGPerMl: densityGramsPerMl,
    gramsPerCount,
    quantity: 1,
    unit,
  }).quantity;
  const result = Number((quantityInBaseUnit / oneUnitInBase).toFixed(3));
  if (quantityInBaseUnit > 0 && result <= 0) {
    throw new RangeError("The quantity is too small to display accurately.");
  }
  return result;
}
