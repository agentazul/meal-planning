import { describe, expect, it } from "vitest";

import {
  buildGeneratedRecipeCatalog,
  GENERATED_RECIPE_ACTIVE_TIME_RANGES,
  generatedRecipeConstraintsSchema,
  generatedRecipeModelOutputSchema,
  GeneratedRecipeValidationError,
  getRequiredMinimumInternalTemperatureF,
  normalizeGeneratedRecipeDraft,
  type GeneratedRecipeCanonicalReference,
  type GeneratedRecipeCatalogEntry,
  type GeneratedRecipeConstraints,
  type GeneratedRecipeModelOutput,
  type GeneratedRecipeValidationErrorCode,
} from "./generated-recipe";
import { SUPPORTED_MEASUREMENT_UNITS } from "./units";

const CHICKEN_ID = "11111111-1111-4111-8111-111111111111";
const ONION_ID = "22222222-2222-4222-8222-222222222222";
const OIL_ID = "33333333-3333-4333-8333-333333333333";
const FLOUR_ID = "44444444-4444-4444-8444-444444444444";
const GROUND_CUMIN_ID = "55555555-5555-4555-8555-555555555555";
const GARLIC_ID = "66666666-6666-4666-8666-666666666666";

const references = [
  {
    baseUnit: "g",
    category: "protein",
    densityGramsPerMl: null,
    gramsPerCount: null,
    id: CHICKEN_ID,
    name: "chicken breast",
  },
  {
    baseUnit: "g",
    category: "produce",
    densityGramsPerMl: null,
    gramsPerCount: 150,
    id: ONION_ID,
    name: "yellow onion",
  },
  {
    baseUnit: "ml",
    category: "pantry",
    densityGramsPerMl: 0.91,
    gramsPerCount: null,
    id: OIL_ID,
    name: "olive oil",
  },
] as const satisfies readonly GeneratedRecipeCanonicalReference[];

const constraints: GeneratedRecipeConstraints = {
  maxActiveTimeMinutes: 30,
  requestedEffortTier: "weeknight",
  requestedServings: 5,
};

function catalogKey(
  catalog: readonly GeneratedRecipeCatalogEntry[],
  ingredientId: string,
): string {
  const entry = catalog.find((candidate) => candidate.id === ingredientId);
  if (!entry) throw new Error(`Missing test catalog entry ${ingredientId}`);
  return entry.catalogKey;
}

function validOutput(
  catalog: readonly GeneratedRecipeCatalogEntry[],
): GeneratedRecipeModelOutput {
  const chickenKey = catalogKey(catalog, CHICKEN_ID);
  const onionKey = catalogKey(catalog, ONION_ID);
  const oilKey = catalogKey(catalog, OIL_ID);

  return {
    activeTimeMinutes: 20,
    baseServings: 5,
    cuisine: " Mediterranean ",
    description: " A practical sheet pan dinner. ",
    effortTier: "weeknight",
    ingredients: [
      {
        catalogKey: chickenKey,
        isOptional: false,
        preparation: " trimmed ",
        quantity: 1,
        scalesLinearly: true,
        unit: "lb",
      },
      {
        catalogKey: onionKey,
        isOptional: false,
        preparation: " cut into wedges ",
        quantity: 1,
        scalesLinearly: true,
        unit: "count",
      },
      {
        catalogKey: oilKey,
        isOptional: false,
        preparation: null,
        quantity: 2,
        scalesLinearly: false,
        unit: "tbsp",
      },
    ],
    instructions: [
      { instruction: " Heat the oven to 425°F. " },
      { instruction: " Roast until the chicken reaches 165°F. " },
    ],
    minInternalTemperatureF: 165,
    primaryProteinCatalogKey: chickenKey,
    techniques: [" roasting ", "pan sauce", "roasting"],
    title: " Sheet pan chicken and onion ",
    totalTimeMinutes: 45,
  };
}

