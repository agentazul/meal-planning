import { createRequestDatabase } from "~/db/request-db.server";
import {
  chooseWeeklyGenerationSelection,
  normalizeWeeklySlotCandidateBatch,
  selectedWeeklyCandidates,
} from "~/domain/weekly-generation";
import { createGoogleLanguageModel } from "~/server/ai/google-provider.server";
import {
  generateWeeklyCandidates,
  generateWeeklyInstructions,
  generateWeeklySlotCandidates,
  WeeklyPlanGenerationError,
} from "~/server/ai/weekly-plan-generation.server";
import { createScopedDatabase } from "~/server/context.server";
import {
  claimWeeklyGenerationJobForWork,
  getWeeklyGenerationJobForWorker,
  markWeeklyGenerationJobFailed,
  markWeeklyGenerationJobSucceeded,
  requeueWeeklyGenerationJob,
  type WeeklyGenerationJob,
} from "~/server/data/weekly-generation-jobs.server";
import {
  acceptWeeklyGenerationRun,
  appendWeeklyGenerationRunSlotCandidates,
  createReadyWeeklyGenerationRun,
  fingerprintWeeklyGenerationCandidates,
  fingerprintKitchenPreferences,
  fingerprintWeeklyGenerationCatalog,
  fingerprintWeeklyGenerationDietaryNotes,
  fingerprintWeeklyGenerationPantryBalances,
  getWeeklyGenerationRun,
  recordWeeklyGenerationFailure,
  releaseWeeklyGenerationBuild,
  releaseWeeklyGenerationRun,
  wasWeeklyGenerationSlotJobPublished,
  type WeeklyGenerationRun,
} from "~/server/data/weekly-generation.server";
import { getServerEnv } from "~/server/env.server";
import {
  loadWeeklyGenerationContext,
  shouldRetryWeeklyGenerationError,
  weeklyGenerationErrorMessage,
  weeklyGenerationFailureAudit,
  weeklyGenerationFailureReason,
  weeklyGenerationInputsMatch,
} from "~/server/jobs/weekly-generation-context.server";

const JOB_LEASE_MS = 20 * 60 * 1_000;
const MAX_JOB_DELIVERIES = 4;
const MAX_PROVIDER_DELIVERIES = 2;
const MAX_DISTINCTNESS_DELIVERIES = 2;
const DISTINCTNESS_VALIDATION_ISSUE_CODES = new Set([
  "DUPLICATE_TITLE",
  "DUPLICATE_CANDIDATE_TITLE",
  "RECENT_MEAL_REPEAT",
  "SIMILAR_CANDIDATE",
  "SIMILAR_CANDIDATE_POOL",
  "RESERVED_MEAL_REPEAT",
]);

type ProcessingResult = Readonly<{
  status: "already_terminal" | "busy" | "failed" | "retry_queued" | "succeeded";
}>;

class WeeklyGenerationJobTerminalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WeeklyGenerationJobTerminalError";
  }
}

function safeFailureCode(error: unknown): string {
  const candidate =
    error instanceof WeeklyGenerationJobTerminalError
      ? error.code
      : error instanceof WeeklyPlanGenerationError
        ? (error.providerFailureCode ?? error.code)
        : weeklyGenerationFailureReason(error);
  return candidate.replace(/[^a-z0-9_]/g, "_").slice(0, 64) || "unknown";
}

