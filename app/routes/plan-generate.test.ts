import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NormalizedWeeklyCandidate } from "~/domain/weekly-generation";

const mocks = vi.hoisted(() => ({
  createWeeklyGenerationJob: vi.fn(),
  dispatchWeeklyGenerationJob: vi.fn(),
  findLatestActiveInstructionJobForRun: vi.fn(),
  findLatestActiveSlotGenerationJobForRun: vi.fn(),
  getActiveWeeklyGenerationBuild: vi.fn(),
  getHouseholdKitchenPreferences: vi.fn(),
  getLatestReadyWeeklyGenerationRun: vi.fn(),
  getWeekPlannerData: vi.fn(),
  getWeeklyGenerationJob: vi.fn(),
  loadWeeklyGenerationContext: vi.fn(),
  markWeeklyGenerationJobFailed: vi.fn(),
  releaseWeeklyGenerationBuild: vi.fn(),
  reserveWeeklyGenerationAttempt: vi.fn(),
  scoped: {
    db: {},
    scope: {
      householdId: "f8044a3a-b8e1-4bea-a3db-d8f4f322b411",
      userId: "f69ec2b8-a84c-448b-a26c-6571cd8de311",
    },
  },
  supersedeWeeklyGenerationRun: vi.fn(),
}));

vi.mock("~/server/context.server", () => ({
  requireIdentity: vi.fn(),
  requireScopedDatabase: vi.fn(() => mocks.scoped),
}));
vi.mock("~/server/data/preferences.server", () => ({
  getHouseholdKitchenPreferences: mocks.getHouseholdKitchenPreferences,
}));
vi.mock("~/server/data/week.server", () => ({
  getWeekPlannerData: mocks.getWeekPlannerData,
}));
vi.mock("~/server/data/weekly-generation-jobs.server", () => ({
  createOrGetActiveSlotGenerationJob: vi.fn(),
  createWeeklyGenerationJob: mocks.createWeeklyGenerationJob,
  findLatestActiveInstructionJobForRun:
    mocks.findLatestActiveInstructionJobForRun,
  findLatestActiveSlotGenerationJobForRun:
    mocks.findLatestActiveSlotGenerationJobForRun,
  getWeeklyGenerationJob: mocks.getWeeklyGenerationJob,
  markWeeklyGenerationJobFailed: mocks.markWeeklyGenerationJobFailed,
}));
vi.mock("~/server/data/weekly-generation.server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("~/server/data/weekly-generation.server")
  >()),
  getActiveWeeklyGenerationBuild: mocks.getActiveWeeklyGenerationBuild,
  getLatestReadyWeeklyGenerationRun: mocks.getLatestReadyWeeklyGenerationRun,
  releaseWeeklyGenerationBuild: mocks.releaseWeeklyGenerationBuild,
  reserveWeeklyGenerationAttempt: mocks.reserveWeeklyGenerationAttempt,
  supersedeWeeklyGenerationRun: mocks.supersedeWeeklyGenerationRun,
}));
vi.mock(
  "~/server/jobs/weekly-generation-context.server",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("~/server/jobs/weekly-generation-context.server")
    >()),
    loadWeeklyGenerationContext: mocks.loadWeeklyGenerationContext,
  }),
);
vi.mock("~/server/jobs/weekly-generation-dispatch.server", () => ({
  dispatchWeeklyGenerationJob: mocks.dispatchWeeklyGenerationJob,
}));

import {
  fingerprintKitchenPreferences,
  fingerprintWeeklyGenerationCatalog,
  fingerprintWeeklyGenerationDietaryNotes,
  fingerprintWeeklyGenerationPantryBalances,
  WeeklyGenerationBuildBusyError,
  WeeklyGenerationRunError,
  type WeeklyGenerationRun,
} from "~/server/data/weekly-generation.server";
import { action, loader } from "./plan-generate";

const WEEK_START = "2026-08-09";
const RUN_ID = "00000000-0000-4000-8000-000000000099";
const ATTEMPT_ID = "00000000-0000-4000-8000-000000000088";
const PREFERENCES = "# Preferences\n\n- Mild dinners";
const DINNER_DATES = [
  "2026-08-10",
  "2026-08-11",
  "2026-08-12",
  "2026-08-13",
  "2026-08-14",
];

const slots = DINNER_DATES.map((date, index) => ({
  date,
  effortTier: "weeknight" as const,
  maxActiveTimeMinutes: 45,
  servingsTarget: 2,
  slotKey: `d${index + 1}`,
}));

