import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "~/db/request-db.server";
import type { ScopedDatabase } from "~/server/context.server";
import {
  claimWeeklyGenerationJobForWork,
  createWeeklyGenerationJob,
  findLatestActiveInstructionJobForRun,
  getWeeklyGenerationJob,
  listRecoverableWeeklyGenerationJobs,
  markWeeklyGenerationJobFailed,
  markWeeklyGenerationJobSucceeded,
  requeueWeeklyGenerationJob,
} from "./weekly-generation-jobs.server";

const HOUSEHOLD_ID = "f8044a3a-b8e1-4bea-a3db-d8f4f322b411";
const OTHER_HOUSEHOLD_ID = "ec0df454-4810-4aa8-b7c1-d0b57e0143e0";
const USER_ID = "f69ec2b8-a84c-448b-a26c-6571cd8de311";
const JOB_ID = "00000000-0000-4000-8000-000000000099";
const RUN_ID = "00000000-0000-4000-8000-000000000088";

function jobRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = new Date("2026-08-30T15:00:00.000Z");
  return {
    completedAt: null,
    createdAt: now,
    deliveryCount: 0,
    failureCode: null,
    failureMessage: null,
    householdId: HOUSEHOLD_ID,
    id: JOB_ID,
    leaseExpiresAt: null,
    phase: "candidates",
    requestedByAppUserId: USER_ID,
    runId: null,
    startedAt: null,
    status: "queued",
    updatedAt: now,
    weekStartDate: "2026-08-30",
    ...overrides,
  };
}

function queryParams(condition: SQL): unknown[] {
  return new PgDialect().sqlToQuery(condition).params;
}

function queryText(condition: SQL): string {
  return new PgDialect().sqlToQuery(condition).sql;
}

function callArgument(
  mockFunction: Readonly<{
    mock: Readonly<{ calls: readonly (readonly unknown[])[] }>;
  }>,
  callIndex = 0,
): unknown {
  return mockFunction.mock.calls[callIndex]?.[0];
}

function selectFixture(rows: readonly Record<string, unknown>[]) {
  const limit = vi.fn(async () => rows);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ limit, orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select }, from, limit, orderBy, select, where };
}

function scopedDatabase(db: unknown, householdId = HOUSEHOLD_ID) {
  return {
    db,
    scope: { householdId, userId: USER_ID },
  } as unknown as ScopedDatabase;
}

