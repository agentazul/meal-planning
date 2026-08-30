import { describe, expect, it } from "vitest";

import type { WeeklyGenerationRun } from "~/server/data/weekly-generation.server";
import {
  fingerprintKitchenPreferences,
  fingerprintWeeklyGenerationCatalog,
  fingerprintWeeklyGenerationDietaryNotes,
  fingerprintWeeklyGenerationPantryBalances,
} from "~/server/data/weekly-generation.server";
import { weeklyGenerationInputsMatch } from "./weekly-generation-context.server";

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
