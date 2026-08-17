import { describe, expect, it, vi } from "vitest";

import type { WeeklyGenerationCatalogEntry } from "~/domain/weekly-generation";
import type { ScopedDatabase } from "~/server/context.server";
import {
  WEEKLY_GENERATION_EVENT_TYPES,
  createReadyWeeklyGenerationRun,
  fingerprintKitchenPreferences,
  fingerprintWeeklyGenerationCatalog,
  fingerprintWeeklyGenerationDietaryNotes,
  getWeeklyRotationHistoryWindow,
  getActiveWeeklyGenerationBuild,
  listRecentCookedRecipeSummaries,
  recordWeeklyGenerationFailure,
  releaseWeeklyGenerationBuild,
  reserveWeeklyGenerationAttempt,
  WeeklyGenerationBuildBusyError,
} from "./weekly-generation.server";

const HOUSEHOLD_ID = "f8044a3a-b8e1-4bea-a3db-d8f4f322b411";
const USER_ID = "f69ec2b8-a84c-448b-a26c-6571cd8de311";

const catalog: readonly WeeklyGenerationCatalogEntry[] = [
  {
    baseUnit: "g",
    catalogKey: "i001",
    category: "protein",
    densityGramsPerMl: null,
    gramsPerCount: null,
    id: "00000000-0000-4000-8000-000000000001",
    isStaple: false,
    name: "Chicken breast",
    requiredMinimumInternalTemperatureF: 165,
  },
  {
    baseUnit: "ml",
    catalogKey: "i002",
    category: "pantry",
    densityGramsPerMl: 0.91,
    gramsPerCount: null,
    id: "00000000-0000-4000-8000-000000000002",
    isStaple: true,
    name: "Olive oil",
    requiredMinimumInternalTemperatureF: null,
  },
];

function transactionFixture() {
  const insertedValues: unknown[] = [];
  const transaction = {
    execute: vi.fn(async () => []),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => []),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => []) })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (values: unknown) => {
        insertedValues.push(values);
      }),
    })),
  };
  const db = {
    transaction: vi.fn(
      async (callback: (value: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
  };

  return {
    insertedValues,
    scoped: {
      db,
      scope: { householdId: HOUSEHOLD_ID, userId: USER_ID },
    } as unknown as ScopedDatabase,
    transaction,
  };
}

describe("weekly generation fingerprints", () => {
  it("is stable across catalog ordering and changes with planning semantics", () => {
    const original = fingerprintWeeklyGenerationCatalog(catalog);
    const reordered = fingerprintWeeklyGenerationCatalog(
      [...catalog].reverse(),
    );
    const changed = fingerprintWeeklyGenerationCatalog([
      { ...catalog[0]!, isStaple: true },
      catalog[1]!,
    ]);

    expect(original).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(reordered).toBe(original);
    expect(changed).not.toBe(original);
  });

  it("normalizes preference line endings and outer whitespace", () => {
    expect(fingerprintKitchenPreferences("  # Dinner\r\n\r\n- Mild  ")).toBe(
      fingerprintKitchenPreferences("# Dinner\n\n- Mild"),
    );
    expect(fingerprintKitchenPreferences("# Dinner\n\n- Spicy")).not.toBe(
      fingerprintKitchenPreferences("# Dinner\n\n- Mild"),
    );
  });

  it("fingerprints normalized anonymous dietary notes independent of order", () => {
    const original = fingerprintWeeklyGenerationDietaryNotes([
      " No shellfish.\r\n",
      "Avoid peanuts.",
    ]);
    expect(original).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(original).toBe(
      fingerprintWeeklyGenerationDietaryNotes([
        "Avoid peanuts.",
        "No shellfish.",
      ]),
    );
    expect(original).not.toBe(
      fingerprintWeeklyGenerationDietaryNotes(["Avoid peanuts."]),
    );
  });
});

describe("weekly rotation history", () => {
  it("uses the 21 days before the generated week as a half-open window", () => {
    expect(getWeeklyRotationHistoryWindow("2026-08-09")).toEqual({
      fromInclusive: "2026-07-19",
      toExclusive: "2026-08-09",
    });
  });

  it("caps recent recipe summaries before they reach AI input validation", async () => {
    const rows = Array.from({ length: 35 }, (_, index) => ({
      cuisine: "American",
      primaryProtein: "Chicken",
      techniques: ["roasting"],
      title: `Dinner ${String(index + 1).padStart(2, "0")}`,
    }));
    const limit = vi.fn(async (maximum: number) => rows.slice(0, maximum));
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn(() => ({ orderBy }));
    const leftJoin = vi.fn(() => ({ where }));
    const from = vi.fn(() => ({ leftJoin }));
    const selectDistinct = vi.fn(() => ({ from }));
    const scoped = {
      db: { selectDistinct },
      scope: { householdId: HOUSEHOLD_ID, userId: USER_ID },
    } as unknown as ScopedDatabase;

    const result = await listRecentCookedRecipeSummaries(scoped, "2026-08-09");

    expect(result).toHaveLength(30);
    expect(limit).toHaveBeenCalledWith(30);
    expect(where).toHaveBeenCalledOnce();
  });
});

describe("reserveWeeklyGenerationAttempt", () => {
  it("always records a request audit event and returns its attempt id", async () => {
    const fixture = transactionFixture();

    const result = await reserveWeeklyGenerationAttempt(fixture.scoped, {
      weekStartDate: "2026-08-09",
    });

    expect(result.attemptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(fixture.transaction.execute).toHaveBeenCalledTimes(2);
    expect(fixture.insertedValues).toHaveLength(2);
    expect(fixture.insertedValues[0]).toMatchObject({
      householdId: HOUSEHOLD_ID,
      ownerToken: result.attemptId,
      requestedByAppUserId: USER_ID,
      weekStartDate: "2026-08-09",
    });
    expect(fixture.insertedValues[1]).toEqual({
      eventType: WEEKLY_GENERATION_EVENT_TYPES.requested,
      householdId: HOUSEHOLD_ID,
      payload: {
        attemptId: result.attemptId,
        userId: USER_ID,
        weekStartDate: "2026-08-09",
      },
    });
  });

  it("rejects a live build before writing a new audit event", async () => {
    const fixture = transactionFixture();
    fixture.transaction.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [
            {
              leaseExpiresAt: new Date(Date.now() + 60_000),
            },
          ]),
        })),
      })),
    } as never);

    await expect(
      reserveWeeklyGenerationAttempt(fixture.scoped, {
        weekStartDate: "2026-08-09",
      }),
    ).rejects.toBeInstanceOf(WeeklyGenerationBuildBusyError);
    expect(fixture.insertedValues).toEqual([]);
  });

  it("reclaims an expired build with a new owner token", async () => {
    const fixture = transactionFixture();
    const updateWhere = vi.fn(async () => []);
    fixture.transaction.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [
            {
              leaseExpiresAt: new Date(Date.now() - 60_000),
            },
          ]),
        })),
      })),
    } as never);
    fixture.transaction.update = vi.fn(() => ({
      set: vi.fn(() => ({ where: updateWhere })),
    })) as never;

    const result = await reserveWeeklyGenerationAttempt(fixture.scoped, {
      weekStartDate: "2026-08-09",
    });
    expect(result.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(updateWhere).toHaveBeenCalledOnce();
    expect(fixture.insertedValues).toHaveLength(1);
  });
});

