import { createHash } from "node:crypto";

import { UsersRound } from "lucide-react";
import { useEffect } from "react";
import { data, Link, redirect, useRevalidator } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/plan-generate";
import { FormError } from "~/components/form-controls";
import { PageHeader } from "~/components/page-header";
import { WeeklyPlanDraft } from "~/components/weekly-plan-draft";
import { getWeekStartDate, parseDateOnly } from "~/domain/dates";
import { resolvePresence } from "~/domain/presence";
import { weeklyGenerationInvalidOutputMessage } from "~/domain/weekly-generation-error-copy";
import {
  buildDefaultWeeklyGenerationSlots,
  buildWeeklyGenerationCatalog,
  chooseWeeklyGenerationSelection,
  normalizeWeeklyGenerationDietaryNotes,
  selectedWeeklyCandidates,
  WeeklyGenerationValidationError,
  type WeeklyGenerationCatalogEntry,
} from "~/domain/weekly-generation";
import {
  generateWeeklyCandidates,
  generateWeeklyInstructions,
  WeeklyPlanGenerationError,
} from "~/server/ai/weekly-plan-generation.server";
import {
  requireIdentity,
  requireScopedDatabase,
  type ScopedDatabase,
} from "~/server/context.server";
import { listPresenceMembers } from "~/server/data/presence.server";
import { getHouseholdKitchenPreferences } from "~/server/data/preferences.server";
import { listIngredientReferences } from "~/server/data/recipes.server";
import {
  acceptWeeklyGenerationRun,
  claimWeeklyGenerationRun,
  createReadyWeeklyGenerationRun,
  fingerprintKitchenPreferences,
  fingerprintWeeklyGenerationCatalog,
  fingerprintWeeklyGenerationDietaryNotes,
  getLatestReadyWeeklyGenerationRun,
  getActiveWeeklyGenerationBuild,
  getWeeklyGenerationRun,
  listRecentCookedRecipeSummaries,
  recordWeeklyGenerationFailure,
  releaseWeeklyGenerationRun,
  rerollWeeklyGenerationRunSlot,
  reserveWeeklyGenerationAttempt,
  releaseWeeklyGenerationBuild,
  WeeklyGenerationBuildBusyError,
  WeeklyGenerationBuildStaleError,
  WeeklyGenerationRunError,
  type WeeklyGenerationRun,
} from "~/server/data/weekly-generation.server";
import { getWeekPlannerData } from "~/server/data/week.server";
import { getServerEnv } from "~/server/env.server";

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

const acceptFormSchema = z.strictObject({
  _intent: z.literal("accept"),
  runId: z.uuid(),
  weekStart: dateOnlySchema,
});

const weeklyPlanFormSchema = z.discriminatedUnion("_intent", [
  startFormSchema,
  rerollFormSchema,
  acceptFormSchema,
]);

type ActionResult = Readonly<{ error: string; ok: false }>;

const weeklyPresenceRequirementMessage =
  "Choose at least five dinner nights with someone Home before building a weekly draft.";

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

function createCatalog(
  references: Awaited<ReturnType<typeof listIngredientReferences>>,
): readonly WeeklyGenerationCatalogEntry[] {
  return buildWeeklyGenerationCatalog(
    references.map((ingredient) => ({
      baseUnit: ingredient.baseUnit,
      category: ingredient.category,
      densityGramsPerMl: ingredient.densityGramsPerMl,
      gramsPerCount: ingredient.gramsPerCount,
      id: ingredient.id,
      isStaple: ingredient.isStaple,
      name: ingredient.name,
    })),
  );
}

function gatewayUser(scoped: ScopedDatabase): string {
  return createHash("sha256")
    .update("done-for-you-kitchen:gateway-user:v1\0")
    .update(scoped.scope.userId)
    .digest("base64url")
    .slice(0, 43);
}

function anonymousDietaryNotes(
  members: Awaited<ReturnType<typeof listPresenceMembers>>,
  slotDates: readonly string[],
): readonly string[] {
  return normalizeWeeklyGenerationDietaryNotes(
    members.flatMap((member) => {
      if (member.dietaryNotes === null) return [];
      const joinsAtLeastOneDinner = slotDates.some(
        (date) =>
          resolvePresence({
            date,
            defaultIsPresent: member.defaultIsPresent,
            overrides: member.overrides,
            rules: member.rules,
          }).isPresent,
      );
      return joinsAtLeastOneDinner ? [member.dietaryNotes] : [];
    }),
  );
}

