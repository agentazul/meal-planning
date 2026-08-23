import type { IngredientCategory } from "../data/ingredients";
import type { PantryCoverage } from "./pantry";

export const PANTRY_SHOPPING_CATEGORY_METADATA = [
  { category: "produce", label: "Produce" },
  { category: "protein", label: "Proteins" },
  { category: "dairy", label: "Dairy & Refrigerated" },
  { category: "bakery", label: "Bakery & Bread" },
  { category: "frozen", label: "Frozen" },
  { category: "pantry", label: "Dry Goods & Pantry" },
  { category: "spice", label: "Seasonings & Spices" },
  { category: "other", label: "Other" },
] as const satisfies readonly Readonly<{
  category: IngredientCategory;
  label: string;
}>[];

export function groupPantryShoppingItemsByCategory<T>(
  items: readonly T[],
  getCategory: (item: T) => IngredientCategory,
) {
  return PANTRY_SHOPPING_CATEGORY_METADATA.flatMap(({ category, label }) => {
    const categoryItems = items.filter(
      (item) => getCategory(item) === category,
    );
    return categoryItems.length > 0
      ? [{ category, label, items: categoryItems }]
      : [];
  });
}

export type PantryShoppingListExportItem = Readonly<{
  category: IngredientCategory;
  coverage: PantryCoverage;
  defaultPurchaseDescription: string | null;
  name: string;
  optionalOnly: boolean;
  packageCount: number;
}>;

const PACKAGE_RATIO_TOLERANCE = 1e-9;

/** Returns the number of whole default packages needed to cover an amount. */
export function calculatePantryPackageCount(
  neededQuantityInBaseUnit: number,
  defaultPurchaseQuantityInBaseUnit: number | null,
): number {
  if (
    !Number.isFinite(neededQuantityInBaseUnit) ||
    neededQuantityInBaseUnit <= 0
  ) {
    throw new RangeError(
      "neededQuantityInBaseUnit must be positive and finite.",
    );
  }
  if (defaultPurchaseQuantityInBaseUnit === null) return 1;
  if (
    !Number.isFinite(defaultPurchaseQuantityInBaseUnit) ||
    defaultPurchaseQuantityInBaseUnit <= 0
  ) {
    throw new RangeError(
      "defaultPurchaseQuantityInBaseUnit must be positive and finite.",
    );
  }

  return Math.max(
    1,
    Math.ceil(
      neededQuantityInBaseUnit / defaultPurchaseQuantityInBaseUnit -
        PACKAGE_RATIO_TOLERANCE,
    ),
  );
}

export function formatPantryPackageRecommendation(
  description: string | null,
  packageCount: number,
): string | null {
  if (!Number.isInteger(packageCount) || packageCount < 1) {
    throw new RangeError("packageCount must be a positive integer.");
  }
  if (description === null) return null;
  return packageCount === 1 ? description : `${packageCount} × ${description}`;
}

function displayIngredientName(name: string): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

function checklistLine(item: PantryShoppingListExportItem): string {
  const name = displayIngredientName(item.name);
  const packageRecommendation = formatPantryPackageRecommendation(
    item.defaultPurchaseDescription,
    item.packageCount,
  );
  return packageRecommendation ? `${name}: ${packageRecommendation}` : name;
}

/**
 * Creates a category-divider row followed by one plain-text row per shopping
 * task. Apple's Shortcuts app turns every row, including category dividers,
 * into a native Notes checklist item with a tappable circle.
 */
export function buildPantryShoppingChecklistInput(
  items: readonly PantryShoppingListExportItem[],
): string {
  const actionableItems = items.filter((item) => item.coverage !== "enough");
  const groups = groupPantryShoppingItemsByCategory(
    actionableItems,
    (item) => item.category,
  );

  return groups
    .flatMap(({ label, items: categoryItems }) => {
      const buyItems = categoryItems.filter(
        (item) => !item.optionalOnly && item.coverage === "short",
      );
      const checkFirstItems = categoryItems.filter(
        (item) => !item.optionalOnly && item.coverage === "uncounted",
      );
      const optionalItems = categoryItems.filter((item) => item.optionalOnly);

      return [
        label.toUpperCase(),
        ...buyItems.map(checklistLine),
        ...checkFirstItems.map(checklistLine),
        ...optionalItems.map(checklistLine),
      ];
    })
    .join("\n");
}

export const APPLE_NOTES_SHORTCUT_NAME = "Done For You Kitchen Shopping List";

export function buildAppleNotesShortcutUrl(): string {
  return `shortcuts://run-shortcut?name=${encodeURIComponent(APPLE_NOTES_SHORTCUT_NAME)}`;
}

export type AppleNotesShortcutLaunchDependencies = Readonly<{
  copyText: (text: string) => Promise<void>;
  openUrl: (url: string) => void;
}>;

/**
 * Copies the complete list before opening Shortcuts. The installed Shortcut
 * uses its no-input fallback to read the clipboard, keeping longer weeks out
 * of the custom URL entirely.
 */
export async function launchAppleNotesShortcut(
  checklistInput: string,
  { copyText, openUrl }: AppleNotesShortcutLaunchDependencies,
): Promise<void> {
  if (!checklistInput.trim()) {
    throw new Error("Cannot create an Apple Notes checklist without rows.");
  }

  await copyText(checklistInput);
  openUrl(buildAppleNotesShortcutUrl());
}
