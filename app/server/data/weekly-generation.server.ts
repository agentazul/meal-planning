import { createHash, randomUUID } from "node:crypto";

import { Temporal } from "@js-temporal/polyfill";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  gt,
  inArray,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import {
  eventLogs,
  mealPlans,
  planEntries,
  recipeIngredients,
  recipes,
  weeklyGenerationRuns,
} from "~/db/schema";
import {
  createWeeklyGenerationRerollHistory,
  normalizeWeeklyGenerationDietaryNotes,
  normalizedWeeklyCandidatePoolSchema,
  rerollWeeklyGenerationSlot,
  selectedWeeklyCandidates,
  weeklyGenerationRerollHistorySchema,
  weeklyGenerationSelectionSchema,
  weeklyGenerationSlotsSchema,
  type NormalizedWeeklyCandidate,
  type WeeklyGenerationCatalogEntry,
  type WeeklyGenerationRerollHistory,
  type WeeklyGenerationSelection,
  type WeeklyGenerationSlot,
} from "~/domain/weekly-generation";
import type { ScopedDatabase } from "~/server/context.server";
import { withRecipeIngredientPositions } from "~/server/data/recipes.server";

const RUN_LIFETIME_MS = 2 * 60 * 60 * 1_000;
const USER_RUN_LIMIT = 2;
const USER_RUN_WINDOW_SECONDS = 60 * 60;
const HOUSEHOLD_RUN_LIMIT = 6;
const HOUSEHOLD_RUN_WINDOW_SECONDS = 24 * 60 * 60;

export const WEEKLY_GENERATION_EVENT_TYPES = {
  accepted: "plan.generation_accepted",
  candidatesReady: "plan.generation_candidates_ready",
  failed: "plan.generation_failed",
  requested: "plan.generation_requested",
  rerolled: "plan.generation_rerolled",
} as const;

export const weeklyGenerationRunIdSchema = z.uuid();

export const weeklyGenerationUsageSchema = z.strictObject({
  inputTokens: z.number().int().min(0).max(10_000_000),
  outputTokens: z.number().int().min(0).max(10_000_000),
  totalTokens: z.number().int().min(0).max(20_000_000),
});

const weeklyGenerationFailureAuditSchema = z.strictObject({
  attemptCount: z.number().int().min(0).max(10).nullable(),
  batch: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9:_-]+$/)
    .nullable(),
  code: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/)
    .nullable(),
  phase: z.enum(["candidates", "instructions"]).nullable(),
  validationIssues: z
    .array(z.string().trim().min(1).max(240).regex(/^[\x20-\x7e]+$/))
    .max(6),
});

export type WeeklyGenerationUsage = z.infer<typeof weeklyGenerationUsageSchema>;

export type WeeklyGeneratedRecipeDetails = Readonly<{
  candidateKey: string;
  description: string | null;
  instructions: readonly Readonly<{
    instruction: string;
    position: number;
  }>[];
}>;

export type WeeklyGenerationRun = Readonly<{
  acceptedAt: Date | null;
  candidates: readonly NormalizedWeeklyCandidate[];
  catalogFingerprint: string;
  createdAt: Date;
  dietaryNotesFingerprint: string;
  expiresAt: Date;
  failureCode: string | null;
  id: string;
  mealPlanId: string | null;
  model: string;
  preferenceFingerprint: string;
  rerollHistory: WeeklyGenerationRerollHistory;
  requestedByAppUserId: string;
  selection: WeeklyGenerationSelection;
  slots: readonly WeeklyGenerationSlot[];
  status: "accepted" | "failed" | "materializing" | "ready" | "superseded";
  usage: WeeklyGenerationUsage;
  weekStartDate: string;
}>;

export type RecentRecipeSummary = Readonly<{
  cuisine: string | null;
  primaryProtein: string | null;
  techniques: readonly string[];
  title: string;
}>;

export class WeeklyGenerationRateLimitError extends Error {
  override readonly name = "WeeklyGenerationRateLimitError";

  constructor(
    readonly code: "household_day" | "user_hour",
    readonly retryAfterSeconds: number,
  ) {
    super(
      code === "user_hour"
        ? "Too many weekly generation requests for this user."
        : "Too many weekly generation requests for this household.",
    );
  }
}