async function loadGenerationContext(
  scoped: ScopedDatabase,
  weekStart: string,
) {
  const weekEnd = parseDateOnly(weekStart).add({ days: 6 }).toString();
  const [week, preferences, references, members, recentHistory] =
    await Promise.all([
      getWeekPlannerData(scoped, weekStart),
      getHouseholdKitchenPreferences(scoped),
      listIngredientReferences(scoped),
      listPresenceMembers(scoped, { from: weekStart, to: weekEnd }),
      listRecentCookedRecipeSummaries(scoped, weekStart),
    ]);
  const slots = buildDefaultWeeklyGenerationSlots(
    week.days.map((day) => ({
      date: day.date,
      demand: day.demand,
      servingsTarget: day.servingsTarget,
    })),
  );

  return {
    catalog: createCatalog(references),
    dietaryNotes: anonymousDietaryNotes(
      members,
      slots.map((slot) => slot.date),
    ),
    preferences,
    recentHistory,
    slots,
    week,
  };
}

function generationFailureReason(
  error: unknown,
): "provider" | "timeout" | "validation" | "unknown" {
  if (error instanceof WeeklyGenerationValidationError) return "validation";
  if (error instanceof WeeklyPlanGenerationError) {
    if (
      error.code === "invalid_input" ||
      error.code === "invalid_model_output"
    ) {
      return "validation";
    }
    if (error.code === "request_cancelled") return "timeout";
    return "provider";
  }
  return "unknown";
}

function generationFailureAudit(error: unknown) {
  return error instanceof WeeklyPlanGenerationError
    ? {
        attemptCount: error.attemptCount,
        batch: error.batch,
        code: error.code,
        phase: error.phase,
        validationIssues: error.validationIssues,
      }
    : {};
}

function generationErrorMessage(error: unknown): string {
  if (error instanceof WeeklyPlanGenerationError) {
    if (error.code === "request_cancelled") {
      return "Weekly generation was interrupted. Try again when you are ready.";
    }
    if (error.code === "invalid_model_output") {
      return weeklyGenerationInvalidOutputMessage(
        error.phase,
        error.validationIssues,
      );
    }
    return error.message;
  }
  if (error instanceof WeeklyGenerationValidationError) {
    if (error.code === "INVALID_SLOTS") {
      return weeklyPresenceRequirementMessage;
    }
    return "The AI draft did not pass the recipe safety checks. Try generating the week again.";
  }
  return "Weekly generation is temporarily unavailable. Try again.";
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

function weeklyGenerationSlotsMatch(
  left: WeeklyGenerationRun["slots"],
  right: WeeklyGenerationRun["slots"],
): boolean {
  return (
    left.length === right.length &&
    left.every((slot, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        slot.date === other.date &&
        slot.effortTier === other.effortTier &&
        slot.maxActiveTimeMinutes === other.maxActiveTimeMinutes &&
        slot.servingsTarget === other.servingsTarget &&
        slot.slotKey === other.slotKey
      );
    })
  );
}

function weeklyGenerationInputsMatch(
  run: WeeklyGenerationRun,
  input: Readonly<{
    catalog: readonly WeeklyGenerationCatalogEntry[];
    dietaryNotes: readonly string[];
    preferenceMarkdown: string;
    slots: WeeklyGenerationRun["slots"];
  }>,
): boolean {
  return (
    fingerprintWeeklyGenerationCatalog(input.catalog) ===
      run.catalogFingerprint &&
    fingerprintWeeklyGenerationDietaryNotes(input.dietaryNotes) ===
      run.dietaryNotesFingerprint &&
    fingerprintKitchenPreferences(input.preferenceMarkdown) ===
      run.preferenceFingerprint &&
    weeklyGenerationSlotsMatch(run.slots, input.slots)
  );
}

export async function loader({ context, params, request }: Route.LoaderArgs) {
  requireIdentity(context);
  const scoped = requireScopedDatabase(context);
  const weekStart = requireCanonicalWeekStart(params.weekStart);
  const url = new URL(request.url);
  const requestedRunId = url.searchParams.get("run");
  const requestedShuffledDate = url.searchParams.get("shuffled");
  if (requestedRunId && !z.uuid().safeParse(requestedRunId).success) {
    throw new Response("The weekly draft identifier is invalid.", {
      status: 400,
    });
  }

  const [week, preferences, requestedRun, activeBuild] = await Promise.all([
    getWeekPlannerData(scoped, weekStart),
    getHouseholdKitchenPreferences(scoped),
    requestedRunId
      ? getWeeklyGenerationRun(scoped, requestedRunId)
      : getLatestReadyWeeklyGenerationRun(scoped, weekStart),
    getActiveWeeklyGenerationBuild(scoped, weekStart),
  ]);

  if (requestedRunId && !requestedRun) {
    throw new Response("The weekly draft was not found.", { status: 404 });
  }
  if (requestedRun) assertRunWeek(requestedRun, weekStart);
  if (requestedRun?.status === "accepted") {
    throw redirect(`/?week=${weekStart}&generated=1`);
  }

  const run =
    requestedRun?.status === "ready" && requestedRun.expiresAt > new Date()
      ? requestedRun
      : null;
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
  const slotDates = new Set(slots.map((slot) => slot.date));

  return {
    canStartDraft,
    activeBuild: activeBuild !== null,
    draftNotice:
      url.searchParams.get("ready") === "1"
        ? ("ready" as const)
        : shuffledDate
          ? ("shuffled" as const)
          : null,
    eligibleDinnerCount,
    existingDinnerCount: week.days.filter(
      (day) => slotDates.has(day.date) && day.entry !== null,
    ).length,
    preferencesCustomized: !preferences.isStarter,
    rerollHistory: run?.rerollHistory ?? {},
    runId: run?.id ?? null,
    selectedCandidates,
    selectionScore: run?.selection.score ?? null,
    shuffledDate,
    slots,
    weekStart,
  };
}

