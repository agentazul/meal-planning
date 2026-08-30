import { UsersRound } from "lucide-react";
import { useEffect } from "react";
import { data, Link, redirect, useRevalidator } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/plan-generate";
import { FormError } from "~/components/form-controls";
import { PageHeader } from "~/components/page-header";
import { WeeklyPlanDraft } from "~/components/weekly-plan-draft";
import { getWeekStartDate, parseDateOnly } from "~/domain/dates";
import {
  buildDefaultWeeklyGenerationSlots,
  selectedWeeklyCandidates,
} from "~/domain/weekly-generation";
import {
  requireIdentity,
  requireScopedDatabase,
  type ScopedDatabase,
} from "~/server/context.server";
import { getHouseholdKitchenPreferences } from "~/server/data/preferences.server";
import {
  createWeeklyGenerationJob,
  createOrGetActiveSlotGenerationJob,
  findLatestActiveInstructionJobForRun,
  findLatestActiveSlotGenerationJobForRun,
  getWeeklyGenerationJob,
  markWeeklyGenerationJobFailed,
} from "~/server/data/weekly-generation-jobs.server";
import {
  claimWeeklyGenerationRun,
  getLatestReadyWeeklyGenerationRun,
  getActiveWeeklyGenerationBuild,
  getWeeklyGenerationRun,
  releaseWeeklyGenerationRun,
  rerollWeeklyGenerationRunSlot,
  reserveWeeklyGenerationAttempt,
  releaseWeeklyGenerationBuild,
  selectWeeklyGenerationRunCandidate,
  WeeklyGenerationBuildBusyError,
  WeeklyGenerationRunError,
  type WeeklyGenerationRun,
} from "~/server/data/weekly-generation.server";
import { getWeekPlannerData } from "~/server/data/week.server";
import { dispatchWeeklyGenerationJob } from "~/server/jobs/weekly-generation-dispatch.server";

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    try {
      parseDateOnly(value);
      return true;
    } catch {
      return false;
    }
  });

const startFormSchema = z.strictObject({
  _intent: z.literal("start"),
  weekStart: dateOnlySchema,
});

const rerollFormSchema = z.strictObject({
  _intent: z.literal("reroll"),
  runId: z.uuid(),
  slotDate: dateOnlySchema,
  weekStart: dateOnlySchema,
});

const selectCandidateFormSchema = z.strictObject({
  _intent: z.literal("select-candidate"),
  candidateKey: z.string().regex(/^c\d{3}$/),
  runId: z.uuid(),
  slotDate: dateOnlySchema,
  weekStart: dateOnlySchema,
});

const regenerateSlotFormSchema = z.strictObject({
  _intent: z.literal("regenerate-slot"),
  runId: z.uuid(),
  slotDate: dateOnlySchema,
  weekStart: dateOnlySchema,
});

const acceptFormSchema = z.strictObject({
  _intent: z.literal("accept"),
  runId: z.uuid(),
  weekStart: dateOnlySchema,
});

const weeklyPlanFormSchema = z.discriminatedUnion("_intent", [
  startFormSchema,
  rerollFormSchema,
  selectCandidateFormSchema,
  regenerateSlotFormSchema,
  acceptFormSchema,
]);

type ActionResult = Readonly<{ error: string; ok: false }>;

export const meta: Route.MetaFunction = () => [
  { title: "AI weekly draft | Done For You Kitchen" },
  {
    name: "description",
    content:
      "Generate a five-dinner weekly draft from household presence and kitchen preferences.",
  },
];

function requireCanonicalWeekStart(value: string | undefined): string {
  const parsed = dateOnlySchema.safeParse(value);
  if (!parsed.success || getWeekStartDate(parsed.data) !== parsed.data) {
    throw new Response("The selected week must begin on a valid Sunday.", {
      status: 400,
    });
  }
  return parsed.data;
}

function errorResult(message: string, status = 400) {
  return data<ActionResult>({ error: message, ok: false }, { status });
}

function assertRunWeek(run: WeeklyGenerationRun, weekStart: string): void {
  if (run.weekStartDate !== weekStart) {
    throw new WeeklyGenerationRunError(
      "invalid",
      "This weekly draft belongs to a different week.",
    );
  }
}

