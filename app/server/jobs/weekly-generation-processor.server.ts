import { createRequestDatabase } from "~/db/request-db.server";
import { chooseWeeklyGenerationSelection, selectedWeeklyCandidates } from "~/domain/weekly-generation";
import { createGoogleLanguageModel } from "~/server/ai/google-provider.server";
import {
  generateWeeklyCandidates,
  generateWeeklyInstructions,
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
  createReadyWeeklyGenerationRun,
  fingerprintKitchenPreferences,
  fingerprintWeeklyGenerationCatalog,
  fingerprintWeeklyGenerationDietaryNotes,
  getWeeklyGenerationRun,
  recordWeeklyGenerationFailure,
  releaseWeeklyGenerationBuild,
  releaseWeeklyGenerationRun,
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
        ? error.code
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

function shouldRetryJob(error: unknown, deliveryCount: number): boolean {
  if (deliveryCount >= MAX_JOB_DELIVERIES) return false;
  if (error instanceof WeeklyGenerationJobTerminalError) return false;
  if (error instanceof WeeklyPlanGenerationError) {
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
      apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
      modelId: env.AI_RECIPE_MODEL,
    }),
    preferenceMarkdown: generationContext.preferences.markdown,
    recentHistory: generationContext.recentHistory,
    slots: generationContext.slots,
  });
  const selection = chooseWeeklyGenerationSelection(
    generated.candidates,
    generationContext.slots,
  );
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
      preferenceMarkdown: before.preferences.markdown,
      slots: before.slots,
    })
  ) {
    throw new WeeklyGenerationJobTerminalError(
      "generation_inputs_changed",
      "Ingredients, kitchen preferences, or household presence and servings changed after this draft was built. Generate a fresh week before accepting it.",
    );
  }

  const env = getServerEnv();
  const generated = await generateWeeklyInstructions({
    model: createGoogleLanguageModel({
      apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
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
      preferenceMarkdown: after.preferences.markdown,
      slots: after.slots,
    })
  ) {
    throw new WeeklyGenerationJobTerminalError(
      "generation_inputs_changed",
      "Ingredients, kitchen preferences, or household presence and servings changed while recipes were being written. Generate a fresh week before accepting it.",
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
  } else if (job.runId) {
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
      if (shouldRetryJob(error, job.deliveryCount)) {
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
