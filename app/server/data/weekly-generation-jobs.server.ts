import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import { weeklyGenerationJobs } from "~/db/schema";
import type { Database } from "~/db/request-db.server";
import type { ScopedDatabase } from "~/server/context.server";

export const weeklyGenerationJobIdSchema = z.uuid();
export const weeklyGenerationJobPhaseSchema = z.enum([
  "candidates",
  "instructions",
]);
export const weeklyGenerationJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
]);

const weekStartDateSchema = z.iso.date();
const failureCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/);
const failureMessageSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[\x20-\x7e]+$/);
const leaseMsSchema = z.number().int().min(1_000).max(60 * 60 * 1_000);
const recoveryLimitSchema = z.number().int().min(1).max(100);

export type WeeklyGenerationJob = Readonly<{
  completedAt: Date | null;
  createdAt: Date;
  deliveryCount: number;
  failureCode: string | null;
  failureMessage: string | null;
  householdId: string;
  id: string;
  leaseExpiresAt: Date | null;
  phase: z.infer<typeof weeklyGenerationJobPhaseSchema>;
  requestedByAppUserId: string;
  runId: string | null;
  startedAt: Date | null;
  status: z.infer<typeof weeklyGenerationJobStatusSchema>;
  updatedAt: Date;
  weekStartDate: string;
}>;

const createJobSchema = z
  .strictObject({
    id: weeklyGenerationJobIdSchema.optional(),
    phase: weeklyGenerationJobPhaseSchema,
    runId: weeklyGenerationJobIdSchema.nullish(),
    weekStartDate: weekStartDateSchema,
  })
  .superRefine((value, context) => {
    if (value.phase === "instructions" && !value.runId) {
      context.addIssue({
        code: "custom",
        message: "Instruction jobs require a weekly generation run.",
        path: ["runId"],
      });
    }
  });

function parseJob(
  row: typeof weeklyGenerationJobs.$inferSelect,
): WeeklyGenerationJob {
  return {
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    deliveryCount: row.deliveryCount,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    householdId: row.householdId,
    id: row.id,
    leaseExpiresAt: row.leaseExpiresAt,
    phase: weeklyGenerationJobPhaseSchema.parse(row.phase),
    requestedByAppUserId: row.requestedByAppUserId,
    runId: row.runId,
    startedAt: row.startedAt,
    status: weeklyGenerationJobStatusSchema.parse(row.status),
    updatedAt: row.updatedAt,
    weekStartDate: row.weekStartDate,
  };
}

export async function createWeeklyGenerationJob(
  scoped: ScopedDatabase,
  input: Readonly<{
    id?: string;
    phase: "candidates" | "instructions";
    runId?: string | null;
    weekStartDate: string;
  }>,
): Promise<WeeklyGenerationJob> {
  const parsed = createJobSchema.parse(input);
  const id = parsed.id ?? randomUUID();
  const [created] = await scoped.db
    .insert(weeklyGenerationJobs)
    .values({
      householdId: scoped.scope.householdId,
      id,
      phase: parsed.phase,
      requestedByAppUserId: scoped.scope.userId,
      runId: parsed.runId ?? null,
      weekStartDate: parsed.weekStartDate,
    })
    .onConflictDoNothing({ target: weeklyGenerationJobs.id })
    .returning();
  if (created) return parseJob(created);

  const existing = await getWeeklyGenerationJob(scoped, id);
  if (
    !existing ||
    existing.phase !== parsed.phase ||
    existing.requestedByAppUserId !== scoped.scope.userId ||
    existing.runId !== (parsed.runId ?? null) ||
    existing.weekStartDate !== parsed.weekStartDate
  ) {
    throw new Error("Weekly generation job identifier is already in use.");
  }
  return existing;
}

export async function getWeeklyGenerationJob(
  scoped: ScopedDatabase,
  jobIdInput: string,
): Promise<WeeklyGenerationJob | null> {
  const jobId = weeklyGenerationJobIdSchema.parse(jobIdInput);
  const [row] = await scoped.db
    .select()
    .from(weeklyGenerationJobs)
    .where(
      and(
        eq(weeklyGenerationJobs.householdId, scoped.scope.householdId),
        eq(weeklyGenerationJobs.id, jobId),
      ),
    )
    .limit(1);
  return row ? parseJob(row) : null;
}

export async function getWeeklyGenerationJobForWorker(
  db: Database,
  jobIdInput: string,
): Promise<WeeklyGenerationJob | null> {
  const jobId = weeklyGenerationJobIdSchema.parse(jobIdInput);
  const [row] = await db
    .select()
    .from(weeklyGenerationJobs)
    .where(eq(weeklyGenerationJobs.id, jobId))
    .limit(1);
  return row ? parseJob(row) : null;
}

async function getUpdatedOrCurrentJob(
  db: Database,
  jobId: string,
  updated: readonly (typeof weeklyGenerationJobs.$inferSelect)[],
): Promise<WeeklyGenerationJob | null> {
  if (updated[0]) return parseJob(updated[0]);
  return getWeeklyGenerationJobForWorker(db, jobId);
}