export class WeeklyGenerationRunError extends Error {
  override readonly name = "WeeklyGenerationRunError";

  constructor(
    readonly code:
      | "already_accepted"
      | "busy"
      | "expired"
      | "invalid"
      | "not_found"
      | "reroll_exhausted",
    message: string,
  ) {
    super(message);
  }
}

function fingerprint(value: unknown, context: string): string {
  return createHash("sha256")
    .update(context)
    .update(JSON.stringify(value))
    .digest("base64url");
}

export function fingerprintWeeklyGenerationCatalog(
  catalog: readonly WeeklyGenerationCatalogEntry[],
): string {
  return fingerprint(
    [...catalog]
      .sort((left, right) => left.catalogKey.localeCompare(right.catalogKey))
      .map((entry) => ({
        baseUnit: entry.baseUnit,
        catalogKey: entry.catalogKey,
        category: entry.category,
        densityGramsPerMl: entry.densityGramsPerMl,
        gramsPerCount: entry.gramsPerCount,
        id: entry.id,
        isStaple: entry.isStaple,
        name: entry.name,
        requiredMinimumInternalTemperatureF:
          entry.requiredMinimumInternalTemperatureF,
      })),
    "done-for-you-kitchen:weekly-catalog:v1\0",
  );
}

export function fingerprintKitchenPreferences(markdown: string): string {
  return fingerprint(
    markdown.replace(/\r\n?/g, "\n").trim(),
    "done-for-you-kitchen:kitchen-preferences:v1\0",
  );
}

export function fingerprintWeeklyGenerationDietaryNotes(
  notes: readonly string[],
): string {
  return fingerprint(
    normalizeWeeklyGenerationDietaryNotes(notes),
    "done-for-you-kitchen:weekly-dietary-notes:v1\0",
  );
}

function parseRun(row: typeof weeklyGenerationRuns.$inferSelect): WeeklyGenerationRun {
  const candidates = normalizedWeeklyCandidatePoolSchema.safeParse(row.candidates);
  const slots = weeklyGenerationSlotsSchema.safeParse(row.slots);
  const selection = weeklyGenerationSelectionSchema.safeParse(row.selection);
  const history = weeklyGenerationRerollHistorySchema.safeParse(
    row.rerollHistory,
  );
  const usage = weeklyGenerationUsageSchema.safeParse(row.usage);
  if (
    !candidates.success ||
    !slots.success ||
    !selection.success ||
    !history.success ||
    !usage.success
  ) {
    throw new WeeklyGenerationRunError(
      "invalid",
      "The saved weekly generation draft is malformed.",
    );
  }

  return {
    acceptedAt: row.acceptedAt,
    candidates: candidates.data,
    catalogFingerprint: row.catalogFingerprint,
    createdAt: row.createdAt,
    dietaryNotesFingerprint: row.dietaryNotesFingerprint,
    expiresAt: row.expiresAt,
    failureCode: row.failureCode,
    id: row.id,
    mealPlanId: row.mealPlanId,
    model: row.model,
    preferenceFingerprint: row.preferenceFingerprint,
    rerollHistory: history.data,
    requestedByAppUserId: row.requestedByAppUserId,
    selection: selection.data,
    slots: slots.data,
    status: row.status,
    usage: usage.data,
    weekStartDate: row.weekStartDate,
  };
}

