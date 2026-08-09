import { describe, expect, it, vi } from "vitest";

import type { WeeklyGenerationCatalogEntry } from "~/domain/weekly-generation";
import type { ScopedDatabase } from "~/server/context.server";
import {
  WEEKLY_GENERATION_EVENT_TYPES,
  fingerprintKitchenPreferences,
  fingerprintWeeklyGenerationCatalog,
  fingerprintWeeklyGenerationDietaryNotes,
  recordWeeklyGenerationFailure,
  reserveWeeklyGenerationAttempt,
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

type QueryRows = readonly Readonly<Record<string, unknown>>[];

function queryBuilder(rows: QueryRows) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => rows),
      })),
    })),
  };
}

function rateLimitFixture(results: readonly QueryRows[]) {
  const pending = [...results];
  const insertedValues: unknown[] = [];
  const transaction = {
    execute: vi.fn(async () => []),
    insert: vi.fn(() => ({
      values: vi.fn(async (values: unknown) => {
        insertedValues.push(values);
      }),
    })),
    select: vi.fn(() => queryBuilder(pending.shift() ?? [])),
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
    const reordered = fingerprintWeeklyGenerationCatalog([...catalog].reverse());
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

describe("reserveWeeklyGenerationAttempt", () => {
  it("atomically reserves an attempt below both limits", async () => {
    const fixture = rateLimitFixture([[{ value: 1 }], [{ value: 5 }]]);

    const result = await reserveWeeklyGenerationAttempt(fixture.scoped);

    expect(result.attemptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(fixture.transaction.execute).toHaveBeenCalledOnce();
    expect(fixture.insertedValues).toEqual([
      {
        eventType: WEEKLY_GENERATION_EVENT_TYPES.requested,
        householdId: HOUSEHOLD_ID,
        payload: { attemptId: result.attemptId, userId: USER_ID },
      },
    ]);
  });

  it("rejects the third user request inside one hour", async () => {
    const fixture = rateLimitFixture([[{ value: 2 }]]);

    await expect(
      reserveWeeklyGenerationAttempt(fixture.scoped),
    ).rejects.toMatchObject({ code: "user_hour", retryAfterSeconds: 3_600 });
    expect(fixture.insertedValues).toEqual([]);
  });

  it("rejects the seventh household request inside one day", async () => {
    const fixture = rateLimitFixture([[{ value: 0 }], [{ value: 6 }]]);

    await expect(
      reserveWeeklyGenerationAttempt(fixture.scoped),
    ).rejects.toMatchObject({
      code: "household_day",
      retryAfterSeconds: 86_400,
    });
    expect(fixture.insertedValues).toEqual([]);
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
