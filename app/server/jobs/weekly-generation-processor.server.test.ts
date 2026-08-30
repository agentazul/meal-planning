import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acceptWeeklyGenerationRun: vi.fn(),
  chooseWeeklyGenerationSelection: vi.fn(),
  claimWeeklyGenerationJobForWork: vi.fn(),
  close: vi.fn(),
  createGoogleLanguageModel: vi.fn(),
  createReadyWeeklyGenerationRun: vi.fn(),
  createRequestDatabase: vi.fn(),
  createScopedDatabase: vi.fn(),
  generateWeeklyCandidates: vi.fn(),
  generateWeeklyInstructions: vi.fn(),
  getServerEnv: vi.fn(),
  getWeeklyGenerationJobForWorker: vi.fn(),
  getWeeklyGenerationRun: vi.fn(),
  loadWeeklyGenerationContext: vi.fn(),
  markWeeklyGenerationJobFailed: vi.fn(),
  markWeeklyGenerationJobSucceeded: vi.fn(),
  recordWeeklyGenerationFailure: vi.fn(),
  releaseWeeklyGenerationBuild: vi.fn(),
  releaseWeeklyGenerationRun: vi.fn(),
  requeueWeeklyGenerationJob: vi.fn(),
  selectedWeeklyCandidates: vi.fn(),
  shouldRetryWeeklyGenerationError: vi.fn(),
  weeklyGenerationErrorMessage: vi.fn(),
  weeklyGenerationFailureAudit: vi.fn(),
  weeklyGenerationFailureReason: vi.fn(),
  weeklyGenerationInputsMatch: vi.fn(),
  WeeklyPlanGenerationError: class WeeklyPlanGenerationError extends Error {
    readonly code = "request_failed";

    constructor(readonly providerFailureCode?: string) {
      super("Weekly recipe generation is temporarily unavailable.");
    }
  },
}));

vi.mock("~/db/request-db.server", () => ({
  createRequestDatabase: mocks.createRequestDatabase,
}));
vi.mock("~/domain/weekly-generation", () => ({
  chooseWeeklyGenerationSelection: mocks.chooseWeeklyGenerationSelection,
  selectedWeeklyCandidates: mocks.selectedWeeklyCandidates,
}));
vi.mock("~/server/ai/google-provider.server", () => ({
  createGoogleLanguageModel: mocks.createGoogleLanguageModel,
}));
vi.mock("~/server/ai/weekly-plan-generation.server", () => ({
  generateWeeklyCandidates: mocks.generateWeeklyCandidates,
  generateWeeklyInstructions: mocks.generateWeeklyInstructions,
  WeeklyPlanGenerationError: mocks.WeeklyPlanGenerationError,
}));
vi.mock("~/server/context.server", () => ({
  createScopedDatabase: mocks.createScopedDatabase,
}));
vi.mock("~/server/data/weekly-generation-jobs.server", () => ({
  claimWeeklyGenerationJobForWork: mocks.claimWeeklyGenerationJobForWork,
  getWeeklyGenerationJobForWorker: mocks.getWeeklyGenerationJobForWorker,
  markWeeklyGenerationJobFailed: mocks.markWeeklyGenerationJobFailed,
  markWeeklyGenerationJobSucceeded: mocks.markWeeklyGenerationJobSucceeded,
  requeueWeeklyGenerationJob: mocks.requeueWeeklyGenerationJob,
}));
vi.mock("~/server/data/weekly-generation.server", () => ({
  acceptWeeklyGenerationRun: mocks.acceptWeeklyGenerationRun,
  createReadyWeeklyGenerationRun: mocks.createReadyWeeklyGenerationRun,
  fingerprintKitchenPreferences: vi.fn(() => "preferences"),
  fingerprintWeeklyGenerationCatalog: vi.fn(() => "catalog"),
  fingerprintWeeklyGenerationDietaryNotes: vi.fn(() => "dietary"),
  getWeeklyGenerationRun: mocks.getWeeklyGenerationRun,
  recordWeeklyGenerationFailure: mocks.recordWeeklyGenerationFailure,
  releaseWeeklyGenerationBuild: mocks.releaseWeeklyGenerationBuild,
  releaseWeeklyGenerationRun: mocks.releaseWeeklyGenerationRun,
}));
vi.mock("~/server/env.server", () => ({
  getServerEnv: mocks.getServerEnv,
}));
vi.mock("./weekly-generation-context.server", () => ({
  loadWeeklyGenerationContext: mocks.loadWeeklyGenerationContext,
  shouldRetryWeeklyGenerationError:
    mocks.shouldRetryWeeklyGenerationError,
  weeklyGenerationErrorMessage: mocks.weeklyGenerationErrorMessage,
  weeklyGenerationFailureAudit: mocks.weeklyGenerationFailureAudit,
  weeklyGenerationFailureReason: mocks.weeklyGenerationFailureReason,
  weeklyGenerationInputsMatch: mocks.weeklyGenerationInputsMatch,
}));

import { processWeeklyGenerationJob } from "./weekly-generation-processor.server";

const DB = { name: "database" };
const JOB_ID = "9cb7e308-13b9-4dfe-9e62-fab1db83edca";
const RUN_ID = "f8044a3a-b8e1-4bea-a3db-d8f4f322b411";
const HOUSEHOLD_ID = "ec0df454-4810-4aa8-b7c1-d0b57e0143e0";
const USER_ID = "f69ec2b8-a84c-448b-a26c-6571cd8de311";