export async function reserveWeeklyGenerationAttempt(
  scoped: ScopedDatabase,
): Promise<Readonly<{ attemptId: string }>> {
  return scoped.db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`weekly-generation-household:${scoped.scope.householdId}`}, 0))`,
    );

    const [userUsage] = await transaction
      .select({ value: count() })
      .from(eventLogs)
      .where(
        and(
          eq(eventLogs.householdId, scoped.scope.householdId),
          eq(eventLogs.eventType, WEEKLY_GENERATION_EVENT_TYPES.requested),
          gte(eventLogs.createdAt, sql`now() - interval '1 hour'`),
          sql`${eventLogs.payload} ->> 'userId' = ${scoped.scope.userId}`,
        ),
      )
      .limit(1);
    if ((userUsage?.value ?? 0) >= USER_RUN_LIMIT) {
      throw new WeeklyGenerationRateLimitError(
        "user_hour",
        USER_RUN_WINDOW_SECONDS,
      );
    }

    const [householdUsage] = await transaction
      .select({ value: count() })
      .from(eventLogs)
      .where(
        and(
          eq(eventLogs.householdId, scoped.scope.householdId),
          eq(eventLogs.eventType, WEEKLY_GENERATION_EVENT_TYPES.requested),
          gte(eventLogs.createdAt, sql`now() - interval '24 hours'`),
        ),
      )
      .limit(1);
    if ((householdUsage?.value ?? 0) >= HOUSEHOLD_RUN_LIMIT) {
      throw new WeeklyGenerationRateLimitError(
        "household_day",
        HOUSEHOLD_RUN_WINDOW_SECONDS,
      );
    }

    const attemptId = randomUUID();
    await transaction.insert(eventLogs).values({
      eventType: WEEKLY_GENERATION_EVENT_TYPES.requested,
      householdId: scoped.scope.householdId,
      payload: { attemptId, userId: scoped.scope.userId },
    });
    return { attemptId };
  });
}

export async function createReadyWeeklyGenerationRun(
  scoped: ScopedDatabase,
  input: Readonly<{
    attemptId: string;
    candidates: readonly NormalizedWeeklyCandidate[];
    catalogFingerprint: string;
    dietaryNotesFingerprint: string;
    model: string;
    preferenceFingerprint: string;
    selection: WeeklyGenerationSelection;
    slots: readonly WeeklyGenerationSlot[];
    usage: WeeklyGenerationUsage;
    weekStartDate: string;
  }>,
): Promise<WeeklyGenerationRun> {
  const id = weeklyGenerationRunIdSchema.parse(input.attemptId);
  const candidates = normalizedWeeklyCandidatePoolSchema.parse(input.candidates);
  const slots = weeklyGenerationSlotsSchema.parse(input.slots);
  const selection = weeklyGenerationSelectionSchema.parse(input.selection);
  const usage = weeklyGenerationUsageSchema.parse(input.usage);
  const rerollHistory = createWeeklyGenerationRerollHistory(selection);

  return scoped.db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`weekly-generation-week:${scoped.scope.householdId}:${input.weekStartDate}`}, 0))`,
    );
    await transaction
      .update(weeklyGenerationRuns)
      .set({ status: "superseded" })
      .where(
        and(
          eq(weeklyGenerationRuns.householdId, scoped.scope.householdId),
          eq(weeklyGenerationRuns.weekStartDate, input.weekStartDate),
          eq(weeklyGenerationRuns.status, "ready"),
        ),
      );

    const [created] = await transaction
      .insert(weeklyGenerationRuns)
      .values({
        candidates,
        catalogFingerprint: input.catalogFingerprint,
        dietaryNotesFingerprint: input.dietaryNotesFingerprint,
        expiresAt: new Date(Date.now() + RUN_LIFETIME_MS),
        householdId: scoped.scope.householdId,
        id,
        model: input.model,
        preferenceFingerprint: input.preferenceFingerprint,
        requestedByAppUserId: scoped.scope.userId,
        rerollHistory,
        selection,
        slots,
        status: "ready",
        usage,
        weekStartDate: input.weekStartDate,
      })
      .returning();
    if (!created) throw new Error("Weekly generation draft was not created.");

    await transaction.insert(eventLogs).values({
      eventType: WEEKLY_GENERATION_EVENT_TYPES.candidatesReady,
      householdId: scoped.scope.householdId,
      payload: {
        attemptId: id,
        candidateCount: candidates.length,
        model: input.model,
        selectedCount: selection.items.length,
        usage,
        userId: scoped.scope.userId,
        weekStartDate: input.weekStartDate,
      },
    });
    return parseRun(created);
  });
}