describe("weekly generation build helpers", () => {
  it("returns only an unexpired active build", async () => {
    const active = {
      leaseExpiresAt: new Date(Date.now() + 60_000),
      ownerToken: "00000000-0000-4000-8000-000000000099",
      startedAt: new Date(),
    };
    const limit = vi.fn(async () => [active]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({
      from,
    }));
    const scoped = {
      db: { select },
      scope: { householdId: HOUSEHOLD_ID, userId: USER_ID },
    } as unknown as ScopedDatabase;

    await expect(
      getActiveWeeklyGenerationBuild(scoped, "2026-08-09"),
    ).resolves.toEqual(active);
  });

  it("conditionally releases only the matching owner token", async () => {
    const returning = vi.fn(async () => [
      { ownerToken: "00000000-0000-4000-8000-000000000099" },
    ]);
    const where = vi.fn(() => ({ returning }));
    const transaction = {
      delete: vi.fn(() => ({ where })),
      execute: vi.fn(async () => []),
    };
    const scoped = {
      db: {
        transaction: vi.fn(
          async (callback: (value: typeof transaction) => Promise<unknown>) =>
            callback(transaction),
        ),
      },
      scope: { householdId: HOUSEHOLD_ID, userId: USER_ID },
    } as unknown as ScopedDatabase;

    await expect(
      releaseWeeklyGenerationBuild(scoped, {
        attemptId: "00000000-0000-4000-8000-000000000099",
        weekStartDate: "2026-08-09",
      }),
    ).resolves.toBe(true);
    expect(transaction.execute).toHaveBeenCalledTimes(2);
  });
});