function expectValidationCode(
  run: () => unknown,
  code: GeneratedRecipeValidationErrorCode,
): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(GeneratedRecipeValidationError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected generated recipe validation error ${code}`);
}

describe("generatedRecipeModelOutputSchema", () => {
  it("accepts only the strict typed model shape", () => {
    const catalog = buildGeneratedRecipeCatalog(references);
    const output = validOutput(catalog);

    expect(generatedRecipeModelOutputSchema.safeParse(output).success).toBe(true);
    expect(
      generatedRecipeModelOutputSchema.safeParse({
        ...output,
        baseServings: "5",
      }).success,
    ).toBe(false);
    expect(
      generatedRecipeModelOutputSchema.safeParse({
        ...output,
        providerCommentary: "Looks delicious",
      }).success,
    ).toBe(false);
    expect(
      generatedRecipeModelOutputSchema.safeParse({
        ...output,
        ingredients: [
          { ...output.ingredients[0], quantity: 0.0004 },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects malformed catalog keys and forbidden generated dashes", () => {
    const catalog = buildGeneratedRecipeCatalog(references);
    const output = validOutput(catalog);

    expect(
      generatedRecipeModelOutputSchema.safeParse({
        ...output,
        ingredients: [
          { ...output.ingredients[0], catalogKey: "chicken-breast" },
        ],
      }).success,
    ).toBe(false);
    expect(
      generatedRecipeModelOutputSchema.safeParse({
        ...output,
        title: "Chicken \u2014 the easy way",
      }).success,
    ).toBe(false);
    expect(
      generatedRecipeModelOutputSchema.safeParse({
        ...output,
        instructions: [{ instruction: "Roast 20\u201325 minutes." }],
      }).success,
    ).toBe(false);
  });

  it("limits generated total time and cooking temperatures to sane ranges", () => {
    const catalog = buildGeneratedRecipeCatalog(references);
    const output = validOutput(catalog);

    expect(
      generatedRecipeModelOutputSchema.safeParse({
        ...output,
        totalTimeMinutes: 0,
      }).success,
    ).toBe(false);
    expect(
      generatedRecipeModelOutputSchema.safeParse({
        ...output,
        minInternalTemperatureF: 119,
      }).success,
    ).toBe(false);
    expect(
      generatedRecipeModelOutputSchema.safeParse({
        ...output,
        minInternalTemperatureF: 206,
      }).success,
    ).toBe(false);
  });
});

describe("generated recipe active-time constraints", () => {
  it("publishes the authoritative effort-tier ranges", () => {
    expect(GENERATED_RECIPE_ACTIVE_TIME_RANGES).toEqual({
      weeknight: { maximumMinutes: 45, minimumMinutes: 0 },
      weekend: { maximumMinutes: 120, minimumMinutes: 20 },
      project: { maximumMinutes: 240, minimumMinutes: 45 },
    });
  });

  it("rejects max ceilings outside the requested effort tier", () => {
    expect(
      generatedRecipeConstraintsSchema.safeParse({
        maxActiveTimeMinutes: 46,
        requestedEffortTier: "weeknight",
        requestedServings: 5,
      }).success,
    ).toBe(false);
    expect(
      generatedRecipeConstraintsSchema.safeParse({
        maxActiveTimeMinutes: 19,
        requestedEffortTier: "weekend",
        requestedServings: 5,
      }).success,
    ).toBe(false);
    expect(
      generatedRecipeConstraintsSchema.safeParse({
        maxActiveTimeMinutes: 121,
        requestedEffortTier: "weekend",
        requestedServings: 5,
      }).success,
    ).toBe(false);
    expect(
      generatedRecipeConstraintsSchema.safeParse({
        maxActiveTimeMinutes: 44,
        requestedEffortTier: "project",
        requestedServings: 5,
      }).success,
    ).toBe(false);
    expect(
      generatedRecipeConstraintsSchema.safeParse({
        maxActiveTimeMinutes: 240,
        requestedEffortTier: "project",
        requestedServings: 5,
      }).success,
    ).toBe(true);
  });
});

describe("buildGeneratedRecipeCatalog", () => {
  it("assigns deterministic short keys and authoritative temperature metadata", () => {
    const catalog = buildGeneratedRecipeCatalog(references);

    expect(
      catalog.map(({ catalogKey: key, name }) => ({ key, name })),
    ).toEqual([
      { key: "i001", name: "olive oil" },
      { key: "i002", name: "yellow onion" },
      { key: "i003", name: "chicken breast" },
    ]);
    expect(catalog.find((entry) => entry.id === CHICKEN_ID)).toMatchObject({
      requiredMinimumInternalTemperatureF: 165,
    });
  });

  it("rejects duplicate canonical IDs before assigning keys", () => {
    expectValidationCode(
      () => buildGeneratedRecipeCatalog([...references, references[0]]),
      "INVALID_CATALOG",
    );
  });

  it("distinguishes raw animal proteins from prepared references", () => {
    expect(getRequiredMinimumInternalTemperatureF("ground beef", "protein")).toBe(
      160,
    );
    expect(
      getRequiredMinimumInternalTemperatureF("pork tenderloin", "protein"),
    ).toBe(145);
    expect(
      getRequiredMinimumInternalTemperatureF("salmon fillet", "protein"),
    ).toBe(145);
    expect(
      getRequiredMinimumInternalTemperatureF("rotisserie chicken", "protein"),
    ).toBeNull();
    expect(
      getRequiredMinimumInternalTemperatureF("canned tuna", "protein"),
    ).toBeNull();
  });

  it("never treats ground spices as raw animal protein", () => {
    const catalog = buildGeneratedRecipeCatalog([
      ...references,
      {
        baseUnit: "g",
        category: "spice",
        densityGramsPerMl: null,
        gramsPerCount: null,
        id: GROUND_CUMIN_ID,
        name: "ground cumin",
      },
    ]);

    expect(catalog.find((entry) => entry.id === GROUND_CUMIN_ID)).toMatchObject({
      requiredMinimumInternalTemperatureF: null,
    });
  });
});

describe("normalizeGeneratedRecipeDraft", () => {
  it("resolves canonical references and derives persisted positions and base quantities", () => {
    const catalog = buildGeneratedRecipeCatalog(references);
    const normalized = normalizeGeneratedRecipeDraft(
      validOutput(catalog),
      catalog,
      constraints,
    );

    expect(normalized).toMatchObject({
      baseServings: 5,
      cuisine: "Mediterranean",
      description: "A practical sheet pan dinner.",
      effortTier: "weeknight",
      minInternalTemperatureF: 165,
      primaryProtein: "chicken breast",
      techniques: ["roasting", "pan sauce"],
      title: "Sheet pan chicken and onion",
    });
    expect(normalized.ingredients).toEqual([
      {
        canonicalIngredientId: CHICKEN_ID,
        isOptional: false,
        preparation: "trimmed",
        quantity: 1,
        quantityInBaseUnit: 453.592,
        scalesLinearly: true,
        unit: "lb",
      },
      {
        canonicalIngredientId: ONION_ID,
        isOptional: false,
        preparation: "cut into wedges",
        quantity: 1,
        quantityInBaseUnit: 150,
        scalesLinearly: true,
        unit: "count",
      },
      {
        canonicalIngredientId: OIL_ID,
        isOptional: false,
        preparation: null,
        quantity: 2,
        quantityInBaseUnit: 29.574,
        scalesLinearly: false,
        unit: "tbsp",
      },
    ]);
    expect(normalized.instructions).toEqual([
      { instruction: "Heat the oven to 425°F.", position: 1 },
      {
        instruction: "Roast until the chicken reaches 165°F.",
        position: 2,
      },
    ]);
  });

  it("enforces exact servings, effort, active-time, and time-range constraints", () => {
    const catalog = buildGeneratedRecipeCatalog(references);
    const output = validOutput(catalog);

    expectValidationCode(
      () =>
        normalizeGeneratedRecipeDraft(
          { ...output, baseServings: 4 },
          catalog,
          constraints,
        ),
      "SERVINGS_MISMATCH",
    );
    expectValidationCode(
      () =>
        normalizeGeneratedRecipeDraft(
          { ...output, effortTier: "weekend" },
          catalog,
          constraints,
        ),
      "EFFORT_MISMATCH",
    );
    expectValidationCode(
      () =>
        normalizeGeneratedRecipeDraft(
          { ...output, activeTimeMinutes: 31 },
          catalog,
          constraints,
        ),
      "ACTIVE_TIME_EXCEEDED",
    );
    expectValidationCode(
      () =>
        normalizeGeneratedRecipeDraft(
          { ...output, totalTimeMinutes: 10 },
          catalog,
          constraints,
        ),
      "INVALID_TIME_RANGE",
    );
  });

  it("rejects malformed ceilings and active time below the effort-tier minimum", () => {
    const catalog = buildGeneratedRecipeCatalog(references);
    const output = validOutput(catalog);

    expectValidationCode(
      () =>
        normalizeGeneratedRecipeDraft(output, catalog, {
          maxActiveTimeMinutes: 19,
          requestedEffortTier: "weekend",
          requestedServings: 5,
        }),
      "INVALID_CONSTRAINTS",
    );
    expectValidationCode(
      () =>
        normalizeGeneratedRecipeDraft(
          {
            ...output,
            activeTimeMinutes: 19,
            effortTier: "weekend",
          },
          catalog,
          {
            maxActiveTimeMinutes: 60,
            requestedEffortTier: "weekend",
            requestedServings: 5,
          },
        ),
      "ACTIVE_TIME_BELOW_MINIMUM",
    );

    expect(
      normalizeGeneratedRecipeDraft(
        { ...output, effortTier: "weekend" },
        catalog,
        {
          maxActiveTimeMinutes: 60,
          requestedEffortTier: "weekend",
          requestedServings: 5,
        },
      ).activeTimeMinutes,
    ).toBe(20);
  });

  it("rejects duplicate and unknown ingredient keys", () => {
    const catalog = buildGeneratedRecipeCatalog(references);
    const output = validOutput(catalog);

    expectValidationCode(
      () =>
        normalizeGeneratedRecipeDraft(
          {
            ...output,
            ingredients: [output.ingredients[0], output.ingredients[0]],
          },
          catalog,
          constraints,
        ),
      "DUPLICATE_INGREDIENT",
    );
    expectValidationCode(
      () =>
        normalizeGeneratedRecipeDraft(
          {
            ...output,
            ingredients: [
              { ...output.ingredients[0], catalogKey: "i999" },
            ],
            primaryProteinCatalogKey: null,
          },
          catalog,
          constraints,
        ),
      "UNKNOWN_CATALOG_KEY",
    );
  });

  it("requires the declared primary protein to appear in the ingredient list", () => {
    const catalog = buildGeneratedRecipeCatalog(references);
    const output = validOutput(catalog);

    expectValidationCode(
      () =>
        normalizeGeneratedRecipeDraft(
          {
            ...output,
            ingredients: [output.ingredients[2]],
            minInternalTemperatureF: null,
          },
          catalog,
          constraints,
        ),
      "PRIMARY_PROTEIN_NOT_INCLUDED",
    );
  });

  it("requires primary protein metadata to reference the protein category", () => {
    const catalog = buildGeneratedRecipeCatalog(references);
    const output = validOutput(catalog);
    const oilKey = catalogKey(catalog, OIL_ID);

    expectValidationCode(
      () =>
        normalizeGeneratedRecipeDraft(
          {
            ...output,
            primaryProteinCatalogKey: oilKey,
          },
          catalog,
          constraints,
        ),
      "PRIMARY_PROTEIN_NOT_PROTEIN",
    );
  });

  it("requires a sufficiently high temperature for raw animal protein", () => {
    const catalog = buildGeneratedRecipeCatalog(references);
    const output = validOutput(catalog);

    expectValidationCode(
      () =>
        normalizeGeneratedRecipeDraft(
          { ...output, minInternalTemperatureF: null },
          catalog,
          constraints,
        ),
      "MISSING_INTERNAL_TEMPERATURE",
    );
    expectValidationCode(
      () =>
        normalizeGeneratedRecipeDraft(
          { ...output, minInternalTemperatureF: 160 },
          catalog,
          constraints,
        ),
      "UNSAFE_INTERNAL_TEMPERATURE",
    );
  });

  it("rejects implausible garlic while allowing one bulb for five servings", () => {
    const garlicCatalog = buildGeneratedRecipeCatalog([
      {
        baseUnit: "g",
        category: "produce",
        densityGramsPerMl: null,
        gramsPerCount: 50,
        id: GARLIC_ID,
        name: "garlic",
      },
    ]);
    const garlicKey = garlicCatalog[0]?.catalogKey;
    if (!garlicKey) throw new Error("Missing garlic test catalog key");

    const garlicOutput: GeneratedRecipeModelOutput = {
      activeTimeMinutes: 10,
      baseServings: 5,
      cuisine: null,
      description: null,
      effortTier: "weeknight",
      ingredients: [
        {
          catalogKey: garlicKey,
          isOptional: false,
          preparation: "minced",
          quantity: 3,
          scalesLinearly: false,
          unit: "count",
        },
      ],
      instructions: [{ instruction: "Mince and cook the garlic." }],
      minInternalTemperatureF: null,
      primaryProteinCatalogKey: null,
      techniques: ["sauteing"],
      title: "Garlic test",
      totalTimeMinutes: 10,
    };

    expectValidationCode(
      () =>
        normalizeGeneratedRecipeDraft(
          garlicOutput,
          garlicCatalog,
          constraints,
        ),
      "IMPLAUSIBLE_INGREDIENT_QUANTITY",
    );

    const allowed = normalizeGeneratedRecipeDraft(
      {
        ...garlicOutput,
        ingredients: [{ ...garlicOutput.ingredients[0], quantity: 1 }],
      },
      garlicCatalog,
      constraints,
    );
    expect(allowed.ingredients[0]?.quantityInBaseUnit).toBe(50);
  });

  it("rejects conversions when canonical metadata is insufficient", () => {
    const flourCatalog = buildGeneratedRecipeCatalog([
      {
        baseUnit: "g",
        category: "pantry",
        densityGramsPerMl: null,
        gramsPerCount: null,
        id: FLOUR_ID,
        name: "all-purpose flour",
      },
    ]);
    const flourKey = flourCatalog[0]?.catalogKey;
    if (!flourKey) throw new Error("Missing flour test catalog key");

    const output: GeneratedRecipeModelOutput = {
      activeTimeMinutes: 10,
      baseServings: 5,
      cuisine: null,
      description: null,
      effortTier: "weeknight",
      ingredients: [
        {
          catalogKey: flourKey,
          isOptional: false,
          preparation: null,
          quantity: 1,
          scalesLinearly: true,
          unit: "cup",
        },
      ],
      instructions: [{ instruction: "Mix the flour." }],
      minInternalTemperatureF: null,
      primaryProteinCatalogKey: null,
      techniques: [],
      title: "Flour test",
      totalTimeMinutes: 10,
    };

    expectValidationCode(
      () => normalizeGeneratedRecipeDraft(output, flourCatalog, constraints),
      "INVALID_UNIT_CONVERSION",
    );
  });
});

describe("SUPPORTED_MEASUREMENT_UNITS", () => {
  it("provides one shared tuple for model, route, and conversion boundaries", () => {
    expect(SUPPORTED_MEASUREMENT_UNITS).toEqual([
      "mg",
      "g",
      "kg",
      "oz",
      "lb",
      "ml",
      "l",
      "tsp",
      "tbsp",
      "cup",
      "fl_oz",
      "count",
    ]);
  });
});