export async function loader({ context, params, request }: Route.LoaderArgs) {
  requireIdentity(context);
  const scoped = requireScopedDatabase(context);
  const weekStart = requireCanonicalWeekStart(params.weekStart);
  const url = new URL(request.url);
  const requestedRunId = url.searchParams.get("run");
  const requestedJobId = url.searchParams.get("job");
  const requestedShuffledDate = url.searchParams.get("shuffled");
  const requestedSelectedDate = url.searchParams.get("selected");
  if (requestedRunId && !z.uuid().safeParse(requestedRunId).success) {
    throw new Response("The weekly draft identifier is invalid.", {
      status: 400,
    });
  }
  if (requestedJobId && !z.uuid().safeParse(requestedJobId).success) {
    throw new Response("The weekly generation job identifier is invalid.", {
      status: 400,
    });
  }

  const [week, preferences, activeBuild, requestedJob] = await Promise.all([
    getWeekPlannerData(scoped, weekStart),
    getHouseholdKitchenPreferences(scoped),
    getActiveWeeklyGenerationBuild(scoped, weekStart),
    requestedJobId
      ? getWeeklyGenerationJob(scoped, requestedJobId)
      : Promise.resolve(null),
  ]);

  if (requestedJobId && !requestedJob) {
    throw new Response("The weekly generation job was not found.", {
      status: 404,
    });
  }
  if (requestedJob && requestedJob.weekStartDate !== weekStart) {
    throw new Response("The weekly generation job belongs to another week.", {
      status: 400,
    });
  }
  if (
    requestedRunId &&
    requestedJob?.runId &&
    requestedJob.runId !== requestedRunId
  ) {
    throw new Response("The weekly generation job belongs to another draft.", {
      status: 400,
    });
  }

  const runIdFromRequest = requestedRunId ?? requestedJob?.runId ?? null;
  const requestedRun = runIdFromRequest
    ? await getWeeklyGenerationRun(scoped, runIdFromRequest)
    : requestedJob || activeBuild
      ? null
      : await getLatestReadyWeeklyGenerationRun(scoped, weekStart);

  if (runIdFromRequest && !requestedRun) {
    throw new Response("The weekly draft was not found.", { status: 404 });
  }
  if (requestedRun) assertRunWeek(requestedRun, weekStart);
  if (requestedRun?.status === "accepted") {
    throw redirect(`/?week=${weekStart}&generated=5`);
  }

  const run =
    requestedRun &&
    (requestedRun.status === "ready" ||
      requestedRun.status === "materializing") &&
    requestedRun.pantryFingerprint !== null &&
    requestedRun.expiresAt > new Date()
      ? requestedRun
      : null;
  const requestedJobIsActive =
    requestedJob?.status === "queued" || requestedJob?.status === "running";
  const activeInstructionJob =
    run?.status === "materializing" &&
    !(requestedJob?.phase === "instructions" && requestedJobIsActive)
      ? await findLatestActiveInstructionJobForRun(scoped, run.id)
      : null;
  const activeSlotJob =
    run && !(requestedJob?.phase === "slot_candidates" && requestedJobIsActive)
      ? await findLatestActiveSlotGenerationJobForRun(scoped, run.id)
      : requestedJob?.phase === "slot_candidates" && requestedJobIsActive
        ? requestedJob
        : null;
  const activeSave = run?.status === "materializing";
  const buildingCandidates =
    activeBuild !== null ||
    (requestedJob?.phase === "candidates" && requestedJobIsActive);
  const eligibleDinnerCount = week.days.filter(
    (day) => day.servingsTarget > 0,
  ).length;
  const canStartDraft = eligibleDinnerCount >= 5;
  const slots =
    run?.slots ??
    (canStartDraft
      ? buildDefaultWeeklyGenerationSlots(
          week.days.map((day) => ({
            date: day.date,
            demand: day.demand,
            servingsTarget: day.servingsTarget,
          })),
        )
      : []);
  const selectedCandidates = run
    ? selectedWeeklyCandidates({
        candidates: run.candidates,
        selection: run.selection,
      })
    : [];
  const shuffledDate =
    requestedShuffledDate &&
    dateOnlySchema.safeParse(requestedShuffledDate).success &&
    selectedCandidates.some(
      (candidate) => candidate.slotDate === requestedShuffledDate,
    )
      ? requestedShuffledDate
      : null;
  const selectedDate =
    requestedSelectedDate &&
    dateOnlySchema.safeParse(requestedSelectedDate).success &&
    selectedCandidates.some(
      (candidate) => candidate.slotDate === requestedSelectedDate,
    )
      ? requestedSelectedDate
      : null;
  const regeneratedDate =
    requestedJob?.phase === "slot_candidates" &&
    requestedJob.status === "succeeded" &&
    requestedJob.slotDate &&
    selectedCandidates.some(
      (candidate) => candidate.slotDate === requestedJob.slotDate,
    )
      ? requestedJob.slotDate
      : null;
  const slotDates = new Set(slots.map((slot) => slot.date));

  return {
    canStartDraft,
    activeBuild: buildingCandidates,
    activeSlotDate: activeSlotJob?.slotDate ?? null,
    activeSave,
    actionError:
      requestedJob?.status === "failed"
        ? requestedJob.phase === "slot_candidates"
          ? "We couldn't create new ideas for this night. Your current ideas are still here. Try again."
          : (requestedJob.failureMessage ??
            "Weekly generation is temporarily unavailable. Try again.")
        : null,
    draftNotice:
      (requestedJob?.phase === "candidates" &&
        requestedJob.status === "succeeded") ||
      url.searchParams.get("ready") === "1"
        ? ("ready" as const)
        : regeneratedDate
          ? ("regenerated" as const)
          : selectedDate || shuffledDate
            ? ("selected" as const)
            : null,
    eligibleDinnerCount,
    existingDinnerCount: week.days.filter(
      (day) => slotDates.has(day.date) && day.entry !== null,
    ).length,
    preferencesCustomized: !preferences.isStarter,
    allCandidates: run?.candidates ?? [],
    rerollHistory: run?.rerollHistory ?? {},
    runId: run?.id ?? null,
    selectedCandidates,
    selectionScore: run?.selection.score ?? null,
    changedDate: regeneratedDate ?? selectedDate ?? shuffledDate,
    shuffledDate,
    slots,
    polling:
      buildingCandidates ||
      activeSave ||
      activeInstructionJob?.status === "queued" ||
      activeInstructionJob?.status === "running" ||
      activeSlotJob?.status === "queued" ||
      activeSlotJob?.status === "running",
    weekStart,
  };
}

