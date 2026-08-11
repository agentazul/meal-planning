import { createHash } from "node:crypto";

import { data, Link, redirect } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/plan-generate";
import { FormError } from "~/components/form-controls";
import { PageHeader } from "~/components/page-header";
import { WeeklyPlanDraft } from "~/components/weekly-plan-draft";
import { getWeekStartDate, parseDateOnly } from "~/domain/dates";
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
  getWeeklyGenerationRun,
  listRecentCookedRecipeSummaries,
  recordWeeklyGenerationFailure,
  releaseWeeklyGenerationRun,
  rerollWeeklyGenerationRunSlot,
  reserveWeeklyGenerationAttempt,
  WeeklyGenerationRateLimitError,
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
): readonly string[] {
  return normalizeWeeklyGenerationDietaryNotes(
    members.flatMap((member) =>
      member.dietaryNotes === null ? [] : [member.dietaryNotes],
    ),
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
    dietaryNotes: anonymousDietaryNotes(members),
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
    if (error.code === "invalid_input" || error.code === "invalid_model_output") {
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
      return weeklyGenerationInvalidOutputMessage(error.phase);
    }
    return error.message;
  }
  if (error instanceof WeeklyGenerationValidationError) {
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
  if (requestedRunId && !z.uuid().safeParse(requestedRunId).success) {
    throw new Response("The weekly draft identifier is invalid.", { status: 400 });
  }

  const [week, preferences, requestedRun] = await Promise.all([
    getWeekPlannerData(scoped, weekStart),
    getHouseholdKitchenPreferences(scoped),
    requestedRunId
      ? getWeeklyGenerationRun(scoped, requestedRunId)
      : getLatestReadyWeeklyGenerationRun(scoped, weekStart),
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
  const slots =
    run?.slots ??
    buildDefaultWeeklyGenerationSlots(
      week.days.map((day) => ({
        date: day.date,
        demand: day.demand,
        servingsTarget: day.servingsTarget,
      })),
    );
  const selectedCandidates = run
    ? selectedWeeklyCandidates({
        candidates: run.candidates,
        selection: run.selection,
      })
    : [];
  const slotDates = new Set(slots.map((slot) => slot.date));

  return {
    existingDinnerCount: week.days.filter(
      (day) => slotDates.has(day.date) && day.entry !== null,
    ).length,
    preferencesCustomized: !preferences.isStarter,
    rerollHistory: run?.rerollHistory ?? {},
    runId: run?.id ?? null,
    selectedCandidates,
    selectionScore: run?.selection.score ?? null,
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
    ({ attemptId } = await reserveWeeklyGenerationAttempt(scoped));
  } catch (error) {
    if (error instanceof WeeklyGenerationRateLimitError) {
      return data<ActionResult>(
        {
          error:
            error.code === "user_hour"
              ? "Two weekly drafts were already generated this hour. Try again later."
              : "This household has reached today's weekly draft limit. Try again tomorrow.",
          ok: false,
        },
        {
          headers: { "Retry-After": String(error.retryAfterSeconds) },
          status: 429,
        },
      );
    }
    throw error;
  }

  try {
    const context = await loadGenerationContext(scoped, weekStart);
    const model = getServerEnv().AI_RECIPE_MODEL;
    const generated = await generateWeeklyCandidates({
      abortSignal: request.signal,
      catalog: context.catalog,
      dietaryNotes: context.dietaryNotes,
      gateway: {
        tags: ["app:dfy-kitchen"],
        user: gatewayUser(scoped),
      },
      model,
      preferenceMarkdown: context.preferences.markdown,
      recentHistory: context.recentHistory,
      slots: context.slots,
    });
    const selection = chooseWeeklyGenerationSelection(
      generated.candidates,
      context.slots,
    );
    const run = await createReadyWeeklyGenerationRun(scoped, {
      attemptId,
      candidates: generated.candidates,
      catalogFingerprint: fingerprintWeeklyGenerationCatalog(context.catalog),
      dietaryNotesFingerprint: fingerprintWeeklyGenerationDietaryNotes(
        context.dietaryNotes,
      ),
      model,
      preferenceFingerprint: fingerprintKitchenPreferences(
        context.preferences.markdown,
      ),
      selection,
      slots: context.slots,
      usage: generated.usage,
      weekStartDate: weekStart,
    });
    return redirect(`/plans/${weekStart}/generate?run=${run.id}`);
  } catch (error) {
    await recordWeeklyGenerationFailure(scoped, {
      attemptId,
      ...generationFailureAudit(error),
      reason: generationFailureReason(error),
    }).catch(() => undefined);
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
    return errorResult("This weekly draft was not found. Generate a fresh one.", 404);
  }
  try {
    assertRunWeek(found, weekStart);
    if (found.status === "accepted") {
      return redirect(`/?week=${weekStart}&generated=1`);
    }
    const run = await claimWeeklyGenerationRun(scoped, runId);
    const weekEnd = parseDateOnly(weekStart).add({ days: 6 }).toString();
    const [preferences, references, week, members] = await Promise.all([
      getHouseholdKitchenPreferences(scoped),
      listIngredientReferences(scoped),
      getWeekPlannerData(scoped, weekStart),
      listPresenceMembers(scoped, { from: weekStart, to: weekEnd }),
    ]);
    const catalog = createCatalog(references);
    const currentSlots = buildDefaultWeeklyGenerationSlots(
      week.days.map((day) => ({
        date: day.date,
        demand: day.demand,
        servingsTarget: day.servingsTarget,
      })),
    );
    if (
      !weeklyGenerationInputsMatch(run, {
        catalog,
        dietaryNotes: anonymousDietaryNotes(members),
        preferenceMarkdown: preferences.markdown,
        slots: currentSlots,
      })
    ) {
      await releaseWeeklyGenerationRun(scoped, {
        failureCode: "generation_inputs_changed",
        runId,
      });
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
          dietaryNotes: anonymousDietaryNotes(latestMembers),
          preferenceMarkdown: latestPreferences.markdown,
          slots: latestSlots,
        })
      ) {
        await releaseWeeklyGenerationRun(scoped, {
          failureCode: "generation_inputs_changed",
          runId,
        });
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
      await releaseWeeklyGenerationRun(scoped, {
        failureCode:
          error instanceof WeeklyPlanGenerationError
            ? `instructions_${error.code}`
            : "instructions_unknown",
        runId,
      });
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
      `/plans/${weekStart}/generate?run=${parsed.data.runId}`,
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
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        actions={
          <Link className="button button-secondary" to={`/?week=${loaderData.weekStart}`}>
            Back to week
          </Link>
        }
        description="Your household schedule and kitchen preferences set the boundaries. AI creates the options, then you decide what belongs on the calendar."
        eyebrow="AI weekly planner"
        title="A five-dinner draft, made for this week."
      />

      <FormError>{actionData?.error}</FormError>
      {loaderData.runId && loaderData.selectionScore ? (
        <WeeklyPlanDraft
          existingDinnerCount={loaderData.existingDinnerCount}
          preferencesCustomized={loaderData.preferencesCustomized}
          rerollHistory={loaderData.rerollHistory}
          runId={loaderData.runId}
          selectedCandidates={loaderData.selectedCandidates}
          selectionScore={loaderData.selectionScore}
          slots={loaderData.slots}
          state="proposal"
          weekStart={loaderData.weekStart}
        />
      ) : (
        <WeeklyPlanDraft
          existingDinnerCount={loaderData.existingDinnerCount}
          preferencesCustomized={loaderData.preferencesCustomized}
          slots={loaderData.slots}
          state="initial"
          weekStart={loaderData.weekStart}
        />
      )}
    </div>
  );
}