async function startWeeklyDraft(
  scoped: ScopedDatabase,
  request: Request,
  weekStart: string,
) {
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

  let generationContext: Awaited<ReturnType<typeof loadGenerationContext>>;
  try {
    generationContext = await loadGenerationContext(scoped, weekStart);
  } catch (error) {
    if (
      error instanceof WeeklyGenerationValidationError &&
      error.code === "INVALID_SLOTS"
    ) {
      await releaseWeeklyGenerationBuild(scoped, {
        attemptId,
        weekStartDate: weekStart,
      }).catch(() => undefined);
      return errorResult(weeklyPresenceRequirementMessage);
    }
    await releaseWeeklyGenerationBuild(scoped, {
      attemptId,
      weekStartDate: weekStart,
    }).catch(() => undefined);
    throw error;
  }

  try {
    const model = getServerEnv().AI_RECIPE_MODEL;
    const generated = await generateWeeklyCandidates({
      abortSignal: request.signal,
      catalog: generationContext.catalog,
      dietaryNotes: generationContext.dietaryNotes,
      gateway: {
        tags: ["app:dfy-kitchen"],
        user: gatewayUser(scoped),
      },
      model,
      preferenceMarkdown: generationContext.preferences.markdown,
      recentHistory: generationContext.recentHistory,
      slots: generationContext.slots,
    });
    const selection = chooseWeeklyGenerationSelection(
      generated.candidates,
      generationContext.slots,
    );
    const run = await createReadyWeeklyGenerationRun(scoped, {
      attemptId,
      candidates: generated.candidates,
      catalogFingerprint: fingerprintWeeklyGenerationCatalog(
        generationContext.catalog,
      ),
      dietaryNotesFingerprint: fingerprintWeeklyGenerationDietaryNotes(
        generationContext.dietaryNotes,
      ),
      model,
      preferenceFingerprint: fingerprintKitchenPreferences(
        generationContext.preferences.markdown,
      ),
      selection,
      slots: generationContext.slots,
      usage: generated.usage,
      weekStartDate: weekStart,
    });
    return redirect(
      `/plans/${weekStart}/generate?run=${run.id}&ready=1#draft-review`,
    );
  } catch (error) {
    await recordWeeklyGenerationFailure(scoped, {
      attemptId,
      ...generationFailureAudit(error),
      reason: generationFailureReason(error),
    }).catch(() => undefined);
    await releaseWeeklyGenerationBuild(scoped, {
      attemptId,
      weekStartDate: weekStart,
    }).catch(() => undefined);
    if (error instanceof WeeklyGenerationBuildStaleError) {
      return errorResult(
        "The active build changed before this draft could be published. Refresh to see the latest draft, then try again if needed.",
        409,
      );
    }
    return errorResult(generationErrorMessage(error), 502);
  }
}