async function startWeeklyDraft(scoped: ScopedDatabase, weekStart: string) {
  let attemptId: string;
  try {
    ({ attemptId } = await reserveWeeklyGenerationAttempt(scoped, {
      weekStartDate: weekStart,
    }));
  } catch (error) {
    if (error instanceof WeeklyGenerationBuildBusyError) {
      return errorResult(
        "Someone else in your household is already building this week. This page will update when it is ready.",
        409,
      );
    }
    throw error;
  }

  let jobId: string | null = null;
  try {
    const job = await createWeeklyGenerationJob(scoped, {
      id: attemptId,
      phase: "candidates",
      weekStartDate: weekStart,
    });
    jobId = job.id;
    dispatchWeeklyGenerationJob(job.id);
    return redirect(`/plans/${weekStart}/generate?job=${job.id}#draft-review`);
  } catch (error) {
    if (jobId) {
      await markWeeklyGenerationJobFailed(scoped.db, {
        failureCode: "dispatch_failed",
        failureMessage:
          "Weekly generation is temporarily unavailable. Try again.",
        jobId,
      }).catch(() => undefined);
    }
    await releaseWeeklyGenerationBuild(scoped, {
      attemptId,
      weekStartDate: weekStart,
    }).catch(() => undefined);
    console.error(
      JSON.stringify({
        errorName: error instanceof Error ? error.name : "UnknownError",
        status: "weekly_generation_dispatch_failed",
      }),
    );
    return errorResult(
      "Weekly generation is temporarily unavailable. Try again.",
      502,
    );
  }
}

