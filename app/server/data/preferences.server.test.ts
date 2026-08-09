import { describe, expect, it, vi } from "vitest";

import {
  eventLogs,
  householdPreferenceProfiles,
} from "~/db/schema";
import type { ScopedDatabase } from "~/server/context.server";
import {
  KITCHEN_PREFERENCES_MAX_LENGTH,
  KitchenPreferencesValidationError,
  STARTER_KITCHEN_PREFERENCES,
  getHouseholdKitchenPreferences,
  kitchenPreferencesMarkdownSchema,
  saveHouseholdKitchenPreferences,
} from "./preferences.server";

const HOUSEHOLD_ID = "f8044a3a-b8e1-4bea-a3db-d8f4f322b411";
const USER_ID = "f69ec2b8-a84c-448b-a26c-6571cd8de311";

function readFixture(
  rows: readonly Readonly<{ markdown: string; updatedAt: Date }>[] = [],
) {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  return {
    limit,
    scoped: {
      db: { select },
      scope: { householdId: HOUSEHOLD_ID, userId: USER_ID },
    } as unknown as ScopedDatabase,
    select,
    where,
  };
}

function writeFixture() {
  const profileValues: unknown[] = [];
  const eventValues: unknown[] = [];
  const conflictUpdates: unknown[] = [];
  const savedAt = new Date("2026-08-08T15:30:00.000Z");

  const returning = vi.fn(async () => [
    { markdown: "# Family table", updatedAt: savedAt },
  ]);
  const onConflictDoUpdate = vi.fn((conflict: unknown) => {
    conflictUpdates.push(conflict);
    return { returning };
  });
  const transaction = {
    insert: vi.fn((table: unknown) => {
      if (table === householdPreferenceProfiles) {
        return {
          values: vi.fn((values: unknown) => {
            profileValues.push(values);
            return { onConflictDoUpdate };
          }),
        };
      }
      if (table === eventLogs) {
        return {
          values: vi.fn(async (values: unknown) => {
            eventValues.push(values);
          }),
        };
      }
      throw new Error("Unexpected table");
    }),
  };
  const db = {
    transaction: vi.fn(
      async (callback: (value: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
  };

  return {
    conflictUpdates,
    eventValues,
    profileValues,
    savedAt,
    scoped: {
      db,
      scope: { householdId: HOUSEHOLD_ID, userId: USER_ID },
    } as unknown as ScopedDatabase,
    transaction,
  };
}

describe("kitchen preference validation", () => {
  it("ships a safe, valid family starter document", () => {
    expect(kitchenPreferencesMarkdownSchema.parse(STARTER_KITCHEN_PREFERENCES))
      .toContain("# Our kitchen preferences");
    expect(STARTER_KITCHEN_PREFERENCES).toContain(
      "Allergies and medical dietary needs: Not entered yet.",
    );
  });

  it("normalizes line endings and surrounding whitespace", () => {
    expect(kitchenPreferencesMarkdownSchema.parse("  # Dinner\r\n\r\n- Mild  "))
      .toBe("# Dinner\n\n- Mild");
  });

  it.each([
    ["blank", "   "],
    ["too long", "a".repeat(KITCHEN_PREFERENCES_MAX_LENGTH + 1)],
    ["en dash", "Use mild \u2013 medium spice."],
    ["em dash", "Use mild \u2014 medium spice."],
  ])("rejects %s content", (_label, markdown) => {
    expect(kitchenPreferencesMarkdownSchema.safeParse(markdown).success)
      .toBe(false);
  });
});

describe("getHouseholdKitchenPreferences", () => {
  it("returns the starter profile without writing when none is saved", async () => {
    const fixture = readFixture();

    await expect(getHouseholdKitchenPreferences(fixture.scoped)).resolves.toEqual({
      isStarter: true,
      markdown: STARTER_KITCHEN_PREFERENCES,
      updatedAt: null,
    });
    expect(fixture.select).toHaveBeenCalledOnce();
    expect(fixture.where).toHaveBeenCalledOnce();
  });

  it("returns the saved profile for the scoped household", async () => {
    const updatedAt = new Date("2026-08-08T14:00:00.000Z");
    const fixture = readFixture([
      { markdown: "# Fruge family table", updatedAt },
    ]);

    await expect(getHouseholdKitchenPreferences(fixture.scoped)).resolves.toEqual({
      isStarter: false,
      markdown: "# Fruge family table",
      updatedAt,
    });
  });
});

describe("saveHouseholdKitchenPreferences", () => {
  it("upserts one household document with scoped updater provenance", async () => {
    const fixture = writeFixture();

    await expect(
      saveHouseholdKitchenPreferences(fixture.scoped, {
        markdown: "  # Family table\r\n\r\n- Mild spice  ",
      }),
    ).resolves.toEqual({
      markdown: "# Family table",
      updatedAt: fixture.savedAt,
    });

    expect(fixture.profileValues).toHaveLength(1);
    expect(fixture.profileValues[0]).toMatchObject({
      householdId: HOUSEHOLD_ID,
      markdown: "# Family table\n\n- Mild spice",
      updatedByAppUserId: USER_ID,
    });
    expect(fixture.profileValues[0]).not.toHaveProperty("updatedAt");
    expect(fixture.conflictUpdates).toHaveLength(1);
    expect(fixture.conflictUpdates[0]).toMatchObject({
      set: {
        markdown: "# Family table\n\n- Mild spice",
        updatedByAppUserId: USER_ID,
      },
      target: householdPreferenceProfiles.householdId,
    });
    expect(fixture.conflictUpdates[0]).toHaveProperty("set.updatedAt");
    expect(fixture.eventValues).toEqual([
      {
        eventType: "household.preferences_updated",
        householdId: HOUSEHOLD_ID,
        payload: {
          characterCount: 28,
          userId: USER_ID,
        },
      },
    ]);
  });

  it("rejects invalid content before opening a transaction", async () => {
    const fixture = writeFixture();

    await expect(
      saveHouseholdKitchenPreferences(fixture.scoped, { markdown: "" }),
    ).rejects.toBeInstanceOf(KitchenPreferencesValidationError);
    expect(fixture.scoped.db.transaction).not.toHaveBeenCalled();
  });
});