export async function claimWeeklyGenerationJobForWork(
  db: Database,
  input: Readonly<{ jobId: string; leaseMs: number }>,
): Promise<WeeklyGenerationJob | null> {
  const jobId = weeklyGenerationJobIdSchema.parse(input.jobId);
  const leaseMs = leaseMsSchema.parse(input.leaseMs);
  const updated = await db
    .update(weeklyGenerationJobs)
    .set({
      deliveryCount: sql`${weeklyGenerationJobs.deliveryCount} + 1`,
      leaseExpiresAt: sql`CURRENT_TIMESTAMP + (${leaseMs} * INTERVAL '1 millisecond')`,
      startedAt: sql`COALESCE(${weeklyGenerationJobs.startedAt}, CURRENT_TIMESTAMP)`,
      status: "running",
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(weeklyGenerationJobs.id, jobId),
        or(
          eq(weeklyGenerationJobs.status, "queued"),
          and(
            eq(weeklyGenerationJobs.status, "running"),
            sql`${weeklyGenerationJobs.leaseExpiresAt} <= CURRENT_TIMESTAMP`,
          ),
        ),
      ),
    )
    .returning();
  return updated[0] ? parseJob(updated[0]) : null;
}

export async function listRecoverableWeeklyGenerationJobs(
  db: Database,
  input: Readonly<{ limit: number }>,
): Promise<readonly WeeklyGenerationJob[]> {
  const limit = recoveryLimitSchema.parse(input.limit);
  const rows = await db
    .select()
    .from(weeklyGenerationJobs)
    .where(
      or(
        eq(weeklyGenerationJobs.status, "queued"),
        and(
          eq(weeklyGenerationJobs.status, "running"),
          sql`${weeklyGenerationJobs.leaseExpiresAt} <= CURRENT_TIMESTAMP`,
        ),
      ),
    )
    .orderBy(asc(weeklyGenerationJobs.createdAt))
    .limit(limit);
  return rows.map(parseJob);
}

export async function requeueWeeklyGenerationJob(
  db: Database,
  input: Readonly<{ jobId: string }>,
): Promise<WeeklyGenerationJob | null> {
  const jobId = weeklyGenerationJobIdSchema.parse(input.jobId);
  const updated = await db
    .update(weeklyGenerationJobs)
    .set({
      leaseExpiresAt: null,
      status: "queued",
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(weeklyGenerationJobs.id, jobId),
        eq(weeklyGenerationJobs.status, "running"),
      ),
    )
    .returning();
  return getUpdatedOrCurrentJob(db, jobId, updated);
}

export async function markWeeklyGenerationJobSucceeded(
  db: Database,
  input: Readonly<{ jobId: string; runId?: string | null }>,
): Promise<WeeklyGenerationJob | null> {
  const jobId = weeklyGenerationJobIdSchema.parse(input.jobId);
  const runId = input.runId
    ? weeklyGenerationJobIdSchema.parse(input.runId)
    : null;
  const updated = await db
    .update(weeklyGenerationJobs)
    .set({
      completedAt: sql`CURRENT_TIMESTAMP`,
      leaseExpiresAt: null,
      ...(runId ? { runId } : {}),
      status: "succeeded",
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(weeklyGenerationJobs.id, jobId),
        inArray(weeklyGenerationJobs.status, ["queued", "running"]),
      ),
    )
    .returning();
  return getUpdatedOrCurrentJob(db, jobId, updated);
}

export async function markWeeklyGenerationJobFailed(
  db: Database,
  input: Readonly<{ failureCode: string; failureMessage: string; jobId: string }>,
): Promise<WeeklyGenerationJob | null> {
  const parsed = z
    .strictObject({
      failureCode: failureCodeSchema,
      failureMessage: failureMessageSchema,
      jobId: weeklyGenerationJobIdSchema,
    })
    .parse(input);
  const updated = await db
    .update(weeklyGenerationJobs)
    .set({
      completedAt: sql`CURRENT_TIMESTAMP`,
      failureCode: parsed.failureCode,
      failureMessage: parsed.failureMessage,
      leaseExpiresAt: null,
      status: "failed",
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(weeklyGenerationJobs.id, parsed.jobId),
        inArray(weeklyGenerationJobs.status, ["queued", "running"]),
      ),
    )
    .returning();
  return getUpdatedOrCurrentJob(db, parsed.jobId, updated);
}

export async function findLatestActiveInstructionJobForRun(
  scoped: ScopedDatabase,
  runIdInput: string,
): Promise<WeeklyGenerationJob | null> {
  const runId = weeklyGenerationJobIdSchema.parse(runIdInput);
  const [row] = await scoped.db
    .select()
    .from(weeklyGenerationJobs)
    .where(
      and(
        eq(weeklyGenerationJobs.householdId, scoped.scope.householdId),
        eq(weeklyGenerationJobs.runId, runId),
        eq(weeklyGenerationJobs.phase, "instructions"),
        inArray(weeklyGenerationJobs.status, ["queued", "running"]),
      ),
    )
    .orderBy(desc(weeklyGenerationJobs.createdAt))
    .limit(1);
  return row ? parseJob(row) : null;
}
