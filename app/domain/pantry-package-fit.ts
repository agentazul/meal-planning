import type { IngredientCategory } from "../data/ingredients";
import type {
  PantryRequirementContribution,
  PantryRequirementRow,
} from "./pantry";
import { calculatePantryPackageCount } from "./pantry-shopping-list";

const RATIO_TOLERANCE = 0.001;
const QUANTITY_TOLERANCE = 0.001;
const MIN_REDUCED_PACKAGE_COVERAGE_RATIO = 2 / 3;
const MIN_UNUSED_FINAL_PACKAGE_RATIO = 1 / 2;

export type PantryPackageFitReviewReason =
  "one-fewer-package-nearly-covers" | "oversized-single-package";

export type PantryRecipeQuantityRisk =
  "fractional-count" | "nonlinear" | "protein" | "repeated-recipe-line-use";

export type PantryAlternateStoreAmount = Readonly<{
  label: string;
  quantity: number;
  quantityInBaseUnit: number;
  unit: string;
}>;

export type PantryRecipeQuantitySuggestion = Readonly<{
  affectedContributions: readonly PantryRequirementContribution[];
  recipeId: string;
  recipeIngredientId: string;
  recipeTitle: string;
  riskFlags: readonly PantryRecipeQuantityRisk[];
  storedQuantity: number;
  storedQuantityInBaseUnit: number;
  storedUnit: string;
  suggestedQuantity: number;
  suggestedQuantityInBaseUnit: number;
}>;

export type PantryPackageFitAnalysis = Readonly<{
  coveringAlternateStoreAmounts: readonly PantryAlternateStoreAmount[];
  neededQuantityInBaseUnit: number;
  oneFewerPackageCoverageRatio: number;
  packageCount: number;
  packageQuantityInBaseUnit: number;
  reason: PantryPackageFitReviewReason;
  recipeQuantitySuggestions: readonly PantryRecipeQuantitySuggestion[];
  reducedPurchaseQuantityInBaseUnit: number;
  requiredQuantityInBaseUnit: number;
  unusedFinalPackageQuantityInBaseUnit: number;
  unusedFinalPackageRatio: number;
}>;

export type AnalyzePantryPackageFitInput = Readonly<{
  alternateStoreAmounts?: readonly PantryAlternateStoreAmount[];
  ingredientCategory: IngredientCategory;
  packageQuantityInBaseUnit: number;
  requirement: PantryRequirementRow;
}>;