async function acceptWeeklyDraft(
  scoped: ScopedDatabase,
  weekStart: string,
  runId: string,
) {
  const found = await getWeeklyGenerationRun(scoped, runId);
  if (!found) {
    return errorResult(
      "This weekly draft was not found. Generate a fresh one.",
      404,
    );
  }
  try {
    assertRunWeek(found, weekStart);
    if (found.status === "accepted") {
      return redirect(`/?week=${weekStart}&generated=5`);
    }
    if (found.status === "materializing") {
      const activeJob = await findLatestActiveInstructionJobForRun(
        scoped,
        runId,
      );
      const jobQuery = activeJob ? `&job=${activeJob.id}` : "";
      return redirect(
        `/plans/${weekStart}/generate?run=${runId}${jobQuery}#draft-review`,
      );
    }

    await claimWeeklyGenerationRun(scoped, runId);
    let jobId: string | null = null;
    try {
      const job = await createWeeklyGenerationJob(scoped, {
        phase: "instructions",
        runId,
        weekStartDate: weekStart,
      });
      jobId = job.id;
      dispatchWeeklyGenerationJob(job.id);
      return redirect(
        `/plans/${weekStart}/generate?run=${runId}&job=${job.id}#draft-review`,
      );
    } catch (error) {
      if (jobId) {
        await markWeeklyGenerationJobFailed(scoped.db, {
          failureCode: "dispatch_failed",
          failureMessage:
            "Weekly generation is temporarily unavailable. Try again.",
          jobId,
        }).catch(() => undefined);
      }
      await releaseWeeklyGenerationRun(scoped, {
        failureCode: "instructions_dispatch_failed",
        runId,
      }).catch(() => undefined);
      console.error(
        JSON.stringify({
          errorName: error instanceof Error ? error.name : "UnknownError",
          runId,
          status: "weekly_generation_instructions_dispatch_failed",
        }),
      );
      return errorResult(
        "Weekly generation is temporarily unavailable. Try again.",
        502,
      );
    }
  } catch (error) {
    if (error instanceof WeeklyGenerationRunError) {
      return errorResult(error.message, 409);
    }
    throw error;
  }
}

async function regenerateWeeklyDraftSlot(
  scoped: ScopedDatabase,
  weekStart: string,
  input: Readonly<{ runId: string; slotDate: string }>,
) {
  const run = await getWeeklyGenerationRun(scoped, input.runId);
  if (!run) {
    return errorResult(
      "This weekly draft was not found. Generate a fresh one.",
      404,
    );
  }
  try {
    assertRunWeek(run, weekStart);
    if (
      run.status !== "ready" ||
      run.expiresAt <= new Date() ||
      run.pantryFingerprint === null
    ) {
      throw new WeeklyGenerationRunError(
        run.expiresAt <= new Date() ? "expired" : "busy",
        run.pantryFingerprint === null
          ? "Generate a fresh pantry-aware week before creating more dinner ideas."
          : run.expiresAt <= new Date()
            ? "This weekly draft expired. Generate a fresh one."
            : "This weekly draft is not ready to change.",
      );
    }
    if (!run.slots.some((slot) => slot.date === input.slotDate)) {
      throw new WeeklyGenerationRunError(
        "invalid",
        "That dinner date is not part of this weekly draft.",
      );
    }
    if (
      run.candidates.filter(
        (candidate) => candidate.slotDate === input.slotDate,
      ).length >= 12
    ) {
      throw new WeeklyGenerationRunError(
        "reroll_exhausted",
        "This dinner already has all 12 available ideas.",
      );
    }

    const job = await createOrGetActiveSlotGenerationJob(scoped, {
      runId: run.id,
      slotDate: input.slotDate,
      weekStartDate: weekStart,
    });
    try {
      dispatchWeeklyGenerationJob(job.id);
    } catch (error) {
      await markWeeklyGenerationJobFailed(scoped.db, {
        failureCode: "dispatch_failed",
        failureMessage:
          "Weekly generation is temporarily unavailable. Try again.",
        jobId: job.id,
      }).catch(() => undefined);
      console.error(
        JSON.stringify({
          errorName: error instanceof Error ? error.name : "UnknownError",
          jobId: job.id,
          runId: run.id,
          status: "weekly_generation_slot_dispatch_failed",
        }),
      );
      return errorResult(
        "Weekly generation is temporarily unavailable. Your current ideas are still here.",
        502,
      );
    }
    return redirect(
      `/plans/${weekStart}/generate?run=${run.id}&job=${job.id}#dinner-${job.slotDate ?? input.slotDate}`,
    );
  } catch (error) {
    if (error instanceof WeeklyGenerationRunError) {
      return errorResult(error.message, 409);
    }
    throw error;
  }
}

