import { describe, expect, it } from "vitest";

import {
  areWeeklyMealsTooSimilar,
  buildDefaultWeeklyGenerationSlots,
  buildWeeklyGenerationCatalog,
  chooseWeeklyGenerationSelection,
  createWeeklyGenerationRerollHistory,
  normalizeWeeklyCandidatePool,
  normalizeWeeklyGenerationDietaryNotes,
  rerollWeeklyGenerationSlot,
  selectedWeeklyCandidates,
  weeklyCandidateModelSchema,
  type WeeklyCandidateModel,
  type WeeklyGenerationCatalogEntry,
  type WeeklyGenerationSlot,
} from "./weekly-generation";

const UUIDS = Array.from(
  { length: 12 },
  (_, index) =>
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);

const catalog = buildWeeklyGenerationCatalog([
  reference(0, "chicken breast", "protein", false),
  reference(1, "ground beef", "protein", false),
  reference(2, "tofu", "protein", false),
  reference(3, "broccoli", "produce", false),
  reference(4, "garlic", "produce", false, 50),
  reference(5, "yellow onion", "produce", false, 150),
  reference(6, "bell pepper", "produce", false, 164),
  reference(7, "potato", "produce", false, 180),
  reference(8, "white rice", "pantry", false),
  reference(9, "canned tomato", "pantry", false),
  reference(10, "olive oil", "pantry", true),
  reference(11, "kosher salt", "spice", true),
]);

function reference(
  index: number,
  name: string,
  category: "pantry" | "produce" | "protein" | "spice",
  isStaple: boolean,
  gramsPerCount: number | null = null,
) {
  return {
    baseUnit: "g" as const,
    category,
    densityGramsPerMl: null,
    gramsPerCount,
    id: UUIDS[index]!,
    isStaple,
    name,
  };
}

function key(name: string): string {
  const entry = catalog.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`Missing catalog entry ${name}`);
  return entry.catalogKey;
}

const slots: readonly WeeklyGenerationSlot[] = [
  {
    date: "2026-08-09",
    effortTier: "weekend",
    maxActiveTimeMinutes: 90,
    servingsTarget: 5,
    slotKey: "d1",
  },
  ...["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13"].map(
    (date, index) => ({
      date,
      effortTier: "weeknight" as const,
      maxActiveTimeMinutes: 45,
      servingsTarget: index === 3 ? 4 : 5,
      slotKey: `d${index + 2}`,
    }),
  ),
];

function candidate(
  slot: WeeklyGenerationSlot,
  lane: number,
  overrides: Partial<WeeklyCandidateModel> = {},
): WeeklyCandidateModel {
  const proteinNames = ["chicken breast", "ground beef", "tofu"] as const;
  const proteinName = proteinNames[lane] ?? "tofu";
  const safetyTemperature =
    proteinName === "chicken breast"
      ? 165
      : proteinName === "ground beef"
        ? 160
        : null;
  return {
    activeTimeMinutes: slot.effortTier === "weekend" ? 30 : 25,
    baseServings: slot.servingsTarget,
    cuisine: ["American", "Mexican", "Asian"][lane] ?? "American",
    effortTier: slot.effortTier,
    ingredients: [
      {
        catalogKey: key(proteinName),
        isOptional: false,
        preparation: "cut into pieces",
        quantity: 700,
        scalesLinearly: true,
        unit: "g",
      },
      {
        catalogKey: key("white rice"),
        isOptional: false,
        preparation: null,
        quantity: 350,
        scalesLinearly: true,
        unit: "g",
      },
      {
        catalogKey: key("yellow onion"),
        isOptional: false,
        preparation: "diced",
        quantity: 150,
        scalesLinearly: true,
        unit: "g",
      },
      {
        catalogKey: key("olive oil"),
        isOptional: false,
        preparation: null,
        quantity: 20,
        scalesLinearly: false,
        unit: "g",
      },
    ],
    minInternalTemperatureF: safetyTemperature,
    primaryProteinCatalogKey: key(proteinName),
    slotDate: slot.date,
    techniques: [["roasting"], ["sauteing"], ["simmering"]][lane]!,
    title: `${proteinName} dinner ${slot.slotKey} lane ${lane + 1}`,
    totalTimeMinutes: slot.effortTier === "weekend" ? 55 : 40,
    ...overrides,
  };
}

function candidatePool(): WeeklyCandidateModel[] {
  return [0, 1, 2].flatMap((lane) =>
    slots.map((slot) => candidate(slot, lane)),
  );
}

