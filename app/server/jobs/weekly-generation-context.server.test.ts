import { describe, expect, it } from "vitest";

import { canonicalIngredients } from "~/data/ingredients";
import type { WeeklyGenerationRun } from "~/server/data/weekly-generation.server";
import {
  fingerprintKitchenPreferences,
  fingerprintWeeklyGenerationCatalog,
  fingerprintWeeklyGenerationDietaryNotes,
  fingerprintWeeklyGenerationPantryBalances,
} from "~/server/data/weekly-generation.server";
import {
  createWeeklyGenerationCatalog,
  weeklyGenerationInputChanges,
  weeklyGenerationInputsMatch,
} from "./weekly-generation-context.server";

const pantryBalances = [
  {
    canonicalIngredientId: "00000000-0000-4000-8000-000000000001",
    quantityInBaseUnit: 500,
  },
] as const;

const slots = [
  {
    date: "2026-08-30",
    effortTier: "weekend" as const,
    maxActiveTimeMinutes: 90,
    servingsTarget: 4,
    slotKey: "d1",
  },
  ...["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03"].map(
    (date, index) => ({
      date,
      effortTier: "weeknight" as const,
      maxActiveTimeMinutes: 45,
      servingsTarget: 4,
      slotKey: `d${index + 2}`,
    }),
  ),
] as WeeklyGenerationRun["slots"];

const input = {
  catalog: [],
  dietaryNotes: ["No shellfish."],
  pantryBalances,
  preferenceMarkdown: "# Preferences\n\n- Mild dinners",
  slots,
};

function run(
  pantryFingerprint: string | null = fingerprintWeeklyGenerationPantryBalances(
    pantryBalances,
  ),
): WeeklyGenerationRun {
  return {
    catalogFingerprint: fingerprintWeeklyGenerationCatalog(input.catalog),
    dietaryNotesFingerprint: fingerprintWeeklyGenerationDietaryNotes(
      input.dietaryNotes,
    ),
    pantryFingerprint,
    preferenceFingerprint: fingerprintKitchenPreferences(
      input.preferenceMarkdown,
    ),
    slots,
  } as WeeklyGenerationRun;
}

describe("weeklyGenerationInputsMatch", () => {
  it("matches an unchanged pantry-aware generation snapshot", () => {
    expect(weeklyGenerationInputsMatch(run(), input)).toBe(true);
  });

  it("rejects a semantic pantry quantity change", () => {
    expect(
      weeklyGenerationInputsMatch(run(), {
        ...input,
        pantryBalances: [{ ...pantryBalances[0], quantityInBaseUnit: 499 }],
      }),
    ).toBe(false);
  });

  it("rejects legacy runs that have no pantry snapshot", () => {
    expect(weeklyGenerationInputsMatch(run(null), input)).toBe(false);
  });
});

describe("weeklyGenerationInputChanges", () => {
  it("reports nothing for an unchanged snapshot", () => {
    expect(weeklyGenerationInputChanges(run(), input)).toEqual([]);
  });

  it("names every input that changed after the draft was built", () => {
    expect(
      weeklyGenerationInputChanges(run(), {
        catalog: createWeeklyGenerationCatalog(
          [
            {
              aliases: [],
              baseUnit: "g",
              category: "protein",
              densityGramsPerMl: null,
              gramsPerCount: null,
              id: "00000000-0000-4000-8000-000000000001",
              isStaple: false,
              name: "chicken breast",
              pluralName: "chicken breasts",
            },
          ],
          input.preferenceMarkdown,
        ),
        dietaryNotes: ["No shellfish.", "No peanuts."],
        pantryBalances: [],
        preferenceMarkdown: "# Preferences\n\n## Never use\n\n- Pork",
        slots: slots.slice(1),
      }),
    ).toEqual(["preferences", "catalog", "dietaryNotes", "pantry", "slots"]);
  });

  it("reports a single changed input on its own", () => {
    expect(
      weeklyGenerationInputChanges(run(), {
        ...input,
        preferenceMarkdown: "# Preferences\n\n- Spicy dinners",
      }),
    ).toEqual(["preferences"]);
  });

  it("treats a legacy run without a pantry snapshot as a pantry change", () => {
    expect(weeklyGenerationInputChanges(run(null), input)).toEqual(["pantry"]);
  });
});

describe("createWeeklyGenerationCatalog", () => {
  const references = canonicalIngredients.map((ingredient, index) => ({
    aliases: ingredient.aliases,
    baseUnit: ingredient.baseUnit,
    category: ingredient.category,
    densityGramsPerMl:
      ingredient.densityGPerMl === null ? null : Number(ingredient.densityGPerMl),
    gramsPerCount:
      ingredient.gramsPerCount === null ? null : Number(ingredient.gramsPerCount),
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    isStaple: ingredient.isStaple,
    name: ingredient.name,
    pluralName: ingredient.pluralName,
  }));

  it("leaves never use ingredients out of the planner catalog", () => {
    const fullCatalog = createWeeklyGenerationCatalog(references, "# Mild");
    const catalog = createWeeklyGenerationCatalog(
      references,
      "# Mild\n\n## Never use\n\n- Pork",
    );
    const names = catalog.map((entry) => entry.name);

    expect(fullCatalog.map((entry) => entry.name)).toContain("pork chop");
    expect(names).not.toContain("pork chop");
    expect(names).not.toContain("bacon");
    expect(names).not.toContain("Italian sausage");
    expect(names).toContain("chicken breast");
    expect(fingerprintWeeklyGenerationCatalog(catalog)).not.toBe(
      fingerprintWeeklyGenerationCatalog(fullCatalog),
    );
  });
});