function readyRun(
  overrides: Partial<WeeklyGenerationRun> = {},
): WeeklyGenerationRun {
  const candidates: NormalizedWeeklyCandidate[] = Array.from(
    { length: 15 },
    (_, index) => ({
      activeTimeMinutes: 30,
      baseServings: 2,
      candidateKey: `c${String(index + 1).padStart(3, "0")}`,
      cuisine: `Cuisine ${index % 3}`,
      effortTier: "weeknight",
      ingredients: [1, 2, 3].map((ingredientIndex) => ({
        baseUnit: "g" as const,
        canonicalIngredientId: `00000000-0000-4000-8000-00000000000${ingredientIndex}`,
        catalogKey: `i00${ingredientIndex}`,
        isOptional: false,
        isStaple: false,
        name: `Ingredient ${ingredientIndex}`,
        preparation: null,
        quantity: 100,
        quantityInBaseUnit: 100,
        scalesLinearly: true,
        unit: "g" as const,
      })),
      minInternalTemperatureF: 165,
      primaryProtein: `Protein ${index % 3}`,
      primaryProteinCatalogKey: "i001",
      slotDate: DINNER_DATES[Math.floor(index / 3)]!,
      techniques: [`Technique ${index % 3}`],
      title: `Test dinner ${index + 1}`,
      totalTimeMinutes: 45,
    }),
  );
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
  return {
    acceptedAt: null,
    candidates,
    catalogFingerprint: fingerprintWeeklyGenerationCatalog([]),
    createdAt: new Date(),
    dietaryNotesFingerprint: fingerprintWeeklyGenerationDietaryNotes([]),
    expiresAt: new Date(Date.now() + 60_000),
    failureCode: null,
    id: RUN_ID,
    mealPlanId: null,
    model: "test-model",
    pantryFingerprint: fingerprintWeeklyGenerationPantryBalances([]),
    preferenceFingerprint: fingerprintKitchenPreferences(PREFERENCES),
    rerollHistory: Object.fromEntries(
      selection.items.map((item) => [item.slotDate, [item.candidateKey]]),
    ),
    requestedByAppUserId: mocks.scoped.scope.userId,
    selection,
    slots,
    status: "ready",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    weekStartDate: WEEK_START,
    ...overrides,
  };
}

function weekDays(cookingDates: readonly string[] = DINNER_DATES) {
  return [WEEK_START, ...DINNER_DATES, "2026-08-15"].map((date) => ({
    date,
    demand: 2,
    entry: null,
    isDayOff: !cookingDates.includes(date),
    servingsTarget: 2,
  }));
}

function currentContext(
  overrides: Partial<{
    pantryBalances: readonly Readonly<{
      canonicalIngredientId: string;
      quantityInBaseUnit: number;
    }>[];
    preferenceMarkdown: string;
  }> = {},
) {
  return {
    catalog: [],
    dietaryNotes: [],
    pantryBalances: overrides.pantryBalances ?? [],
    preferences: {
      isStarter: false,
      markdown: overrides.preferenceMarkdown ?? PREFERENCES,
      updatedAt: null,
    },
    slots,
  };
}

function loaderArgs(search = "") {
  return {
    context: {},
    params: { weekStart: WEEK_START },
    request: new Request(
      `https://dfy.kitchen/plans/${WEEK_START}/generate${search}`,
    ),
  } as unknown as Parameters<typeof loader>[0];
}

function actionArgs(fields: Readonly<Record<string, string>>) {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  return {
    context: {},
    params: { weekStart: WEEK_START },
    request: new Request(`https://dfy.kitchen/plans/${WEEK_START}/generate`, {
      body,
      method: "POST",
    }),
  } as unknown as Parameters<typeof action>[0];
}

function errorOf(result: unknown) {
  const { data, init } = result as {
    data: { error: string };
    init: { status: number };
  };
  return { error: data.error, status: init.status };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getWeekPlannerData.mockResolvedValue({ days: weekDays() });
  mocks.getHouseholdKitchenPreferences.mockResolvedValue({
    isStarter: false,
    markdown: PREFERENCES,
    updatedAt: null,
  });
  mocks.getActiveWeeklyGenerationBuild.mockResolvedValue(null);
  mocks.getLatestReadyWeeklyGenerationRun.mockResolvedValue(readyRun());
  mocks.findLatestActiveSlotGenerationJobForRun.mockResolvedValue(null);
  mocks.loadWeeklyGenerationContext.mockResolvedValue(currentContext());
  mocks.supersedeWeeklyGenerationRun.mockResolvedValue(undefined);
  mocks.reserveWeeklyGenerationAttempt.mockResolvedValue({
    attemptId: ATTEMPT_ID,
  });
  mocks.createWeeklyGenerationJob.mockResolvedValue({ id: ATTEMPT_ID });
});