describe("weekly generation job creation and scoping", () => {
  it("creates a candidate job with the caller's household and user scope", async () => {
    const created = jobRow();
    const returning = vi.fn(async () => [created]);
    const onConflictDoNothing = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const db = { insert: vi.fn(() => ({ values })) };

    await expect(
      createWeeklyGenerationJob(scopedDatabase(db), {
        id: JOB_ID,
        phase: "candidates",
        weekStartDate: "2026-08-30",
      }),
    ).resolves.toMatchObject({ id: JOB_ID, status: "queued" });
    expect(values).toHaveBeenCalledWith({
      householdId: HOUSEHOLD_ID,
      id: JOB_ID,
      phase: "candidates",
      requestedByAppUserId: USER_ID,
      runId: null,
      weekStartDate: "2026-08-30",
    });
  });

  it("requires a run for instruction jobs before touching the database", async () => {
    const insert = vi.fn();
    await expect(
      createWeeklyGenerationJob(scopedDatabase({ insert }), {
        phase: "instructions",
        weekStartDate: "2026-08-30",
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("includes the household scope when reading a job", async () => {
    const fixture = selectFixture([]);

    await expect(
      getWeeklyGenerationJob(scopedDatabase(fixture.db), JOB_ID),
    ).resolves.toBeNull();
    const condition = callArgument(fixture.where) as SQL;
    expect(queryParams(condition)).toEqual([HOUSEHOLD_ID, JOB_ID]);

    const otherFixture = selectFixture([]);
    await getWeeklyGenerationJob(
      scopedDatabase(otherFixture.db, OTHER_HOUSEHOLD_ID),
      JOB_ID,
    );
    expect(
      queryParams(callArgument(otherFixture.where) as SQL),
    ).toEqual([OTHER_HOUSEHOLD_ID, JOB_ID]);
  });

  it("finds only active instruction work for a scoped run", async () => {
    const fixture = selectFixture([
      jobRow({ phase: "instructions", runId: RUN_ID }),
    ]);
    await expect(
      findLatestActiveInstructionJobForRun(scopedDatabase(fixture.db), RUN_ID),
    ).resolves.toMatchObject({ phase: "instructions", runId: RUN_ID });
    expect(queryParams(callArgument(fixture.where) as SQL)).toEqual([
      HOUSEHOLD_ID,
      RUN_ID,
      "instructions",
      "queued",
      "running",
    ]);
    expect(fixture.orderBy).toHaveBeenCalledOnce();
  });
});

describe("weekly generation job transitions", () => {
  it("atomically lets only one worker claim currently eligible work", async () => {
    const returning = vi
      .fn()
      .mockResolvedValueOnce([
      jobRow({
        deliveryCount: 1,
        leaseExpiresAt: new Date("2026-08-30T15:06:00.000Z"),
        startedAt: new Date("2026-08-30T15:01:00.000Z"),
        status: "running",
      }),
      ])
      .mockResolvedValueOnce([]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const db = { update: vi.fn(() => ({ set })) } as unknown as Database;

    await expect(
      claimWeeklyGenerationJobForWork(db, {
        jobId: JOB_ID,
        leaseMs: 300_000,
      }),
    ).resolves.toMatchObject({ deliveryCount: 1, status: "running" });
    await expect(
      claimWeeklyGenerationJobForWork(db, {
        jobId: JOB_ID,
        leaseMs: 300_000,
      }),
    ).resolves.toBeNull();

    expect(db.update).toHaveBeenCalledTimes(2);
    const claimCondition = callArgument(where) as SQL;
    expect(queryParams(claimCondition)).toEqual([JOB_ID, "queued", "running"]);
    expect(queryText(claimCondition)).toContain(
      '"weekly_generation_job"."lease_expires_at" <= CURRENT_TIMESTAMP',
    );
  });

  it("does not return a job while another worker holds an unexpired lease", async () => {
    const returning = vi.fn(async () => []);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const db = { update: vi.fn(() => ({ set })) } as unknown as Database;

    await expect(
      claimWeeklyGenerationJobForWork(db, {
        jobId: JOB_ID,
        leaseMs: 300_000,
      }),
    ).resolves.toBeNull();
    expect(returning).toHaveBeenCalledOnce();
  });

  it("reclaims a running job after its lease expires", async () => {
    const expiredLease = new Date("2026-08-30T14:59:00.000Z");
    const renewedLease = new Date("2026-08-30T15:06:00.000Z");
    const returning = vi.fn(async () => [
      jobRow({
        deliveryCount: 2,
        leaseExpiresAt: renewedLease,
        startedAt: new Date("2026-08-30T14:55:00.000Z"),
        status: "running",
      }),
    ]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const db = { update: vi.fn(() => ({ set })) } as unknown as Database;

    await expect(
      claimWeeklyGenerationJobForWork(db, {
        jobId: JOB_ID,
        leaseMs: 300_000,
      }),
    ).resolves.toMatchObject({
      deliveryCount: 2,
      leaseExpiresAt: renewedLease,
      status: "running",
    });
    expect(queryText(callArgument(where) as SQL)).toContain(
      '"weekly_generation_job"."lease_expires_at" <= CURRENT_TIMESTAMP',
    );
    expect(expiredLease.getTime()).toBeLessThan(renewedLease.getTime());
  });

  it("lists queued and expired running jobs oldest first for recovery", async () => {
    const expiredLease = new Date("2026-08-30T14:59:00.000Z");
    const fixture = selectFixture([
      jobRow({
        deliveryCount: 1,
        leaseExpiresAt: expiredLease,
        startedAt: new Date("2026-08-30T14:55:00.000Z"),
        status: "running",
      }),
    ]);
    const db = fixture.db as unknown as Database;

    await expect(
      listRecoverableWeeklyGenerationJobs(db, { limit: 25 }),
    ).resolves.toEqual([
      expect.objectContaining({ leaseExpiresAt: expiredLease, status: "running" }),
    ]);
    const recoveryCondition = callArgument(fixture.where) as SQL;
    expect(queryParams(recoveryCondition)).toEqual(["queued", "running"]);
    expect(queryText(recoveryCondition)).toContain(
      '"weekly_generation_job"."lease_expires_at" <= CURRENT_TIMESTAMP',
    );
    expect(fixture.orderBy).toHaveBeenCalledOnce();
    expect(fixture.limit).toHaveBeenCalledWith(25);
  });

  it("excludes terminal states from the recovery scan", async () => {
    const fixture = selectFixture([]);
    await expect(
      listRecoverableWeeklyGenerationJobs(
        fixture.db as unknown as Database,
        { limit: 10 },
      ),
    ).resolves.toEqual([]);
    const params = queryParams(callArgument(fixture.where) as SQL);
    expect(params).toEqual(["queued", "running"]);
    expect(params).not.toContain("succeeded");
    expect(params).not.toContain("failed");
  });

  it("requeues running work idempotently without resetting attempt history", async () => {
    const startedAt = new Date("2026-08-30T14:55:00.000Z");
    const queued = jobRow({ deliveryCount: 2, startedAt });
    const updateReturning = vi
      .fn()
      .mockResolvedValueOnce([queued])
      .mockResolvedValueOnce([]);
    const where = vi.fn(() => ({ returning: updateReturning }));
    const set = vi.fn(() => ({ where }));
    const select = selectFixture([queued]);
    const db = {
      select: select.db.select,
      update: vi.fn(() => ({ set })),
    } as unknown as Database;

    await expect(
      requeueWeeklyGenerationJob(db, { jobId: JOB_ID }),
    ).resolves.toMatchObject({
      deliveryCount: 2,
      leaseExpiresAt: null,
      startedAt,
      status: "queued",
    });
    await expect(
      requeueWeeklyGenerationJob(db, { jobId: JOB_ID }),
    ).resolves.toMatchObject({ deliveryCount: 2, status: "queued" });
    expect(callArgument(set)).toMatchObject({
      leaseExpiresAt: null,
      status: "queued",
    });
  });

  it("does not requeue a terminal job", async () => {
    const succeeded = jobRow({
      completedAt: new Date("2026-08-30T15:02:00.000Z"),
      status: "succeeded",
    });
    const returning = vi.fn(async () => []);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const select = selectFixture([succeeded]);
    const db = {
      select: select.db.select,
      update: vi.fn(() => ({ set })),
    } as unknown as Database;

    await expect(
      requeueWeeklyGenerationJob(db, { jobId: JOB_ID }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(queryParams(callArgument(where) as SQL)).toEqual([
      JOB_ID,
      "running",
    ]);
  });

  it("can complete a candidate job with its published run id", async () => {
    const completedAt = new Date("2026-08-30T15:02:00.000Z");
    const returning = vi.fn(async () => [
      jobRow({ completedAt, runId: RUN_ID, status: "succeeded" }),
    ]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const db = { update: vi.fn(() => ({ set })) } as unknown as Database;

    await expect(
      markWeeklyGenerationJobSucceeded(db, { jobId: JOB_ID, runId: RUN_ID }),
    ).resolves.toMatchObject({ runId: RUN_ID, status: "succeeded" });
    expect(callArgument(set)).toMatchObject({
      leaseExpiresAt: null,
      runId: RUN_ID,
      status: "succeeded",
    });
    expect(queryParams(callArgument(where) as SQL)).toEqual([
      JOB_ID,
      "queued",
      "running",
    ]);
  });

  it("stores only controlled failure state on an active job", async () => {
    const returning = vi.fn(async () => [
      jobRow({
        completedAt: new Date("2026-08-30T15:02:00.000Z"),
        failureCode: "provider_unavailable",
        failureMessage: "Recipe generation is temporarily unavailable.",
        status: "failed",
      }),
    ]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const db = { update: vi.fn(() => ({ set })) } as unknown as Database;

    await expect(
      markWeeklyGenerationJobFailed(db, {
        failureCode: "provider_unavailable",
        failureMessage: "Recipe generation is temporarily unavailable.",
        jobId: JOB_ID,
      }),
    ).resolves.toMatchObject({
      failureCode: "provider_unavailable",
      status: "failed",
    });
    expect(callArgument(set)).toMatchObject({
      failureCode: "provider_unavailable",
      failureMessage: "Recipe generation is temporarily unavailable.",
      leaseExpiresAt: null,
      status: "failed",
    });
    expect(queryParams(callArgument(where) as SQL)).toEqual([
      JOB_ID,
      "queued",
      "running",
    ]);
  });

  it("validates controlled failure diagnostics before updating", async () => {
    const update = vi.fn();
    const db = { update } as unknown as Database;

    await expect(
      markWeeklyGenerationJobFailed(db, {
        failureCode: "RAW-PROVIDER-500",
        failureMessage: "unsafe\nprovider response",
        jobId: JOB_ID,
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(update).not.toHaveBeenCalled();
  });
});