function safeFailureMessage(error: unknown): string {
  return weeklyGenerationErrorMessage(error)
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function isDistinctnessOnlyCandidateFailure(error: unknown): boolean {
  if (
    !(error instanceof WeeklyPlanGenerationError) ||
    error.code !== "invalid_model_output" ||
    error.phase !== "candidates" ||
    error.validationIssues.length === 0
  ) {
    return false;
  }
  return error.validationIssues.every((issue) =>
    DISTINCTNESS_VALIDATION_ISSUE_CODES.has(issue.split(":", 1)[0]!.trim()),
  );
}

function shouldRetryJob(
  error: unknown,
  deliveryCount: number,
  jobPhase: WeeklyGenerationJob["phase"],
): boolean {
  if (deliveryCount >= MAX_JOB_DELIVERIES) return false;
  if (error instanceof WeeklyGenerationJobTerminalError) return false;
  if (error instanceof WeeklyPlanGenerationError) {
    if (
      jobPhase === "candidates" &&
      deliveryCount < MAX_DISTINCTNESS_DELIVERIES &&
      isDistinctnessOnlyCandidateFailure(error)
    ) {
      return true;
    }
    return (
      deliveryCount < MAX_PROVIDER_DELIVERIES &&
      shouldRetryWeeklyGenerationError(error)
    );
  }
  return weeklyGenerationFailureReason(error) === "unknown";
}

async function generateCandidates(
  job: WeeklyGenerationJob,
  scoped: ReturnType<typeof createScopedDatabase>,
): Promise<string> {
  const existingRun = await getWeeklyGenerationRun(scoped, job.id);
  if (existingRun) return existingRun.id;

  const generationContext = await loadWeeklyGenerationContext(
    scoped,
    job.weekStartDate,
  );
  const env = getServerEnv();
  const generated = await generateWeeklyCandidates({
    catalog: generationContext.catalog,
    dietaryNotes: generationContext.dietaryNotes,
    model: createGoogleLanguageModel({
      apiKey: env.GOOGLE_VERTEX_API_KEY,
      modelId: env.AI_RECIPE_MODEL,
    }),
    preferenceMarkdown: generationContext.preferences.markdown,
    pantryInventory: generationContext.pantryInventory,
    recentHistory: generationContext.recentHistory,
    slots: generationContext.slots,
  });
  const selection = chooseWeeklyGenerationSelection(
    generated.candidates,
    generationContext.slots,
    generationContext.pantryInventory,
  );
  const after = await loadWeeklyGenerationContext(scoped, job.weekStartDate);
  if (
    fingerprintWeeklyGenerationCatalog(after.catalog) !==
      fingerprintWeeklyGenerationCatalog(generationContext.catalog) ||
    fingerprintWeeklyGenerationDietaryNotes(after.dietaryNotes) !==
      fingerprintWeeklyGenerationDietaryNotes(generationContext.dietaryNotes) ||
    fingerprintWeeklyGenerationPantryBalances(after.pantryBalances) !==
      fingerprintWeeklyGenerationPantryBalances(
        generationContext.pantryBalances,
      ) ||
    fingerprintKitchenPreferences(after.preferences.markdown) !==
      fingerprintKitchenPreferences(generationContext.preferences.markdown) ||
    JSON.stringify(after.slots) !== JSON.stringify(generationContext.slots)
  ) {
    throw new WeeklyGenerationJobTerminalError(
      "generation_inputs_changed",
      "Ingredients, pantry inventory, kitchen preferences, or household presence changed while this draft was being built. Generate the week again.",
    );
  }
  const run = await createReadyWeeklyGenerationRun(scoped, {
    attemptId: job.id,
    candidates: generated.candidates,
    catalogFingerprint: fingerprintWeeklyGenerationCatalog(
      generationContext.catalog,
    ),
    dietaryNotesFingerprint: fingerprintWeeklyGenerationDietaryNotes(
      generationContext.dietaryNotes,
    ),
    model: env.AI_RECIPE_MODEL,
    pantryFingerprint: fingerprintWeeklyGenerationPantryBalances(
      generationContext.pantryBalances,
    ),
    preferenceFingerprint: fingerprintKitchenPreferences(
      generationContext.preferences.markdown,
    ),
    selection,
    slots: generationContext.slots,
    usage: generated.usage,
    weekStartDate: job.weekStartDate,
  });
  return run.id;
}

async function generateSlotCandidates(
  job: WeeklyGenerationJob,
  scoped: ReturnType<typeof createScopedDatabase>,
): Promise<string> {
  if (!job.runId || !job.slotDate) {
    throw new WeeklyGenerationJobTerminalError(
      "invalid_job",
      "This dinner generation job is invalid.",
    );
  }
  if (await wasWeeklyGenerationSlotJobPublished(scoped, job.id)) {
    return job.runId;
  }

  const run = await getWeeklyGenerationRun(scoped, job.runId);
  if (!run) {
    throw new WeeklyGenerationJobTerminalError(
      "run_not_found",
      "This weekly draft was not found. Generate a fresh one.",
    );
  }
  if (run.status !== "ready" || run.expiresAt <= new Date()) {
    throw new WeeklyGenerationJobTerminalError(
      run.expiresAt <= new Date() ? "run_expired" : "run_not_ready",
      run.expiresAt <= new Date()
        ? "This weekly draft expired. Generate a fresh one."
        : "This weekly draft is not ready to change.",
    );
  }

  const before = await loadWeeklyGenerationContext(scoped, job.weekStartDate);
  if (
    !weeklyGenerationInputsMatch(run, {
      catalog: before.catalog,
      dietaryNotes: before.dietaryNotes,
      pantryBalances: before.pantryBalances,
      preferenceMarkdown: before.preferences.markdown,
      slots: before.slots,
    })
  ) {
    throw new WeeklyGenerationJobTerminalError(
      "generation_inputs_changed",
      "Ingredients, pantry inventory, kitchen preferences, or household presence changed after this draft was built. Generate a fresh week first.",
    );
  }
  const slot = before.slots.find(
    (candidate) => candidate.date === job.slotDate,
  );
  if (!slot) {
    throw new WeeklyGenerationJobTerminalError(
      "slot_not_found",
      "This dinner date is no longer part of the weekly draft.",
    );
  }
  const expectedCandidatesFingerprint = fingerprintWeeklyGenerationCandidates(
    run.candidates,
  );
  const env = getServerEnv();
  const generated = await generateWeeklySlotCandidates({
    catalog: before.catalog,
    dietaryNotes: before.dietaryNotes,
    existingCandidates: run.candidates,
    model: createGoogleLanguageModel({
      apiKey: env.GOOGLE_VERTEX_API_KEY,
      modelId: run.model,
    }),
    pantryInventory: before.pantryInventory,
    preferenceMarkdown: before.preferences.markdown,
    recentHistory: before.recentHistory,
    slot,
  });

  const after = await loadWeeklyGenerationContext(scoped, job.weekStartDate);
  if (
    !weeklyGenerationInputsMatch(run, {
      catalog: after.catalog,
      dietaryNotes: after.dietaryNotes,
      pantryBalances: after.pantryBalances,
      preferenceMarkdown: after.preferences.markdown,
      slots: after.slots,
    })
  ) {
    throw new WeeklyGenerationJobTerminalError(
      "generation_inputs_changed",
      "Ingredients, pantry inventory, kitchen preferences, or household presence changed while fresh dinner ideas were being created. Try again from the current draft.",
    );
  }
  const candidates = normalizeWeeklySlotCandidateBatch({
    candidates: generated.candidates,
    catalog: after.catalog,
    existingCandidates: run.candidates,
    slot,
    slots: after.slots,
  });
  await appendWeeklyGenerationRunSlotCandidates(scoped, {
    candidates,
    catalogFingerprint: run.catalogFingerprint,
    dietaryNotesFingerprint: run.dietaryNotesFingerprint,
    expectedCandidatesFingerprint,
    jobId: job.id,
    pantryFingerprint: fingerprintWeeklyGenerationPantryBalances(
      after.pantryBalances,
    ),
    preferenceFingerprint: run.preferenceFingerprint,
    runId: run.id,
    slotDate: slot.date,
    usage: generated.usage,
  });
  return run.id;
}

async function requireMaterializingRun(
  job: WeeklyGenerationJob,
  scoped: ReturnType<typeof createScopedDatabase>,
): Promise<WeeklyGenerationRun> {
  if (!job.runId) {
    throw new WeeklyGenerationJobTerminalError(
      "invalid_job",
      "This weekly generation job is invalid.",
    );
  }
  const run = await getWeeklyGenerationRun(scoped, job.runId);
  if (!run) {
    throw new WeeklyGenerationJobTerminalError(
      "run_not_found",
      "This weekly draft was not found. Generate a fresh one.",
    );
  }
  if (run.status === "accepted") return run;
  if (run.status !== "materializing") {
    throw new WeeklyGenerationJobTerminalError(
      "run_not_materializing",
      run.status === "ready"
        ? "This weekly draft is ready to try again."
        : "This weekly draft is no longer available to complete.",
    );
  }
  return run;
}

async function generateInstructions(
  job: WeeklyGenerationJob,
  scoped: ReturnType<typeof createScopedDatabase>,
): Promise<string> {
  const run = await requireMaterializingRun(job, scoped);
  if (run.status === "accepted") return run.id;

  const before = await loadWeeklyGenerationContext(scoped, job.weekStartDate);
  if (
    !weeklyGenerationInputsMatch(run, {
      catalog: before.catalog,
      dietaryNotes: before.dietaryNotes,
      pantryBalances: before.pantryBalances,
      preferenceMarkdown: before.preferences.markdown,
      slots: before.slots,
    })
  ) {
    throw new WeeklyGenerationJobTerminalError(
      "generation_inputs_changed",
      "Ingredients, pantry inventory, kitchen preferences, or household presence and servings changed after this draft was built. Generate a fresh week before accepting it.",
    );
  }

  const env = getServerEnv();
  const generated = await generateWeeklyInstructions({
    model: createGoogleLanguageModel({
      apiKey: env.GOOGLE_VERTEX_API_KEY,
      modelId: run.model,
    }),
    selectedCandidates: selectedWeeklyCandidates({
      candidates: run.candidates,
      selection: run.selection,
    }),
  });

  const after = await loadWeeklyGenerationContext(scoped, job.weekStartDate);
  if (
    !weeklyGenerationInputsMatch(run, {
      catalog: after.catalog,
      dietaryNotes: after.dietaryNotes,
      pantryBalances: after.pantryBalances,
      preferenceMarkdown: after.preferences.markdown,
      slots: after.slots,
    })
  ) {
    throw new WeeklyGenerationJobTerminalError(
      "generation_inputs_changed",
      "Ingredients, pantry inventory, kitchen preferences, or household presence and servings changed while recipes were being written. Generate a fresh week before accepting it.",
    );
  }

  await acceptWeeklyGenerationRun(scoped, {
    details: generated.recipes.map((recipe) => ({
      candidateKey: recipe.candidateKey,
      description: recipe.description,
      instructions: recipe.steps.map((step) => ({
        instruction: step.instruction,
        position: step.position,
      })),
    })),
    run,
    usage: generated.usage,
  });
  return run.id;
}

async function failJob(
  job: WeeklyGenerationJob,
  scoped: ReturnType<typeof createScopedDatabase>,
  error: unknown,
): Promise<void> {
  const failureCode = safeFailureCode(error);
  await recordWeeklyGenerationFailure(scoped, {
    attemptId: job.runId ?? job.id,
    ...weeklyGenerationFailureAudit(error),
    reason: weeklyGenerationFailureReason(error),
  }).catch(() => undefined);

  if (job.phase === "candidates") {
    await releaseWeeklyGenerationBuild(scoped, {
      attemptId: job.id,
      weekStartDate: job.weekStartDate,
    }).catch(() => undefined);
  } else if (job.phase === "instructions" && job.runId) {
    await releaseWeeklyGenerationRun(scoped, {
      failureCode,
      runId: job.runId,
    }).catch(() => undefined);
  }

  await markWeeklyGenerationJobFailed(scoped.db, {
    failureCode,
    failureMessage: safeFailureMessage(error),
    jobId: job.id,
  });
}

export async function processWeeklyGenerationJob(
  jobId: string,
): Promise<ProcessingResult> {
  const requestDatabase = createRequestDatabase();
  try {
    const current = await getWeeklyGenerationJobForWorker(
      requestDatabase.db,
      jobId,
    );
    if (!current) return { status: "already_terminal" };
    if (current.status === "failed" || current.status === "succeeded") {
      return { status: "already_terminal" };
    }

    const job = await claimWeeklyGenerationJobForWork(requestDatabase.db, {
      jobId,
      leaseMs: JOB_LEASE_MS,
    });
    if (!job) return { status: "busy" };
    const scoped = createScopedDatabase(requestDatabase.db, {
      householdId: job.householdId,
      userId: job.requestedByAppUserId,
    });

    console.info(
      JSON.stringify({
        deliveryCount: job.deliveryCount,
        jobId: job.id,
        phase: job.phase,
        status: "weekly_generation_job_started",
      }),
    );

    try {
      const runId =
        job.phase === "candidates"
          ? await generateCandidates(job, scoped)
          : job.phase === "slot_candidates"
            ? await generateSlotCandidates(job, scoped)
            : await generateInstructions(job, scoped);
      await markWeeklyGenerationJobSucceeded(requestDatabase.db, {
        jobId: job.id,
        runId,
      });
      console.info(
        JSON.stringify({
          deliveryCount: job.deliveryCount,
          jobId: job.id,
          phase: job.phase,
          status: "weekly_generation_job_succeeded",
        }),
      );
      return { status: "succeeded" };
    } catch (error) {
      if (shouldRetryJob(error, job.deliveryCount, job.phase)) {
        await requeueWeeklyGenerationJob(requestDatabase.db, { jobId: job.id });
        console.warn(
          JSON.stringify({
            deliveryCount: job.deliveryCount,
            jobId: job.id,
            phase: job.phase,
            status: "weekly_generation_job_retry_queued",
          }),
        );
        return { status: "retry_queued" };
      }
      await failJob(job, scoped, error);
      console.warn(
        JSON.stringify({
          deliveryCount: job.deliveryCount,
          failureCode: safeFailureCode(error),
          jobId: job.id,
          phase: job.phase,
          status: "weekly_generation_job_failed",
        }),
      );
      return { status: "failed" };
    }
  } finally {
    await requestDatabase.close();
  }
}