describe("weekly planner loader draft freshness", () => {
  it("treats a ready draft as current while its inputs still match", async () => {
    const result = await loader(loaderArgs());

    expect(result.runId).toBe(RUN_ID);
    expect(result.outdatedInputs).toEqual([]);
    expect(mocks.loadWeeklyGenerationContext).toHaveBeenCalledWith(
      mocks.scoped,
      WEEK_START,
    );
  });

  it("flags a ready draft built before preference and pantry changes", async () => {
    mocks.loadWeeklyGenerationContext.mockResolvedValue(
      currentContext({
        pantryBalances: [
          {
            canonicalIngredientId: "00000000-0000-4000-8000-000000000001",
            quantityInBaseUnit: 250,
          },
        ],
        preferenceMarkdown: "# Preferences\n\n## Never use\n\n- Pork",
      }),
    );

    const result = await loader(loaderArgs());

    expect(result.runId).toBe(RUN_ID);
    expect(result.outdatedInputs).toEqual(["preferences", "pantry"]);
  });

  it("reports changed cooking days without rebuilding context when none are left", async () => {
    mocks.getWeekPlannerData.mockResolvedValue({ days: weekDays([]) });

    const result = await loader(loaderArgs());

    expect(result.outdatedInputs).toEqual(["slots"]);
    expect(result.nextDinnerCount).toBe(0);
    expect(mocks.loadWeeklyGenerationContext).not.toHaveBeenCalled();
  });

  it("counts the dinners a fresh draft would build from the current week", async () => {
    mocks.getWeekPlannerData.mockResolvedValue({
      days: weekDays(DINNER_DATES.slice(0, 3)),
    });
    mocks.loadWeeklyGenerationContext.mockResolvedValue({
      ...currentContext(),
      slots: slots.slice(0, 3),
    });

    const result = await loader(loaderArgs());

    expect(result.slots).toHaveLength(5);
    expect(result.nextDinnerCount).toBe(3);
    expect(result.outdatedInputs).toEqual(["slots"]);
  });

  it("skips the freshness check when no draft is shown", async () => {
    mocks.getLatestReadyWeeklyGenerationRun.mockResolvedValue(null);

    const result = await loader(loaderArgs());

    expect(result.runId).toBeNull();
    expect(result.outdatedInputs).toEqual([]);
    expect(mocks.loadWeeklyGenerationContext).not.toHaveBeenCalled();
  });
});

describe("weekly planner start-over action", () => {
  const startOver = {
    _intent: "start-over",
    runId: RUN_ID,
    weekStart: WEEK_START,
  };

  it("supersedes the shown draft, then starts a fresh build", async () => {
    const result = await action(actionArgs(startOver));

    expect(mocks.supersedeWeeklyGenerationRun).toHaveBeenCalledWith(
      mocks.scoped,
      { runId: RUN_ID, weekStartDate: WEEK_START },
    );
    expect(mocks.reserveWeeklyGenerationAttempt).toHaveBeenCalledWith(
      mocks.scoped,
      { weekStartDate: WEEK_START },
    );
    expect(
      mocks.supersedeWeeklyGenerationRun.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.reserveWeeklyGenerationAttempt.mock.invocationCallOrder[0]!,
    );
    expect(mocks.createWeeklyGenerationJob).toHaveBeenCalledWith(mocks.scoped, {
      id: ATTEMPT_ID,
      phase: "candidates",
      weekStartDate: WEEK_START,
    });
    expect(mocks.dispatchWeeklyGenerationJob).toHaveBeenCalledWith(ATTEMPT_ID);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe(
      `/plans/${WEEK_START}/generate?job=${ATTEMPT_ID}#draft-review`,
    );
  });

  it("keeps the draft and starts nothing while another build is running", async () => {
    mocks.supersedeWeeklyGenerationRun.mockRejectedValue(
      new WeeklyGenerationBuildBusyError(),
    );

    const result = await action(actionArgs(startOver));

    expect(errorOf(result)).toEqual({
      error:
        "Someone else in your household is already building this week. This page will update when it is ready.",
      status: 409,
    });
    expect(mocks.reserveWeeklyGenerationAttempt).not.toHaveBeenCalled();
    expect(mocks.createWeeklyGenerationJob).not.toHaveBeenCalled();
  });

  it("starts nothing when the draft was accepted or is still changing", async () => {
    for (const error of [
      new WeeklyGenerationRunError(
        "already_accepted",
        "This weekly draft has already been accepted.",
      ),
      new WeeklyGenerationRunError(
        "busy",
        "Fresh dinner ideas are still being generated for this weekly draft.",
      ),
    ]) {
      mocks.supersedeWeeklyGenerationRun.mockRejectedValueOnce(error);

      const result = await action(actionArgs(startOver));

      expect(errorOf(result)).toEqual({ error: error.message, status: 409 });
    }
    expect(mocks.reserveWeeklyGenerationAttempt).not.toHaveBeenCalled();
  });

  it("returns not found for a draft outside the household", async () => {
    mocks.supersedeWeeklyGenerationRun.mockRejectedValue(
      new WeeklyGenerationRunError(
        "not_found",
        "This weekly draft was not found. Generate a fresh one.",
      ),
    );

    const result = await action(actionArgs(startOver));

    expect(errorOf(result).status).toBe(404);
    expect(mocks.reserveWeeklyGenerationAttempt).not.toHaveBeenCalled();
  });

  it("rejects a start-over request without a draft id", async () => {
    const result = await action(
      actionArgs({ _intent: "start-over", weekStart: WEEK_START }),
    );

    expect(errorOf(result)).toEqual({
      error: "The weekly draft request is invalid.",
      status: 400,
    });
    expect(mocks.supersedeWeeklyGenerationRun).not.toHaveBeenCalled();
  });
});
