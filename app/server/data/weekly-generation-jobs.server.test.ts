import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "~/db/request-db.server";
import type { ScopedDatabase } from "~/server/context.server";
import {
  claimWeeklyGenerationJobForWork,
  createOrGetActiveSlotGenerationJob,
  createWeeklyGenerationJob,
  findLatestActiveInstructionJobForRun,
  findLatestActiveSlotGenerationJobForRun,
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
const IDEMPOTENCY_KEY = "00000000-0000-4000-8000-000000000077";

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
    idempotencyKey: null,
    leaseExpiresAt: null,
    phase: "candidates",
    requestedByAppUserId: USER_ID,
    runId: null,
    slotDate: null,
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
      idempotencyKey: null,
      phase: "candidates",
      requestedByAppUserId: USER_ID,
      runId: null,
      slotDate: null,
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

  it("requires slot jobs to use the concurrency-safe slot creation path", async () => {
    const insert = vi.fn();
    await expect(
      createWeeklyGenerationJob(scopedDatabase({ insert }), {
        phase: "slot_candidates",
        runId: RUN_ID,
        weekStartDate: "2026-08-30",
      } as never),
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
    expect(queryParams(callArgument(otherFixture.where) as SQL)).toEqual([
      OTHER_HOUSEHOLD_ID,
      JOB_ID,
    ]);
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

  it("finds the newest active slot generation job for a scoped run", async () => {
    const fixture = selectFixture([
      jobRow({
        idempotencyKey: IDEMPOTENCY_KEY,
        phase: "slot_candidates",
        runId: RUN_ID,
        slotDate: "2026-09-01",
      }),
    ]);

    await expect(
      findLatestActiveSlotGenerationJobForRun(
        scopedDatabase(fixture.db),
        RUN_ID,
      ),
    ).resolves.toMatchObject({
      phase: "slot_candidates",
      slotDate: "2026-09-01",
    });
    expect(queryParams(callArgument(fixture.where) as SQL)).toEqual([
      HOUSEHOLD_ID,
      RUN_ID,
      "slot_candidates",
      "queued",
      "running",
    ]);
    expect(fixture.orderBy).toHaveBeenCalledOnce();
  });
});

function slotJobTransactionFixture(
  input: Readonly<{
    activeRows?: readonly Record<string, unknown>[];
    createdRows?: readonly Record<string, unknown>[];
    idempotentRows?: readonly Record<string, unknown>[];
  }>,
) {
  const selectRows = [
    input.idempotentRows ?? [],
    ...(input.idempotentRows?.length ? [] : [input.activeRows ?? []]),
  ];
  const where = vi.fn(() => {
    const rows = selectRows.shift() ?? [];
    const limit = vi.fn(async () => rows);
    const orderBy = vi.fn(() => ({ limit }));
    return { limit, orderBy };
  });
  const select = vi.fn(() => ({ from: vi.fn(() => ({ where })) }));
  const returning = vi.fn(async () => input.createdRows ?? []);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const transaction = {
    execute: vi.fn(async () => []),
    insert: vi.fn(() => ({ values })),
    select,
  };
  const db = {
    transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) =>
      callback(transaction),
    ),
  };
  return { db, onConflictDoNothing, transaction, values, where };
}