export async function action({ context, params, request }: Route.ActionArgs) {
  requireIdentity(context);
  const scoped = requireScopedDatabase(context);
  const weekStart = requireCanonicalWeekStart(params.weekStart);
  const parsed = weeklyPlanFormSchema.safeParse(
    Object.fromEntries(await request.formData()),
  );
  if (!parsed.success || parsed.data.weekStart !== weekStart) {
    return errorResult("The weekly draft request is invalid.");
  }

  if (parsed.data._intent === "start") {
    return startWeeklyDraft(scoped, weekStart);
  }
  if (parsed.data._intent === "accept") {
    return acceptWeeklyDraft(scoped, weekStart, parsed.data.runId);
  }
  if (parsed.data._intent === "regenerate-slot") {
    return regenerateWeeklyDraftSlot(scoped, weekStart, parsed.data);
  }

  try {
    const run = await getWeeklyGenerationRun(scoped, parsed.data.runId);
    if (!run) {
      return errorResult(
        "This weekly draft was not found. Generate a fresh one.",
        404,
      );
    }
    assertRunWeek(run, weekStart);
    if (parsed.data._intent === "select-candidate") {
      await selectWeeklyGenerationRunCandidate(scoped, {
        candidateKey: parsed.data.candidateKey,
        runId: parsed.data.runId,
        slotDate: parsed.data.slotDate,
      });
      return redirect(
        `/plans/${weekStart}/generate?run=${parsed.data.runId}&selected=${parsed.data.slotDate}#dinner-${parsed.data.slotDate}`,
      );
    }
    await rerollWeeklyGenerationRunSlot(scoped, {
      runId: parsed.data.runId,
      slotDate: parsed.data.slotDate,
    });
    return redirect(
      `/plans/${weekStart}/generate?run=${parsed.data.runId}&shuffled=${parsed.data.slotDate}#dinner-${parsed.data.slotDate}`,
    );
  } catch (error) {
    if (error instanceof WeeklyGenerationRunError) {
      return errorResult(error.message, 409);
    }
    throw error;
  }
}

export default function GenerateWeeklyPlan({
  actionData,
  loaderData,
}: Route.ComponentProps) {
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!loaderData.polling) return;
    const interval = window.setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [loaderData.polling, revalidator]);
  const visibleError = actionData?.error ?? loaderData.actionError;
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        actions={
          <Link
            className="button button-secondary"
            to={`/?week=${loaderData.weekStart}`}
          >
            Back to week
          </Link>
        }
        description={
          loaderData.runId
            ? "All five dinners are here. Revisit any generated idea or create three fresh choices for one night before you accept anything."
            : "Create a temporary draft, then review all five dinners on this same page. Nothing reaches your week or Recipe Library until you accept it."
        }
        eyebrow="Guided weekly planner"
        title={
          loaderData.runId
            ? "Review your dinner draft"
            : "Create your dinner options"
        }
      />

      {!loaderData.runId && !loaderData.canStartDraft ? (
        <section className="surface overflow-hidden">
          <div className="bg-herb p-6 text-paper-light sm:p-8">
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-butter">
              One quick setup step
            </p>
            <h2 className="m-0 text-3xl text-paper-light">
              Choose at least five dinner nights
            </h2>
            <p className="mt-3 mb-0 max-w-2xl leading-7 text-paper-light/75">
              This week currently has {loaderData.eligibleDinnerCount}{" "}
              {loaderData.eligibleDinnerCount === 1 ? "night" : "nights"} with
              someone Home. The weekly planner needs five so it can build a
              complete draft.
            </p>
          </div>
          <div className="grid gap-4 p-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="flex items-start gap-3">
              <UsersRound
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-herb"
                size={20}
              />
              <p className="m-0 text-sm leading-6 text-muted">
                Set each person's usual status or tap the dates they will be
                home. Serving counts update before generation starts.
              </p>
            </div>
            <Link
              className="button button-primary"
              to={`/presence?week=${loaderData.weekStart}`}
            >
              Set who is home
            </Link>
          </div>
          <div className="px-6 pb-6">
            <FormError>{visibleError}</FormError>
          </div>
        </section>
      ) : loaderData.runId && loaderData.selectionScore ? (
        <WeeklyPlanDraft
          actionError={visibleError}
          activeSlotDate={loaderData.activeSlotDate}
          allCandidates={loaderData.allCandidates}
          activeSave={loaderData.activeSave}
          changedDate={loaderData.changedDate}
          existingDinnerCount={loaderData.existingDinnerCount}
          preferencesCustomized={loaderData.preferencesCustomized}
          runId={loaderData.runId}
          selectedCandidates={loaderData.selectedCandidates}
          selectionScore={loaderData.selectionScore}
          slots={loaderData.slots}
          state="proposal"
          statusNotice={loaderData.draftNotice}
          weekStart={loaderData.weekStart}
        />
      ) : (
        <WeeklyPlanDraft
          actionError={visibleError}
          existingDinnerCount={loaderData.existingDinnerCount}
          preferencesCustomized={loaderData.preferencesCustomized}
          slots={loaderData.slots}
          state="initial"
          activeBuild={loaderData.activeBuild}
          weekStart={loaderData.weekStart}
        />
      )}
    </div>
  );
}