export async function recordWeeklyGenerationFailure(
  scoped: ScopedDatabase,
  input: Readonly<{
    attemptCount?: number;
    attemptId: string;
    batch?: string | null;
    code?: string;
    phase?: "candidates" | "instructions";
    reason: "configuration" | "provider" | "timeout" | "validation" | "unknown";
    validationIssues?: readonly string[];
  }>,
): Promise<void> {
  const attemptId = weeklyGenerationRunIdSchema.parse(input.attemptId);
  const audit = weeklyGenerationFailureAuditSchema.parse({
    attemptCount: input.attemptCount ?? null,
    batch: input.batch ?? null,
    code: input.code ?? null,
    phase: input.phase ?? null,
    validationIssues: input.validationIssues ?? [],
  });
  await scoped.db.insert(eventLogs).values({
    eventType: WEEKLY_GENERATION_EVENT_TYPES.failed,
    householdId: scoped.scope.householdId,
    payload: {
      attemptId,
      ...audit,
      reason: input.reason,
      userId: scoped.scope.userId,
    },
  });
}

export async function getWeeklyGenerationRun(
  scoped: ScopedDatabase,
  runIdInput: string,
): Promise<WeeklyGenerationRun | null> {
  const runId = weeklyGenerationRunIdSchema.parse(runIdInput);
  const [row] = await scoped.db
    .select()
    .from(weeklyGenerationRuns)
    .where(
      and(
        eq(weeklyGenerationRuns.householdId, scoped.scope.householdId),
        eq(weeklyGenerationRuns.id, runId),
      ),
    )
    .limit(1);
  return row ? parseRun(row) : null;
}

export async function getLatestReadyWeeklyGenerationRun(
  scoped: ScopedDatabase,
  weekStartDate: string,
): Promise<WeeklyGenerationRun | null> {
  const [row] = await scoped.db
    .select()
    .from(weeklyGenerationRuns)
    .where(
      and(
        eq(weeklyGenerationRuns.householdId, scoped.scope.householdId),
        eq(weeklyGenerationRuns.weekStartDate, weekStartDate),
        eq(weeklyGenerationRuns.status, "ready"),
        gte(weeklyGenerationRuns.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(weeklyGenerationRuns.createdAt))
    .limit(1);
  return row ? parseRun(row) : null;
}

export async function rerollWeeklyGenerationRunSlot(
  scoped: ScopedDatabase,
  input: Readonly<{ runId: string; slotDate: string }>,
): Promise<WeeklyGenerationRun> {
  const runId = weeklyGenerationRunIdSchema.parse(input.runId);
  return scoped.db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`weekly-generation-run:${runId}`}, 0))`,
    );
    const [row] = await transaction
      .select()
      .from(weeklyGenerationRuns)
      .where(
        and(
          eq(weeklyGenerationRuns.householdId, scoped.scope.householdId),
          eq(weeklyGenerationRuns.id, runId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new WeeklyGenerationRunError("not_found", "Weekly draft not found.");
    }
    const run = parseRun(row);
    if (run.status !== "ready") {
      throw new WeeklyGenerationRunError(
        run.status === "accepted" ? "already_accepted" : "busy",
        run.status === "accepted"
          ? "This weekly draft has already been accepted."
          : "This weekly draft is not ready to change.",
      );
    }
    if (run.expiresAt <= new Date()) {
      throw new WeeklyGenerationRunError(
        "expired",
        "This weekly draft expired. Generate a fresh one.",
      );
    }

    const rerolled = rerollWeeklyGenerationSlot({
      candidates: run.candidates,
      history: run.rerollHistory,
      selection: run.selection,
      slotDate: input.slotDate,
    });
    if (!rerolled) {
      throw new WeeklyGenerationRunError(
        "reroll_exhausted",
        "All generated alternatives for this night have been reviewed.",
      );
    }

    const [updated] = await transaction
      .update(weeklyGenerationRuns)
      .set({
        failureCode: null,
        rerollHistory: rerolled.history,
        selection: rerolled.selection,
      })
      .where(
        and(
          eq(weeklyGenerationRuns.householdId, scoped.scope.householdId),
          eq(weeklyGenerationRuns.id, runId),
          eq(weeklyGenerationRuns.status, "ready"),
        ),
      )
      .returning();
    if (!updated) {
      throw new WeeklyGenerationRunError(
        "busy",
        "This weekly draft changed in another request.",
      );
    }
    await transaction.insert(eventLogs).values({
      eventType: WEEKLY_GENERATION_EVENT_TYPES.rerolled,
      householdId: scoped.scope.householdId,
      payload: {
        attemptId: runId,
        slotDate: input.slotDate,
        userId: scoped.scope.userId,
      },
    });
    return parseRun(updated);
  });
}

export async function claimWeeklyGenerationRun(
  scoped: ScopedDatabase,
  runIdInput: string,
): Promise<WeeklyGenerationRun> {
  const runId = weeklyGenerationRunIdSchema.parse(runIdInput);
  return scoped.db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`weekly-generation-run:${runId}`}, 0))`,
    );
    const [row] = await transaction
      .select()
      .from(weeklyGenerationRuns)
      .where(
        and(
          eq(weeklyGenerationRuns.householdId, scoped.scope.householdId),
          eq(weeklyGenerationRuns.id, runId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new WeeklyGenerationRunError("not_found", "Weekly draft not found.");
    }
    const run = parseRun(row);
    if (run.status === "accepted") {
      throw new WeeklyGenerationRunError(
        "already_accepted",
        "This weekly draft has already been accepted.",
      );
    }
    if (run.status !== "ready") {
      throw new WeeklyGenerationRunError(
        "busy",
        "This weekly draft is already being completed.",
      );
    }
    if (run.expiresAt <= new Date()) {
      throw new WeeklyGenerationRunError(
        "expired",
        "This weekly draft expired. Generate a fresh one.",
      );
    }
    const [claimed] = await transaction
      .update(weeklyGenerationRuns)
      .set({ failureCode: null, status: "materializing" })
      .where(
        and(
          eq(weeklyGenerationRuns.householdId, scoped.scope.householdId),
          eq(weeklyGenerationRuns.id, runId),
          eq(weeklyGenerationRuns.status, "ready"),
        ),
      )
      .returning();
    if (!claimed) {
      throw new WeeklyGenerationRunError(
        "busy",
        "This weekly draft changed in another request.",
      );
    }
    return parseRun(claimed);
  });
}