function roundQuantity(value: number): number {
  return Number(value.toFixed(3));
}

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be positive and finite.`);
  }
}

function atLeastWithTolerance(value: number, threshold: number): boolean {
  return value + RATIO_TOLERANCE >= threshold;
}

function contributionScale(
  contribution: PantryRequirementContribution,
): number {
  return contribution.scalesLinearly
    ? contribution.servingsTarget / contribution.baseServings
    : 1;
}

function recipeQuantitySuggestions(
  contributions: readonly PantryRequirementContribution[],
  reductionNeededInBaseUnit: number,
  ingredientCategory: IngredientCategory,
): readonly PantryRecipeQuantitySuggestion[] {
  const requiredContributions = contributions.filter(
    (contribution) => !contribution.isOptional,
  );
  const byRecipeLine = new Map<string, PantryRequirementContribution[]>();

  for (const contribution of requiredContributions) {
    const existing = byRecipeLine.get(contribution.recipeIngredientId);
    if (existing) existing.push(contribution);
    else byRecipeLine.set(contribution.recipeIngredientId, [contribution]);
  }

  return [...byRecipeLine.values()].flatMap((lineContributions) => {
    const first = lineContributions[0]!;
    const sameStoredQuantity = lineContributions.every(
      (contribution) =>
        Math.abs(
          contribution.storedQuantityInBaseUnit -
            first.storedQuantityInBaseUnit,
        ) <= QUANTITY_TOLERANCE &&
        Math.abs(contribution.storedQuantity - first.storedQuantity) <=
          QUANTITY_TOLERANCE &&
        contribution.storedUnit === first.storedUnit &&
        contribution.recipeId === first.recipeId,
    );
    if (!sameStoredQuantity) return [];

    const combinedScale = lineContributions.reduce(
      (sum, contribution) => sum + contributionScale(contribution),
      0,
    );
    if (!Number.isFinite(combinedScale) || combinedScale <= 0) return [];

    const suggestedQuantityInBaseUnit =
      first.storedQuantityInBaseUnit -
      reductionNeededInBaseUnit / combinedScale;
    if (suggestedQuantityInBaseUnit <= QUANTITY_TOLERANCE) return [];

    const suggestedQuantity =
      first.storedQuantity *
      (suggestedQuantityInBaseUnit / first.storedQuantityInBaseUnit);
    const riskFlags: PantryRecipeQuantityRisk[] = [];
    if (ingredientCategory === "protein") riskFlags.push("protein");
    if (lineContributions.some((item) => !item.scalesLinearly)) {
      riskFlags.push("nonlinear");
    }
    if (
      first.storedUnit === "count" &&
      Math.abs(suggestedQuantity - Math.round(suggestedQuantity)) >
        QUANTITY_TOLERANCE
    ) {
      riskFlags.push("fractional-count");
    }
    if (lineContributions.length > 1) {
      riskFlags.push("repeated-recipe-line-use");
    }

    return [
      {
        affectedContributions: lineContributions,
        recipeId: first.recipeId,
        recipeIngredientId: first.recipeIngredientId,
        recipeTitle: first.recipeTitle,
        riskFlags,
        storedQuantity: first.storedQuantity,
        storedQuantityInBaseUnit: first.storedQuantityInBaseUnit,
        storedUnit: first.storedUnit,
        suggestedQuantity: roundQuantity(suggestedQuantity),
        suggestedQuantityInBaseUnit: roundQuantity(suggestedQuantityInBaseUnit),
      },
    ];
  });
}

/**
 * Finds package mismatches worth reviewing before the shopping list is final.
 * It is intentionally read-only: recipe changes remain an explicit user choice.
 */
export function analyzePantryPackageFit(
  input: AnalyzePantryPackageFitInput,
): PantryPackageFitAnalysis | null {
  const { requirement } = input;
  assertFinitePositive(
    input.packageQuantityInBaseUnit,
    "packageQuantityInBaseUnit",
  );

  if (
    requirement.optionalOnly ||
    requirement.coverage !== "short" ||
    requirement.currentQuantityInBaseUnit === null ||
    requirement.shortageQuantityInBaseUnit <= 0
  ) {
    return null;
  }

  const needed = requirement.shortageQuantityInBaseUnit;
  const packageCount = calculatePantryPackageCount(
    needed,
    input.packageQuantityInBaseUnit,
  );
  const reducedPurchaseQuantityInBaseUnit =
    (packageCount - 1) * input.packageQuantityInBaseUnit;
  const oneFewerPackageCoverageRatio = Math.min(
    1,
    (requirement.currentQuantityInBaseUnit +
      reducedPurchaseQuantityInBaseUnit) /
      requirement.requiredQuantityInBaseUnit,
  );
  const unusedFinalPackageQuantityInBaseUnit = Math.max(
    packageCount * input.packageQuantityInBaseUnit - needed,
    0,
  );
  const unusedFinalPackageRatio =
    unusedFinalPackageQuantityInBaseUnit / input.packageQuantityInBaseUnit;
  const finalPackageMostlyUnused = atLeastWithTolerance(
    unusedFinalPackageRatio,
    MIN_UNUSED_FINAL_PACKAGE_RATIO,
  );

  let reason: PantryPackageFitReviewReason | null = null;
  if (
    packageCount > 1 &&
    finalPackageMostlyUnused &&
    atLeastWithTolerance(
      oneFewerPackageCoverageRatio,
      MIN_REDUCED_PACKAGE_COVERAGE_RATIO,
    )
  ) {
    reason = "one-fewer-package-nearly-covers";
  } else if (packageCount === 1 && finalPackageMostlyUnused) {
    reason = "oversized-single-package";
  }
  if (reason === null) return null;

  const recipeTargetQuantityInBaseUnit =
    requirement.currentQuantityInBaseUnit + reducedPurchaseQuantityInBaseUnit;
  const reductionNeededInBaseUnit = Math.max(
    requirement.requiredQuantityInBaseUnit - recipeTargetQuantityInBaseUnit,
    0,
  );
  const coveringAlternateStoreAmounts = (
    input.alternateStoreAmounts ?? []
  ).filter((amount) => {
    assertFinitePositive(amount.quantity, "alternate store quantity");
    assertFinitePositive(
      amount.quantityInBaseUnit,
      "alternate store base quantity",
    );
    return (
      requirement.currentQuantityInBaseUnit! +
        amount.quantityInBaseUnit +
        QUANTITY_TOLERANCE >=
      requirement.requiredQuantityInBaseUnit
    );
  });

  return {
    coveringAlternateStoreAmounts,
    neededQuantityInBaseUnit: needed,
    oneFewerPackageCoverageRatio,
    packageCount,
    packageQuantityInBaseUnit: input.packageQuantityInBaseUnit,
    reason,
    recipeQuantitySuggestions: recipeQuantitySuggestions(
      requirement.contributions,
      reductionNeededInBaseUnit,
      input.ingredientCategory,
    ),
    reducedPurchaseQuantityInBaseUnit,
    requiredQuantityInBaseUnit: requirement.requiredQuantityInBaseUnit,
    unusedFinalPackageQuantityInBaseUnit,
    unusedFinalPackageRatio,
  };
}