async function acceptWeeklyDraft(
  scoped: ScopedDatabase,
  request: Request,
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
  let claimed = false;
  let released = false;
  const releaseClaimedRun = async (failureCode: string) => {
    if (!claimed || released) {
      return;
    }
    await releaseWeeklyGenerationRun(scoped, { failureCode, runId });
    released = true;
  };
  try {
    assertRunWeek(found, weekStart);
    if (found.status === "accepted") {
      return redirect(`/?week=${weekStart}&generated=1`);
    }
    const run = await claimWeeklyGenerationRun(scoped, runId);
    claimed = true;
    const weekEnd = parseDateOnly(weekStart).add({ days: 6 }).toString();
    const [preferences, references, week, members] = await Promise.all([
      getHouseholdKitchenPreferences(scoped),
      listIngredientReferences(scoped),
      getWeekPlannerData(scoped, weekStart),
      listPresenceMembers(scoped, { from: weekStart, to: weekEnd }),
    ]);
    const catalog = createCatalog(references);
    let currentSlots: ReturnType<typeof buildDefaultWeeklyGenerationSlots>;
    try {
      currentSlots = buildDefaultWeeklyGenerationSlots(
        week.days.map((day) => ({
          date: day.date,
          demand: day.demand,
          servingsTarget: day.servingsTarget,
        })),
      );
    } catch (error) {
      await releaseClaimedRun("generation_inputs_changed");
      if (
        error instanceof WeeklyGenerationValidationError &&
        error.code === "INVALID_SLOTS"
      ) {
        return errorResult(
          "Who is Home changed after this draft was built. Choose at least five dinner nights, then build a fresh draft.",
          409,
        );
      }
      throw error;
    }
    if (
      !weeklyGenerationInputsMatch(run, {
        catalog,
        dietaryNotes: anonymousDietaryNotes(
          members,
          currentSlots.map((slot) => slot.date),
        ),
        preferenceMarkdown: preferences.markdown,
        slots: currentSlots,
      })
    ) {
      await releaseClaimedRun("generation_inputs_changed");
      return errorResult(
        "Ingredients, kitchen preferences, or household presence and servings changed after this draft was built. Generate a fresh week before accepting it.",
        409,
      );
    }

    try {
      const selected = selectedWeeklyCandidates({
        candidates: run.candidates,
        selection: run.selection,
      });
      const generated = await generateWeeklyInstructions({
        abortSignal: request.signal,
        gateway: {
          tags: ["app:dfy-kitchen"],
          user: gatewayUser(scoped),
        },
        model: run.model,
        selectedCandidates: selected,
      });
      const [latestPreferences, latestReferences, latestWeek, latestMembers] =
        await Promise.all([
          getHouseholdKitchenPreferences(scoped),
          listIngredientReferences(scoped),
          getWeekPlannerData(scoped, weekStart),
          listPresenceMembers(scoped, { from: weekStart, to: weekEnd }),
        ]);
      const latestSlots = buildDefaultWeeklyGenerationSlots(
        latestWeek.days.map((day) => ({
          date: day.date,
          demand: day.demand,
          servingsTarget: day.servingsTarget,
        })),
      );
      if (
        !weeklyGenerationInputsMatch(run, {
          catalog: createCatalog(latestReferences),
          dietaryNotes: anonymousDietaryNotes(
            latestMembers,
            latestSlots.map((slot) => slot.date),
          ),
          preferenceMarkdown: latestPreferences.markdown,
          slots: latestSlots,
        })
      ) {
        await releaseClaimedRun("generation_inputs_changed");
        return errorResult(
          "Ingredients, kitchen preferences, or household presence and servings changed while recipes were being written. Generate a fresh week before accepting it.",
          409,
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
      return redirect(`/?week=${weekStart}&generated=5`);
    } catch (error) {
      await releaseClaimedRun(
        error instanceof WeeklyPlanGenerationError
          ? `instructions_${error.code}`
          : "instructions_unknown",
      );
      if (error instanceof WeeklyPlanGenerationError) {
        await recordWeeklyGenerationFailure(scoped, {
          attemptId: runId,
          ...generationFailureAudit(error),
          reason: generationFailureReason(error),
        }).catch(() => undefined);
      }
      return error instanceof WeeklyGenerationRunError
        ? errorResult(error.message, 409)
        : errorResult(generationErrorMessage(error), 502);
    }
  } catch (error) {
    await releaseClaimedRun("acceptance_unknown").catch(() => undefined);
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
    return startWeeklyDraft(scoped, request, weekStart);
  }
  if (parsed.data._intent === "accept") {
    return acceptWeeklyDraft(scoped, request, weekStart, parsed.data.runId);
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
    if (!loaderData.activeBuild) return;
    const interval = window.setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [loaderData.activeBuild, revalidator]);
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
            ? "All five options are here. Shuffle one dinner at a time and watch the combined ingredient list update before you accept anything."
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
            <FormError>{actionData?.error}</FormError>
          </div>
        </section>
      ) : loaderData.runId && loaderData.selectionScore ? (
        <WeeklyPlanDraft
          actionError={actionData?.error ?? null}
          existingDinnerCount={loaderData.existingDinnerCount}
          preferencesCustomized={loaderData.preferencesCustomized}
          rerollHistory={loaderData.rerollHistory}
          runId={loaderData.runId}
          selectedCandidates={loaderData.selectedCandidates}
          selectionScore={loaderData.selectionScore}
          shuffledDate={loaderData.shuffledDate}
          slots={loaderData.slots}
          state="proposal"
          statusNotice={loaderData.draftNotice}
          weekStart={loaderData.weekStart}
        />
      ) : (
        <WeeklyPlanDraft
          actionError={actionData?.error ?? null}
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