export async function releaseWeeklyGenerationRun(
  scoped: ScopedDatabase,
  input: Readonly<{ failureCode: string; runId: string }>,
): Promise<void> {
  const runId = weeklyGenerationRunIdSchema.parse(input.runId);
  await scoped.db
    .update(weeklyGenerationRuns)
    .set({
      failureCode: input.failureCode.slice(0, 100),
      status: "ready",
    })
    .where(
      and(
        eq(weeklyGenerationRuns.householdId, scoped.scope.householdId),
        eq(weeklyGenerationRuns.id, runId),
        eq(weeklyGenerationRuns.status, "materializing"),
      ),
    );
}

export async function listRecentCookedRecipeSummaries(
  scoped: ScopedDatabase,
  weekStartDate: string,
): Promise<readonly RecentRecipeSummary[]> {
  const cutoff = Temporal.PlainDate.from(weekStartDate)
    .subtract({ days: 21 })
    .toString();
  const rows = await scoped.db
    .selectDistinct({
      cuisine: recipes.cuisine,
      primaryProtein: recipes.primaryProtein,
      techniques: recipes.techniques,
      title: recipes.title,
    })
    .from(recipes)
    .leftJoin(
      planEntries,
      and(
        eq(planEntries.householdId, recipes.householdId),
        eq(planEntries.recipeId, recipes.id),
      ),
    )
    .where(
      and(
        eq(recipes.householdId, scoped.scope.householdId),
        or(
          gte(recipes.lastCookedAt, cutoff),
          and(
            eq(planEntries.status, "cooked"),
            isNotNull(planEntries.scheduledDate),
            gte(planEntries.scheduledDate, cutoff),
          ),
        ),
      ),
    )
    .orderBy(asc(recipes.title));
  return rows;
}

