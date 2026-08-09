import { describe, expect, it } from "vitest";

import {
  INGREDIENT_CATEGORIES,
  INGREDIENT_CATEGORY_QUOTAS,
  INGREDIENT_MANIFEST_SIZE,
  canonicalIngredientManifestSchema,
  canonicalIngredients,
  normalizeIngredientLookup,
  type CanonicalIngredient,
  type IngredientCategory,
} from "./ingredients";

function mutableManifest(): CanonicalIngredient[] {
  return structuredClone(canonicalIngredients) as CanonicalIngredient[];
}

describe("canonical ingredient manifest", () => {
  it("contains exactly 300 schema-valid ingredients", () => {
    expect(canonicalIngredients).toHaveLength(INGREDIENT_MANIFEST_SIZE);
    expect(canonicalIngredientManifestSchema.safeParse(canonicalIngredients).success).toBe(true);
  });

  it("meets every category quota exactly", () => {
    const counts = Object.fromEntries(
      INGREDIENT_CATEGORIES.map((category) => [category, 0]),
    ) as Record<IngredientCategory, number>;

    for (const ingredient of canonicalIngredients) {
      counts[ingredient.category] += 1;
    }

    expect(counts).toEqual(INGREDIENT_CATEGORY_QUOTAS);
  });

  it("has unique slugs and normalized lookup values", () => {
    const slugs = canonicalIngredients.map((ingredient) => ingredient.slug);
    const lookupValues = canonicalIngredients.flatMap((ingredient) => [
      ingredient.name,
      ...ingredient.aliases,
    ]);
    const normalizedLookupValues = lookupValues.map(normalizeIngredientLookup);

    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(normalizedLookupValues).size).toBe(normalizedLookupValues.length);
  });

  it("provides one or more positive purchase formats with exactly one default", () => {
    for (const ingredient of canonicalIngredients) {
      expect(ingredient.formats.length).toBeGreaterThan(0);
      expect(ingredient.formats.filter((purchaseFormat) => purchaseFormat.isDefault)).toHaveLength(
        1,
      );

      const keys = ingredient.formats.map((purchaseFormat) => purchaseFormat.key);
      expect(new Set(keys).size).toBe(keys.length);

      for (const purchaseFormat of ingredient.formats) {
        expect(Number(purchaseFormat.quantityInBaseUnit)).toBeGreaterThan(0);
        expect(Number.isInteger(purchaseFormat.typicalPriceCents)).toBe(true);
        expect(purchaseFormat.typicalPriceCents).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("uses US customary labels for every household-facing purchase format", () => {
    const metricLabelPattern =
      /(?:^|\s)(?:mg|g|kg|ml|milligrams?|grams?|kilograms?|milliliters?|liters?)(?=$|\s)/iu;

    for (const ingredient of canonicalIngredients) {
      for (const purchaseFormat of ingredient.formats) {
        expect(purchaseFormat.description).not.toMatch(metricLabelPattern);
      }
    }
  });

  it("stores every survival probability as a decimal string from zero through one", () => {
    for (const ingredient of canonicalIngredients) {
      expect(ingredient.survivalProbability).toMatch(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
      expect(Number(ingredient.survivalProbability)).toBeGreaterThanOrEqual(0);
      expect(Number(ingredient.survivalProbability)).toBeLessThanOrEqual(1);
    }
  });

  it("permits null conversion metadata and rejects nonpositive conversion values", () => {
    expect(canonicalIngredients.some((ingredient) => ingredient.densityGPerMl === null)).toBe(true);
    expect(canonicalIngredients.some((ingredient) => ingredient.gramsPerCount === null)).toBe(true);

    const manifest = mutableManifest();
    manifest[0].densityGPerMl = "0";
    manifest[1].gramsPerCount = "-1";

    expect(canonicalIngredientManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("rejects a manifest with the wrong category quota", () => {
    const manifest = mutableManifest();
    manifest[0].category = "protein";

    expect(canonicalIngredientManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("rejects duplicate slugs, names, aliases, and alias-to-name collisions", () => {
    const duplicateSlug = mutableManifest();
    duplicateSlug[1].slug = duplicateSlug[0].slug;

    const duplicateName = mutableManifest();
    duplicateName[1].name = duplicateName[0].name;

    const duplicateAlias = mutableManifest();
    duplicateAlias[1].aliases.push(duplicateAlias[0].aliases[0] ?? "plain flour");
    duplicateAlias[2].aliases.push(duplicateAlias[0].aliases[0] ?? "plain flour");

    const aliasToName = mutableManifest();
    aliasToName[0].aliases.push(`  ${aliasToName[1].name.toUpperCase()}!! `);

    expect(canonicalIngredientManifestSchema.safeParse(duplicateSlug).success).toBe(false);
    expect(canonicalIngredientManifestSchema.safeParse(duplicateName).success).toBe(false);
    expect(canonicalIngredientManifestSchema.safeParse(duplicateAlias).success).toBe(false);
    expect(canonicalIngredientManifestSchema.safeParse(aliasToName).success).toBe(false);
  });

  it("rejects missing, duplicate, and multiply-defaulted purchase formats", () => {
    const missingFormat = mutableManifest();
    missingFormat[0].formats = [];

    const duplicateKey = mutableManifest();
    duplicateKey[0].formats.push({ ...duplicateKey[0].formats[0], isDefault: false });

    const multipleDefaults = mutableManifest();
    multipleDefaults[0].formats.push({
      ...multipleDefaults[0].formats[0],
      key: "second-format",
      isDefault: true,
    });

    expect(canonicalIngredientManifestSchema.safeParse(missingFormat).success).toBe(false);
    expect(canonicalIngredientManifestSchema.safeParse(duplicateKey).success).toBe(false);
    expect(canonicalIngredientManifestSchema.safeParse(multipleDefaults).success).toBe(false);
  });

  it("rejects invalid quantities, prices, probabilities, and shelf lives", () => {
    const invalidQuantity = mutableManifest();
    invalidQuantity[0].formats[0].quantityInBaseUnit = "0";

    const invalidPrice = mutableManifest();
    invalidPrice[0].formats[0].typicalPriceCents = 1.5;

    const invalidProbability = mutableManifest();
    invalidProbability[0].survivalProbability = "1.01";

    const invalidShelfLife = mutableManifest();
    invalidShelfLife[0].openedShelfDays = 0;

    expect(canonicalIngredientManifestSchema.safeParse(invalidQuantity).success).toBe(false);
    expect(canonicalIngredientManifestSchema.safeParse(invalidPrice).success).toBe(false);
    expect(canonicalIngredientManifestSchema.safeParse(invalidProbability).success).toBe(false);
    expect(canonicalIngredientManifestSchema.safeParse(invalidShelfLife).success).toBe(false);
  });
});