describe("one-night generation job creation", () => {
  it("creates a slot-scoped job with durable idempotency metadata", async () => {
    const created = jobRow({
      idempotencyKey: IDEMPOTENCY_KEY,
      phase: "slot_candidates",
      runId: RUN_ID,
      slotDate: "2026-09-01",
    });
    const fixture = slotJobTransactionFixture({ createdRows: [created] });

    await expect(
      createOrGetActiveSlotGenerationJob(scopedDatabase(fixture.db), {
        id: JOB_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        runId: RUN_ID,
        slotDate: "2026-09-01",
        weekStartDate: "2026-08-30",
      }),
    ).resolves.toMatchObject({
      idempotencyKey: IDEMPOTENCY_KEY,
      phase: "slot_candidates",
      slotDate: "2026-09-01",
    });
    expect(fixture.transaction.execute).toHaveBeenCalledOnce();
    expect(fixture.values).toHaveBeenCalledWith({
      householdId: HOUSEHOLD_ID,
      id: JOB_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      phase: "slot_candidates",
      requestedByAppUserId: USER_ID,
      runId: RUN_ID,
      slotDate: "2026-09-01",
      weekStartDate: "2026-08-30",
    });
  });

  it("returns the original terminal job for an idempotent retry", async () => {
    const succeeded = jobRow({
      completedAt: new Date("2026-08-30T15:02:00.000Z"),
      idempotencyKey: IDEMPOTENCY_KEY,
      phase: "slot_candidates",
      runId: RUN_ID,
      slotDate: "2026-09-01",
      status: "succeeded",
    });
    const fixture = slotJobTransactionFixture({ idempotentRows: [succeeded] });

    await expect(
      createOrGetActiveSlotGenerationJob(scopedDatabase(fixture.db), {
        idempotencyKey: IDEMPOTENCY_KEY,
        runId: RUN_ID,
        slotDate: "2026-09-01",
        weekStartDate: "2026-08-30",
      }),
    ).resolves.toMatchObject({ id: JOB_ID, status: "succeeded" });
    expect(fixture.transaction.insert).not.toHaveBeenCalled();
  });

  it("does not let an idempotency key be reused for another slot", async () => {
    const existing = jobRow({
      idempotencyKey: IDEMPOTENCY_KEY,
      phase: "slot_candidates",
      runId: RUN_ID,
      slotDate: "2026-09-01",
    });
    const fixture = slotJobTransactionFixture({ idempotentRows: [existing] });

    await expect(
      createOrGetActiveSlotGenerationJob(scopedDatabase(fixture.db), {
        idempotencyKey: IDEMPOTENCY_KEY,
        runId: RUN_ID,
        slotDate: "2026-09-02",
        weekStartDate: "2026-08-30",
      }),
    ).rejects.toThrow("idempotency key is already in use");
    expect(fixture.transaction.insert).not.toHaveBeenCalled();
  });

  it("returns active work for the same run and slot across request keys", async () => {
    const active = jobRow({
      idempotencyKey: IDEMPOTENCY_KEY,
      phase: "slot_candidates",
      runId: RUN_ID,
      slotDate: "2026-09-01",
    });
    const fixture = slotJobTransactionFixture({ activeRows: [active] });

    await expect(
      createOrGetActiveSlotGenerationJob(scopedDatabase(fixture.db), {
        idempotencyKey: "00000000-0000-4000-8000-000000000066",
        runId: RUN_ID,
        slotDate: "2026-09-01",
        weekStartDate: "2026-08-30",
      }),
    ).resolves.toMatchObject({ idempotencyKey: IDEMPOTENCY_KEY });
    expect(fixture.transaction.insert).not.toHaveBeenCalled();
  });

  it("allows independent slots to create independent active jobs", async () => {
    const secondJobId = "00000000-0000-4000-8000-000000000055";
    const firstFixture = slotJobTransactionFixture({
      createdRows: [
        jobRow({
          idempotencyKey: IDEMPOTENCY_KEY,
          phase: "slot_candidates",
          runId: RUN_ID,
          slotDate: "2026-09-01",
        }),
      ],
    });
    const secondFixture = slotJobTransactionFixture({
      createdRows: [
        jobRow({
          id: secondJobId,
          idempotencyKey: secondJobId,
          phase: "slot_candidates",
          runId: RUN_ID,
          slotDate: "2026-09-02",
        }),
      ],
    });

    const [first, second] = await Promise.all([
      createOrGetActiveSlotGenerationJob(scopedDatabase(firstFixture.db), {
        id: JOB_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        runId: RUN_ID,
        slotDate: "2026-09-01",
        weekStartDate: "2026-08-30",
      }),
      createOrGetActiveSlotGenerationJob(scopedDatabase(secondFixture.db), {
        id: secondJobId,
        runId: RUN_ID,
        slotDate: "2026-09-02",
        weekStartDate: "2026-08-30",
      }),
    ]);

    expect(first.slotDate).toBe("2026-09-01");
    expect(second.slotDate).toBe("2026-09-02");
  });

  it("rejects missing or out-of-week slot metadata before opening a transaction", async () => {
    const transaction = vi.fn();
    const scoped = scopedDatabase({ transaction });

    await expect(
      createOrGetActiveSlotGenerationJob(scoped, {
        runId: RUN_ID,
        slotDate: "2026-09-08",
        weekStartDate: "2026-08-30",
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("weekly generation job transitions", () => {
  it("preserves slot metadata when a worker leases one-night generation", async () => {
    const returning = vi.fn(async () => [
      jobRow({
        deliveryCount: 1,
        idempotencyKey: IDEMPOTENCY_KEY,
        leaseExpiresAt: new Date("2026-08-30T15:06:00.000Z"),
        phase: "slot_candidates",
        runId: RUN_ID,
        slotDate: "2026-09-01",
        startedAt: new Date("2026-08-30T15:01:00.000Z"),
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
      idempotencyKey: IDEMPOTENCY_KEY,
      phase: "slot_candidates",
      slotDate: "2026-09-01",
      status: "running",
    });
  });
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
        idempotencyKey: IDEMPOTENCY_KEY,
        leaseExpiresAt: expiredLease,
        phase: "slot_candidates",
        runId: RUN_ID,
        slotDate: "2026-09-01",
        startedAt: new Date("2026-08-30T14:55:00.000Z"),
        status: "running",
      }),
    ]);
    const db = fixture.db as unknown as Database;

    await expect(
      listRecoverableWeeklyGenerationJobs(db, { limit: 25 }),
    ).resolves.toEqual([
      expect.objectContaining({
        leaseExpiresAt: expiredLease,
        phase: "slot_candidates",
        slotDate: "2026-09-01",
        status: "running",
      }),
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
      listRecoverableWeeklyGenerationJobs(fixture.db as unknown as Database, {
        limit: 10,
      }),
    ).resolves.toEqual([]);
    const params = queryParams(callArgument(fixture.where) as SQL);
    expect(params).toEqual(["queued", "running"]);
    expect(params).not.toContain("succeeded");
    expect(params).not.toContain("failed");
  });

  it("requeues running work idempotently without resetting attempt history", async () => {
    const startedAt = new Date("2026-08-30T14:55:00.000Z");
    const queued = jobRow({
      deliveryCount: 2,
      idempotencyKey: IDEMPOTENCY_KEY,
      phase: "slot_candidates",
      runId: RUN_ID,
      slotDate: "2026-09-01",
      startedAt,
    });
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
      phase: "slot_candidates",
      slotDate: "2026-09-01",
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