export async function acceptWeeklyGenerationRun(
  scoped: ScopedDatabase,
  input: Readonly<{
    details: readonly WeeklyGeneratedRecipeDetails[];
    run: WeeklyGenerationRun;
    usage: WeeklyGenerationUsage;
  }>,
): Promise<Readonly<{ mealPlanId: string; recipeIds: readonly string[] }>> {
  const detailsByKey = new Map(
    input.details.map((details) => [details.candidateKey, details]),
  );
  const usage = weeklyGenerationUsageSchema.parse(input.usage);
  const selected = selectedWeeklyCandidates({
    candidates: input.run.candidates,
    selection: input.run.selection,
  });
  if (
    input.details.length !== selected.length ||
    detailsByKey.size !== selected.length ||
    selected.some((candidate) => !detailsByKey.has(candidate.candidateKey))
  ) {
    throw new WeeklyGenerationRunError(
      "invalid",
      "Generated instructions do not match the selected weekly recipes.",
    );
  }

  return scoped.db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`weekly-generation-run:${input.run.id}`}, 0))`,
    );
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`weekly-generation-week:${scoped.scope.householdId}:${input.run.weekStartDate}`}, 0))`,
    );
    const [current] = await transaction
      .select()
      .from(weeklyGenerationRuns)
      .where(
        and(
          eq(weeklyGenerationRuns.householdId, scoped.scope.householdId),
          eq(weeklyGenerationRuns.id, input.run.id),
        ),
      )
      .limit(1);
    if (!current) {
      throw new WeeklyGenerationRunError("not_found", "Weekly draft not found.");
    }
    if (current.status !== "materializing") {
      throw new WeeklyGenerationRunError(
        current.status === "accepted" ? "already_accepted" : "busy",
        current.status === "accepted"
          ? "This weekly draft has already been accepted."
          : "This weekly draft is not ready to complete.",
      );
    }
    const [newerRun] = await transaction
      .select({ id: weeklyGenerationRuns.id })
      .from(weeklyGenerationRuns)
      .where(
        and(
          eq(weeklyGenerationRuns.householdId, scoped.scope.householdId),
          eq(weeklyGenerationRuns.weekStartDate, input.run.weekStartDate),
          gt(weeklyGenerationRuns.createdAt, current.createdAt),
          inArray(weeklyGenerationRuns.status, [
            "ready",
            "materializing",
            "accepted",
          ]),
        ),
      )
      .orderBy(desc(weeklyGenerationRuns.createdAt))
      .limit(1);
    if (newerRun) {
      throw new WeeklyGenerationRunError(
        "busy",
        "A newer weekly draft is available for this week.",
      );
    }

    const [existingPlan] = await transaction
      .select({ id: mealPlans.id })
      .from(mealPlans)
      .where(
        and(
          eq(mealPlans.householdId, scoped.scope.householdId),
          eq(mealPlans.weekStartDate, input.run.weekStartDate),
        ),
      )
      .limit(1);
    let mealPlanId = existingPlan?.id;
    if (!mealPlanId) {
      const [createdPlan] = await transaction
        .insert(mealPlans)
        .values({
          householdId: scoped.scope.householdId,
          status: "draft",
          weekStartDate: input.run.weekStartDate,
        })
        .onConflictDoNothing({
          target: [mealPlans.householdId, mealPlans.weekStartDate],
        })
        .returning({ id: mealPlans.id });
      mealPlanId = createdPlan?.id;
      if (!mealPlanId) {
        const [concurrentPlan] = await transaction
          .select({ id: mealPlans.id })
          .from(mealPlans)
          .where(
            and(
              eq(mealPlans.householdId, scoped.scope.householdId),
              eq(mealPlans.weekStartDate, input.run.weekStartDate),
            ),
          )
          .limit(1);
        mealPlanId = concurrentPlan?.id;
      }
    }
    if (!mealPlanId) throw new Error("Meal plan was not created.");

    const existingEntries = await transaction
      .select({ id: planEntries.id, scheduledDate: planEntries.scheduledDate })
      .from(planEntries)
      .where(
        and(
          eq(planEntries.householdId, scoped.scope.householdId),
          eq(planEntries.mealPlanId, mealPlanId),
          inArray(
            planEntries.scheduledDate,
            selected.map((candidate) => candidate.slotDate),
          ),
        ),
      );
    const entryByDate = new Map(
      existingEntries.flatMap((entry) =>
        entry.scheduledDate ? [[entry.scheduledDate, entry] as const] : [],
      ),
    );

    const recipeIds: string[] = [];
    for (const candidate of selected) {
      const details = detailsByKey.get(candidate.candidateKey);
      if (!details) throw new Error("Generated recipe details are missing.");
      const [createdRecipe] = await transaction
        .insert(recipes)
        .values({
          activeTimeMinutes: candidate.activeTimeMinutes,
          baseServings: candidate.baseServings,
          cuisine: candidate.cuisine,
          description: details.description,
          effortTier: candidate.effortTier,
          householdId: scoped.scope.householdId,
          instructions: details.instructions,
          minInternalTemperatureF: candidate.minInternalTemperatureF,
          primaryProtein: candidate.primaryProtein,
          source: "generated",
          techniques: [...candidate.techniques],
          title: candidate.title,
          totalTimeMinutes: candidate.totalTimeMinutes,
        })
        .returning({ id: recipes.id });
      if (!createdRecipe) throw new Error("Generated recipe was not created.");
      recipeIds.push(createdRecipe.id);

      await transaction.insert(recipeIngredients).values(
        withRecipeIngredientPositions(candidate.ingredients).map(
          (ingredient) => ({
            canonicalIngredientId: ingredient.canonicalIngredientId,
            householdId: scoped.scope.householdId,
            isOptional: ingredient.isOptional,
            position: ingredient.position,
            preparation: ingredient.preparation,
            quantity: ingredient.quantity.toFixed(3),
            quantityInBaseUnit: ingredient.quantityInBaseUnit.toFixed(3),
            recipeId: createdRecipe.id,
            scalesLinearly: ingredient.scalesLinearly,
            unit: ingredient.unit,
          }),
        ),
      );

      const slot = input.run.slots.find(
        (candidateSlot) => candidateSlot.date === candidate.slotDate,
      );
      if (!slot) throw new Error("Generated dinner slot is missing.");
      const existingEntry = entryByDate.get(candidate.slotDate);
      if (existingEntry) {
        await transaction
          .update(planEntries)
          .set({
            benchRank: null,
            leftoverBufferServings: 0,
            recipeId: createdRecipe.id,
            servingsTarget: slot.servingsTarget,
            status: "planned",
          })
          .where(
            and(
              eq(planEntries.householdId, scoped.scope.householdId),
              eq(planEntries.id, existingEntry.id),
            ),
          );
      } else {
        await transaction.insert(planEntries).values({
          householdId: scoped.scope.householdId,
          leftoverBufferServings: 0,
          mealPlanId,
          recipeId: createdRecipe.id,
          scheduledDate: candidate.slotDate,
          servingsTarget: slot.servingsTarget,
          status: "planned",
        });
      }
      await transaction.insert(eventLogs).values({
        eventType: "recipe.created",
        householdId: scoped.scope.householdId,
        payload: {
          ingredientCount: candidate.ingredients.length,
          recipeId: createdRecipe.id,
          source: "generated",
          weeklyGenerationRunId: input.run.id,
        },
      });
    }

    const acceptedAt = new Date();
    const [accepted] = await transaction
      .update(weeklyGenerationRuns)
      .set({
        acceptedAt,
        failureCode: null,
        mealPlanId,
        status: "accepted",
        usage: {
          inputTokens: input.run.usage.inputTokens + usage.inputTokens,
          outputTokens: input.run.usage.outputTokens + usage.outputTokens,
          totalTokens: input.run.usage.totalTokens + usage.totalTokens,
        },
      })
      .where(
        and(
          eq(weeklyGenerationRuns.householdId, scoped.scope.householdId),
          eq(weeklyGenerationRuns.id, input.run.id),
          eq(weeklyGenerationRuns.status, "materializing"),
        ),
      )
      .returning({ id: weeklyGenerationRuns.id });
    if (!accepted) {
      throw new WeeklyGenerationRunError(
        "busy",
        "This weekly draft changed before it could be saved.",
      );
    }
    await transaction
      .update(weeklyGenerationRuns)
      .set({ status: "superseded" })
      .where(
        and(
          eq(weeklyGenerationRuns.householdId, scoped.scope.householdId),
          eq(weeklyGenerationRuns.weekStartDate, input.run.weekStartDate),
          eq(weeklyGenerationRuns.status, "ready"),
        ),
      );
    await transaction.insert(eventLogs).values({
      eventType: WEEKLY_GENERATION_EVENT_TYPES.accepted,
      householdId: scoped.scope.householdId,
      payload: {
        attemptId: input.run.id,
        mealPlanId,
        recipeCount: recipeIds.length,
        recipeIds,
        userId: scoped.scope.userId,
        weekStartDate: input.run.weekStartDate,
      },
    });
    return { mealPlanId, recipeIds };
  });
}