function job(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    completedAt: null,
    createdAt: new Date("2026-08-30T15:00:00.000Z"),
    deliveryCount: 1,
    failureCode: null,
    failureMessage: null,
    householdId: HOUSEHOLD_ID,
    id: JOB_ID,
    leaseExpiresAt: new Date("2026-08-30T15:20:00.000Z"),
    phase: "candidates",
    requestedByAppUserId: USER_ID,
    runId: null,
    startedAt: new Date("2026-08-30T15:00:00.000Z"),
    status: "running",
    updatedAt: new Date("2026-08-30T15:00:00.000Z"),
    weekStartDate: "2026-08-30",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createRequestDatabase.mockReturnValue({ close: mocks.close, db: DB });
  mocks.createScopedDatabase.mockReturnValue({
    db: DB,
    scope: { householdId: HOUSEHOLD_ID, userId: USER_ID },
  });
  mocks.getWeeklyGenerationJobForWorker.mockResolvedValue(
    job({ status: "queued" }),
  );
  mocks.claimWeeklyGenerationJobForWork.mockResolvedValue(job());
  mocks.getServerEnv.mockReturnValue({
    AI_RECIPE_MODEL: "gemini-3.7-flash",
    GOOGLE_VERTEX_API_KEY: "test-google-key",
  });
  mocks.createGoogleLanguageModel.mockReturnValue({ modelId: "gemini-3.7-flash" });
  mocks.getWeeklyGenerationRun.mockResolvedValue(null);
  mocks.loadWeeklyGenerationContext.mockResolvedValue({
    catalog: [],
    dietaryNotes: [],
    preferences: { markdown: "# Preferences" },
    recentHistory: [],
    slots: [],
  });
  mocks.generateWeeklyCandidates.mockResolvedValue({
    candidates: [{ candidateKey: "c001" }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  });
  mocks.chooseWeeklyGenerationSelection.mockReturnValue({ items: [], score: {} });
  mocks.createReadyWeeklyGenerationRun.mockResolvedValue({ id: RUN_ID });
  mocks.weeklyGenerationFailureReason.mockReturnValue("unknown");
  mocks.weeklyGenerationFailureAudit.mockReturnValue({});
  mocks.weeklyGenerationErrorMessage.mockReturnValue(
    "Weekly generation is temporarily unavailable. Try again.",
  );
  mocks.shouldRetryWeeklyGenerationError.mockReturnValue(false);
  mocks.releaseWeeklyGenerationBuild.mockResolvedValue(true);
  mocks.recordWeeklyGenerationFailure.mockResolvedValue(undefined);
  mocks.markWeeklyGenerationJobSucceeded.mockResolvedValue(undefined);
  mocks.markWeeklyGenerationJobFailed.mockResolvedValue(undefined);
  mocks.requeueWeeklyGenerationJob.mockResolvedValue(undefined);
});

describe("weekly generation processor", () => {
  it("publishes a candidate run and completes the durable job", async () => {
    await expect(processWeeklyGenerationJob(JOB_ID)).resolves.toEqual({
      status: "succeeded",
    });

    expect(mocks.createGoogleLanguageModel).toHaveBeenCalledWith({
      apiKey: "test-google-key",
      modelId: "gemini-3.7-flash",
    });
    expect(mocks.createReadyWeeklyGenerationRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attemptId: JOB_ID }),
    );
    expect(mocks.markWeeklyGenerationJobSucceeded).toHaveBeenCalledWith(DB, {
      jobId: JOB_ID,
      runId: RUN_ID,
    });
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("requeues an unexpected transient failure without releasing ownership", async () => {
    mocks.generateWeeklyCandidates.mockRejectedValue(
      new Error("transient database disconnect"),
    );

    await expect(processWeeklyGenerationJob(JOB_ID)).resolves.toEqual({
      status: "retry_queued",
    });

    expect(mocks.requeueWeeklyGenerationJob).toHaveBeenCalledWith(DB, {
      jobId: JOB_ID,
    });
    expect(mocks.releaseWeeklyGenerationBuild).not.toHaveBeenCalled();
    expect(mocks.markWeeklyGenerationJobFailed).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("records a controlled terminal failure and releases the build fence", async () => {
    mocks.weeklyGenerationFailureReason.mockReturnValue("configuration");
    mocks.generateWeeklyCandidates.mockRejectedValue(
      new Error("Google Vertex AI credentials are not configured."),
    );

    await expect(processWeeklyGenerationJob(JOB_ID)).resolves.toEqual({
      status: "failed",
    });

    expect(mocks.releaseWeeklyGenerationBuild).toHaveBeenCalledWith(
      expect.anything(),
      { attemptId: JOB_ID, weekStartDate: "2026-08-30" },
    );
    expect(mocks.markWeeklyGenerationJobFailed).toHaveBeenCalledWith(DB, {
      failureCode: "configuration",
      failureMessage:
        "Weekly generation is temporarily unavailable. Try again.",
      jobId: JOB_ID,
    });
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("stores the safe provider classification instead of a generic request failure", async () => {
    mocks.generateWeeklyCandidates.mockRejectedValue(
      new mocks.WeeklyPlanGenerationError("invalid_api_key"),
    );

    await expect(processWeeklyGenerationJob(JOB_ID)).resolves.toEqual({
      status: "failed",
    });

    expect(mocks.markWeeklyGenerationJobFailed).toHaveBeenCalledWith(DB, {
      failureCode: "invalid_api_key",
      failureMessage:
        "Weekly generation is temporarily unavailable. Try again.",
      jobId: JOB_ID,
    });
  });
});
