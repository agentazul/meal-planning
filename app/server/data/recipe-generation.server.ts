import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { eventLogs } from "~/db/schema";
import type { ScopedDatabase } from "~/server/context.server";

export const RECIPE_GENERATION_EVENT_TYPES = {
  failed: "recipe.generation_failed",
  requested: "recipe.generation_requested",
  succeeded: "recipe.generation_succeeded",
} as const;

export const recipeGenerationAttemptIdSchema = z.uuid();

const modelNameSchema = z.string().trim().min(1).max(200);
const completionMetricsSchema = z
  .object({
    attemptCount: z.number().int().min(1).max(10),
    durationMs: z.number().int().min(0).max(1_800_000),
  })
  .strict();
const attemptCountSchema = z.number().int().min(0).max(10);
const durationMsSchema = z.number().int().min(0).max(1_800_000);
const tokenUsageSchema = z
  .object({
    inputTokens: z.number().int().min(0).max(10_000_000),
    outputTokens: z.number().int().min(0).max(10_000_000),
    totalTokens: z.number().int().min(0).max(20_000_000),
  })
  .strict();
const failureReasonSchema = z.enum([
  "configuration",
  "provider",
  "timeout",
  "validation",
  "unknown",
]);

export type RecipeGenerationFailureReason =
  | "configuration"
  | "provider"
  | "timeout"
  | "validation"
  | "unknown";

export type SuccessfulRecipeGenerationAttempt = Readonly<{
  attemptId: string;
  model: string;
}>;

export type RecipeGenerationTokenUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}>;

export class RecipeGenerationAttemptError extends Error {
  override readonly name = "RecipeGenerationAttemptError";

  constructor(
    readonly code:
      | "already_completed"
      | "already_saved"
      | "invalid_attempt"
      | "not_found"
      | "not_successful",
  ) {
    super(
      code === "not_found"
        ? "Recipe generation attempt was not found."
        : code === "not_successful"
          ? "Recipe generation attempt has not succeeded."
          : code === "already_saved"
            ? "Recipe generation attempt was already saved."
            : code === "already_completed"
              ? "Recipe generation attempt was already completed."
              : "Recipe generation attempt is invalid.",
    );
  }
}

function parseAttemptId(value: string): string {
  const parsed = recipeGenerationAttemptIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new RecipeGenerationAttemptError("invalid_attempt");
  }
  return parsed.data;
}

function parseModelName(value: string): string {
  const parsed = modelNameSchema.safeParse(value);
  if (!parsed.success) {
    throw new RecipeGenerationAttemptError("invalid_attempt");
  }
  return parsed.data;
}

function parseCompletionMetrics(input: Readonly<{
  attemptCount: number;
  durationMs: number;
}>): Readonly<{ attemptCount: number; durationMs: number }> {
  const parsed = completionMetricsSchema.safeParse(input);
  if (!parsed.success) {
    throw new RecipeGenerationAttemptError("invalid_attempt");
  }
  return parsed.data;
}

function parseTokenUsage(
  input: RecipeGenerationTokenUsage,
): RecipeGenerationTokenUsage {
  const parsed = tokenUsageSchema.safeParse(input);
  if (!parsed.success) {
    throw new RecipeGenerationAttemptError("invalid_attempt");
  }
  return parsed.data;
}

function payloadString(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

async function lockHouseholdGeneration(
  transaction: Parameters<
    Parameters<ScopedDatabase["db"]["transaction"]>[0]
  >[0],
  householdId: string,
): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`recipe-generation-household:${householdId}`}, 0))`,
  );
}

async function lockGenerationAttempt(
  transaction: Parameters<
    Parameters<ScopedDatabase["db"]["transaction"]>[0]
  >[0],
  attemptId: string,
): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`recipe-generation-attempt:${attemptId}`}, 0))`,
  );
}

export async function reserveRecipeGenerationAttempt(
  scoped: ScopedDatabase,
): Promise<Readonly<{ attemptId: string }>> {
  return scoped.db.transaction(async (transaction) => {
    await lockHouseholdGeneration(transaction, scoped.scope.householdId);

    const attemptId = randomUUID();
    await transaction.insert(eventLogs).values({
      eventType: RECIPE_GENERATION_EVENT_TYPES.requested,
      householdId: scoped.scope.householdId,
      payload: {
        attemptId,
        userId: scoped.scope.userId,
      },
    });

    return { attemptId };
  });
}

type AttemptEvent = Readonly<{
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
}>;

async function listAttemptEvents(
  transaction: Parameters<
    Parameters<ScopedDatabase["db"]["transaction"]>[0]
  >[0],
  householdId: string,
  userId: string,
  attemptId: string,
): Promise<readonly AttemptEvent[]> {
  return transaction
    .select({
      eventType: eventLogs.eventType,
      payload: eventLogs.payload,
    })
    .from(eventLogs)
    .where(
      and(
        eq(eventLogs.householdId, householdId),
        inArray(eventLogs.eventType, [
          RECIPE_GENERATION_EVENT_TYPES.requested,
          RECIPE_GENERATION_EVENT_TYPES.succeeded,
          RECIPE_GENERATION_EVENT_TYPES.failed,
        ]),
        sql`${eventLogs.payload} ->> 'attemptId' = ${attemptId}`,
        sql`${eventLogs.payload} ->> 'userId' = ${userId}`,
      ),
    )
    .limit(3);
}