describe("weekly generation contracts", () => {
  it("normalizes anonymous dietary notes without member identity data", () => {
    expect(
      normalizeWeeklyGenerationDietaryNotes([
        "  No shellfish.\r\n",
        "Avoid peanuts.",
        "   ",
      ]),
    ).toEqual(["Avoid peanuts.", "No shellfish."]);
  });

  it("treats a changed side or topping as the same core dinner", () => {
    expect(
      areWeeklyMealsTooSimilar(
        {
          cuisine: "Mexican",
          primaryProtein: "ground beef",
          title: "Ground Beef Tacos with Cheddar and Salsa",
        },
        {
          cuisine: "Mexican",
          primaryProtein: "ground beef",
          title: "Ground Beef Tacos with Spanish Rice",
        },
      ),
    ).toBe(true);
    expect(
      areWeeklyMealsTooSimilar(
        {
          cuisine: "Mexican",
          primaryProtein: "ground beef",
          title: "Ground Beef Tacos and Cheddar Salsa",
        },
        {
          cuisine: "Mexican",
          primaryProtein: "ground beef",
          title: "Ground Beef Tacos - Spanish Rice",
        },
      ),
    ).toBe(true);
    expect(
      areWeeklyMealsTooSimilar(
        {
          cuisine: "Italian",
          primaryProtein: "chicken breast",
          title: "Chicken Alfredo",
        },
        {
          cuisine: "Italian",
          primaryProtein: "chicken breast",
          title: "Chicken Parmesan",
        },
      ),
    ).toBe(false);
    expect(
      areWeeklyMealsTooSimilar(
        {
          cuisine: "Fusion",
          primaryProtein: null,
          title: "Caf\u00e9 Tacos",
        },
        {
          cuisine: "Fusion",
          primaryProtein: null,
          title: "Cafe\u0301 Tacos",
        },
      ),
    ).toBe(true);
  });

  it("derives five highest-demand nights without asking for a meal brief", () => {
    const result = buildDefaultWeeklyGenerationSlots([
      { date: "2026-08-09", demand: 5, servingsTarget: 5 },
      { date: "2026-08-10", demand: 4, servingsTarget: 4 },
      { date: "2026-08-11", demand: 3, servingsTarget: 3 },
      { date: "2026-08-12", demand: 2, servingsTarget: 2 },
      { date: "2026-08-13", demand: 1, servingsTarget: 1 },
      { date: "2026-08-14", demand: 0.5, servingsTarget: 1 },
      { date: "2026-08-15", demand: 0, servingsTarget: 0 },
    ]);

    expect(result.map((slot) => slot.date)).toEqual([
      "2026-08-09",
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
    ]);
    expect(result[0]).toMatchObject({
      effortTier: "weekend",
      maxActiveTimeMinutes: 90,
    });
    expect(result[1]).toMatchObject({
      effortTier: "weeknight",
      maxActiveTimeMinutes: 45,
    });
  });

  it("strictly rejects instructions during pass one", () => {
    expect(
      weeklyCandidateModelSchema.safeParse({
        ...candidate(slots[0]!, 0),
        instructions: [{ instruction: "This must not exist in pass one." }],
      }).success,
    ).toBe(false);
  });

  it("normalizes exactly three candidates per slot with canonical quantities", () => {
    const normalized = normalizeWeeklyCandidatePool({
      candidates: candidatePool(),
      catalog,
      slots,
    });

    expect(normalized).toHaveLength(15);
    expect(normalized[0]).toMatchObject({
      candidateKey: "c001",
      primaryProtein: "chicken breast",
    });
    expect(
      normalized.filter((item) => item.slotDate === slots[0]!.date),
    ).toHaveLength(3);
  });

  it("rejects candidates with the wrong yield or an unknown canonical key", () => {
    const wrongYield = candidatePool();
    wrongYield[0] = { ...wrongYield[0]!, baseServings: 2 };
    expect(() =>
      normalizeWeeklyCandidatePool({ candidates: wrongYield, catalog, slots }),
    ).toThrow(/yield must be exactly/i);

    const unknownKey = candidatePool();
    unknownKey[0] = {
      ...unknownKey[0]!,
      ingredients: [
        { ...unknownKey[0]!.ingredients[0]!, catalogKey: "i999" },
        ...unknownKey[0]!.ingredients.slice(1),
      ],
    };
    expect(() =>
      normalizeWeeklyCandidatePool({ candidates: unknownKey, catalog, slots }),
    ).toThrow(/not canonical/i);
  });

  it("chooses a deterministic varied slate with ingredient overlap", () => {
    const normalized = normalizeWeeklyCandidatePool({
      candidates: candidatePool(),
      catalog,
      slots,
    });
    const first = chooseWeeklyGenerationSelection(normalized, slots);
    const second = chooseWeeklyGenerationSelection(normalized, slots);

    expect(second).toEqual(first);
    expect(first.items).toHaveLength(5);
    expect(first.score.proteinVariety).toBe(3);
    expect(first.score.sharedIngredientNames).toContain("white rice");
  });

  it("chooses a slate without very similar dinners when alternatives exist", () => {
    const titles = [
      "Chicken Tacos with Cheddar and Salsa",
      "Chicken Tacos with Spanish Rice",
      "Cacciatore",
      "Piccata",
      "Souvlaki",
      "Meatloaf",
      "Chili",
      "Fajitas",
      "Goulash",
      "Burgers",
      "Teriyaki",
      "Satay",
      "Katsu",
      "Adobo",
      "Shawarma",
    ];
    const pool = candidatePool().map((item, index) => ({
      ...item,
      title: titles[index]!,
    }));
    const normalized = normalizeWeeklyCandidatePool({
      candidates: pool,
      catalog,
      slots,
    });
    const selected = selectedWeeklyCandidates({
      candidates: normalized,
      selection: chooseWeeklyGenerationSelection(normalized, slots),
    });

    expect(
      selected.every((candidate, index) =>
        selected
          .slice(index + 1)
          .every((other) => !areWeeklyMealsTooSimilar(candidate, other)),
      ),
    ).toBe(true);
  });

  it("rerolls through unused slot candidates and then reports exhaustion", () => {
    const normalized = normalizeWeeklyCandidatePool({
      candidates: candidatePool(),
      catalog,
      slots,
    });
    const selection = chooseWeeklyGenerationSelection(normalized, slots);
    const history = createWeeklyGenerationRerollHistory(selection);
    const slotDate = slots[0]!.date;
    const first = rerollWeeklyGenerationSlot({
      candidates: normalized,
      history,
      selection,
      slotDate,
    });
    expect(first).not.toBeNull();
    const second = rerollWeeklyGenerationSlot({
      candidates: normalized,
      history: first!.history,
      selection: first!.selection,
      slotDate,
    });
    expect(second).not.toBeNull();
    expect(
      rerollWeeklyGenerationSlot({
        candidates: normalized,
        history: second!.history,
        selection: second!.selection,
        slotDate,
      }),
    ).toBeNull();
  });
});