describe("createReadyWeeklyGenerationRun", () => {
  it("publishes a ready run while preserving household and week locks", async () => {
    const attemptId = "00000000-0000-4000-8000-000000000099";
    const slots = Array.from({ length: 5 }, (_, index) => ({
      date: `2026-08-${String(10 + index).padStart(2, "0")}`,
      effortTier: "weeknight" as const,
      maxActiveTimeMinutes: 45,
      servingsTarget: 2,
      slotKey: `d${index + 1}`,
    }));
    const candidates = Array.from({ length: 15 }, (_, index) => ({
      activeTimeMinutes: 30,
      baseServings: 2,
      candidateKey: `c${String(index + 1).padStart(3, "0")}`,
      cuisine: "Test",
      effortTier: "weeknight" as const,
      ingredients: ["001", "002", "003"].map((id, ingredientIndex) => ({
        baseUnit: "g" as const,
        canonicalIngredientId: `00000000-0000-4000-8000-00000000000${ingredientIndex + 1}`,
        catalogKey: `i00${ingredientIndex + 1}`,
        isOptional: false,
        isStaple: false,
        name: `Ingredient ${id}`,
        preparation: null,
        quantity: 100,
        quantityInBaseUnit: 100,
        scalesLinearly: true,
        unit: "g" as const,
      })),
      minInternalTemperatureF: 165,
      primaryProtein: "Chicken",
      primaryProteinCatalogKey: "i001",
      slotDate: slots[Math.floor(index / 3)]!.date,
      techniques: ["Roast"],
      title: `Test dinner ${index + 1}`,
      totalTimeMinutes: 45,
    }));
    const selection = {
      items: slots.map((slot, index) => ({
        candidateKey: candidates[index * 3]!.candidateKey,
        slotDate: slot.date,
      })),
      score: {
        cuisineVariety: 1,
        proteinVariety: 1,
        sharedIngredientNames: [],
        techniqueVariety: 1,
        value: 1,
      },
    };
    const input = {
      attemptId,
      candidates,
      catalogFingerprint: "catalog",
      dietaryNotesFingerprint: "dietary",
      model: "test-model",
      preferenceFingerprint: "preferences",
      selection,
      slots,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      weekStartDate: "2026-08-09",
    };
    const created = {
      ...input,
      acceptedAt: null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      failureCode: null,
      householdId: HOUSEHOLD_ID,
      id: attemptId,
      mealPlanId: null,
      requestedByAppUserId: USER_ID,
      rerollHistory: {},
      status: "ready" as const,
    };
    const updateWhere = vi.fn(async () => []);
    const returning = vi.fn(async () => [created]);
    const insertedValues: unknown[] = [];
    const transaction = {
      execute: vi.fn(async () => []),
      delete: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => [{ ownerToken: attemptId }]),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: updateWhere })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((values: unknown) => {
          insertedValues.push(values);
          return { returning };
        }),
      })),
    };
    const scoped = {
      db: {
        transaction: vi.fn(
          async (callback: (value: typeof transaction) => Promise<unknown>) =>
            callback(transaction),
        ),
      },
      scope: { householdId: HOUSEHOLD_ID, userId: USER_ID },
    } as unknown as ScopedDatabase;

    await expect(
      createReadyWeeklyGenerationRun(scoped, input),
    ).resolves.toMatchObject({
      id: attemptId,
      status: "ready",
    });
    expect(transaction.execute).toHaveBeenCalledTimes(2);
    expect(insertedValues).toHaveLength(2);
    expect(insertedValues[1]).toMatchObject({
      eventType: WEEKLY_GENERATION_EVENT_TYPES.candidatesReady,
    });
    expect(transaction.update).not.toHaveBeenCalled();

    insertedValues.length = 0;
    transaction.delete.mockReturnValue({
      where: vi.fn(() => ({ returning: vi.fn(async () => []) })),
    } as never);
    await expect(
      createReadyWeeklyGenerationRun(scoped, input),
    ).rejects.toMatchObject({
      code: "stale",
    });
    expect(insertedValues).toEqual([]);
  });
});

describe("recordWeeklyGenerationFailure", () => {
  it("records only bounded structured generation diagnostics", async () => {
    const values = vi.fn(async () => undefined);
    const scoped = {
      db: { insert: vi.fn(() => ({ values })) },
      scope: { householdId: HOUSEHOLD_ID, userId: USER_ID },
    } as unknown as ScopedDatabase;
    const attemptId = "00000000-0000-4000-8000-000000000099";

    await recordWeeklyGenerationFailure(scoped, {
      attemptCount: 2,
      attemptId,
      batch: "1",
      code: "invalid_model_output",
      phase: "instructions",
      reason: "validation",
      validationIssues: [
        "INGREDIENT_COVERAGE: candidateKey=c001; missingRequiredIngredientKeys=i003",
      ],
    });

    expect(values).toHaveBeenCalledWith({
      eventType: WEEKLY_GENERATION_EVENT_TYPES.failed,
      householdId: HOUSEHOLD_ID,
      payload: {
        attemptCount: 2,
        attemptId,
        batch: "1",
        code: "invalid_model_output",
        phase: "instructions",
        reason: "validation",
        userId: USER_ID,
        validationIssues: [
          "INGREDIENT_COVERAGE: candidateKey=c001; missingRequiredIngredientKeys=i003",
        ],
      },
    });
  });
});