export async function recordRecipeGenerationSuccess(
  scoped: ScopedDatabase,
  input: Readonly<{
    attemptCount: number;
    attemptId: string;
    durationMs: number;
    model: string;
    usage: RecipeGenerationTokenUsage;
  }>,
): Promise<SuccessfulRecipeGenerationAttempt> {
  const attemptId = parseAttemptId(input.attemptId);
  const model = parseModelName(input.model);
  const metrics = parseCompletionMetrics({
    attemptCount: input.attemptCount,
    durationMs: input.durationMs,
  });
  const usage = parseTokenUsage(input.usage);

  return scoped.db.transaction(async (transaction) => {
    await lockGenerationAttempt(transaction, attemptId);
    const events = await listAttemptEvents(
      transaction,
      scoped.scope.householdId,
      scoped.scope.userId,
      attemptId,
    );
    const requested = events.some(
      (event) =>
        event.eventType === RECIPE_GENERATION_EVENT_TYPES.requested,
    );
    if (!requested) {
      throw new RecipeGenerationAttemptError("not_found");
    }

    const succeeded = events.find(
      (event) =>
        event.eventType === RECIPE_GENERATION_EVENT_TYPES.succeeded,
    );
    if (succeeded) {
      const existingModel = payloadString(succeeded.payload, "model");
      if (existingModel === model) {
        return { attemptId, model };
      }
      throw new RecipeGenerationAttemptError("already_completed");
    }

    if (
      events.some(
        (event) =>
          event.eventType === RECIPE_GENERATION_EVENT_TYPES.failed,
      )
    ) {
      throw new RecipeGenerationAttemptError("already_completed");
    }

    await transaction.insert(eventLogs).values({
      eventType: RECIPE_GENERATION_EVENT_TYPES.succeeded,
      householdId: scoped.scope.householdId,
      payload: {
        attemptCount: metrics.attemptCount,
        attemptId,
        durationMs: metrics.durationMs,
        model,
        usage,
        userId: scoped.scope.userId,
      },
    });

    return { attemptId, model };
  });
}

export async function recordRecipeGenerationFailure(
  scoped: ScopedDatabase,
  input: Readonly<{
    attemptCount?: number;
    attemptId: string;
    durationMs?: number;
    reason: RecipeGenerationFailureReason;
  }>,
): Promise<void> {
  const attemptId = parseAttemptId(input.attemptId);
  const parsedReason = failureReasonSchema.safeParse(input.reason);
  if (!parsedReason.success) {
    throw new RecipeGenerationAttemptError("invalid_attempt");
  }
  const parsedAttemptCount =
    input.attemptCount === undefined
      ? null
      : attemptCountSchema.safeParse(input.attemptCount);
  const parsedDuration =
    input.durationMs === undefined
      ? null
      : durationMsSchema.safeParse(input.durationMs);
  if (parsedAttemptCount && !parsedAttemptCount.success) {
    throw new RecipeGenerationAttemptError("invalid_attempt");
  }
  if (parsedDuration && !parsedDuration.success) {
    throw new RecipeGenerationAttemptError("invalid_attempt");
  }

  await scoped.db.transaction(async (transaction) => {
    await lockGenerationAttempt(transaction, attemptId);
    const events = await listAttemptEvents(
      transaction,
      scoped.scope.householdId,
      scoped.scope.userId,
      attemptId,
    );
    const requested = events.some(
      (event) =>
        event.eventType === RECIPE_GENERATION_EVENT_TYPES.requested,
    );
    if (!requested) {
      throw new RecipeGenerationAttemptError("not_found");
    }

    if (
      events.some(
        (event) =>
          event.eventType === RECIPE_GENERATION_EVENT_TYPES.succeeded,
      )
    ) {
      throw new RecipeGenerationAttemptError("already_completed");
    }

    if (
      events.some(
        (event) =>
          event.eventType === RECIPE_GENERATION_EVENT_TYPES.failed,
      )
    ) {
      return;
    }

    await transaction.insert(eventLogs).values({
      eventType: RECIPE_GENERATION_EVENT_TYPES.failed,
      householdId: scoped.scope.householdId,
      payload: {
        ...(parsedAttemptCount?.success
          ? { attemptCount: parsedAttemptCount.data }
          : {}),
        attemptId,
        ...(parsedDuration?.success ? { durationMs: parsedDuration.data } : {}),
        reason: parsedReason.data,
        userId: scoped.scope.userId,
      },
    });
  });
}

export async function getSuccessfulRecipeGenerationAttempt(
  scoped: ScopedDatabase,
  attemptIdInput: string,
): Promise<SuccessfulRecipeGenerationAttempt | null> {
  const attemptId = parseAttemptId(attemptIdInput);
  const [event] = await scoped.db
    .select({ payload: eventLogs.payload })
    .from(eventLogs)
    .where(
      and(
        eq(eventLogs.householdId, scoped.scope.householdId),
        eq(
          eventLogs.eventType,
          RECIPE_GENERATION_EVENT_TYPES.succeeded,
        ),
        sql`${eventLogs.payload} ->> 'attemptId' = ${attemptId}`,
        sql`${eventLogs.payload} ->> 'userId' = ${scoped.scope.userId}`,
      ),
    )
    .limit(1);

  if (!event) {
    return null;
  }

  const model = payloadString(event.payload, "model");
  return model ? { attemptId, model } : null;
}
