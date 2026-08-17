import { describe, expect, it, vi } from "vitest";

import type { ScopedDatabase } from "~/server/context.server";
import {
  RECIPE_GENERATION_EVENT_TYPES,
  getSuccessfulRecipeGenerationAttempt,
  recordRecipeGenerationFailure,
  recordRecipeGenerationSuccess,
  reserveRecipeGenerationAttempt,
} from "./recipe-generation.server";

const ATTEMPT_ID = "f716e7e4-df64-4c84-9a09-4661d0cb3dd1";
const HOUSEHOLD_ID = "f8044a3a-b8e1-4bea-a3db-d8f4f322b411";
const USER_ID = "f69ec2b8-a84c-448b-a26c-6571cd8de311";

type QueryRows = readonly Readonly<Record<string, unknown>>[];

function queryBuilder(rows: QueryRows) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => rows),
      })),
    })),
  };
}

function scopedDatabase(queryResults: readonly QueryRows[]) {
  const pendingResults = [...queryResults];
  const insertedValues: unknown[] = [];
  const transaction = {
    execute: vi.fn(async () => []),
    insert: vi.fn(() => ({
      values: vi.fn(async (values: unknown) => {
        insertedValues.push(values);
      }),
    })),
    select: vi.fn(() => queryBuilder(pendingResults.shift() ?? [])),
  };
  const db = {
    select: vi.fn(() => queryBuilder(pendingResults.shift() ?? [])),
    transaction: vi.fn(
      async (callback: (value: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
  };

  return {
    insertedValues,
    scoped: {
      db,
      scope: {
        householdId: HOUSEHOLD_ID,
        userId: USER_ID,
      },
    } as unknown as ScopedDatabase,
    transaction,
  };
}

describe("reserveRecipeGenerationAttempt", () => {
  it("reserves every request while recording an audit event", async () => {
    const fixture = scopedDatabase([]);

    const result = await reserveRecipeGenerationAttempt(fixture.scoped);

    expect(result.attemptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(fixture.transaction.execute).toHaveBeenCalledOnce();
    expect(fixture.insertedValues).toEqual([
      {
        eventType: RECIPE_GENERATION_EVENT_TYPES.requested,
        householdId: HOUSEHOLD_ID,
        payload: {
          attemptId: result.attemptId,
          userId: USER_ID,
        },
      },
    ]);
  });

});

describe("recipe generation completion", () => {
  it("records only bounded success provenance for a reserved attempt", async () => {
    const fixture = scopedDatabase([
      [
        {
          eventType: RECIPE_GENERATION_EVENT_TYPES.requested,
          payload: { attemptId: ATTEMPT_ID, userId: USER_ID },
        },
      ],
    ]);

    await expect(
      recordRecipeGenerationSuccess(fixture.scoped, {
        attemptCount: 2,
        attemptId: ATTEMPT_ID,
        durationMs: 4_250,
        model: "anthropic/claude-sonnet-4.6",
        usage: {
          inputTokens: 1_200,
          outputTokens: 800,
          totalTokens: 2_000,
        },
      }),
    ).resolves.toEqual({
      attemptId: ATTEMPT_ID,
      model: "anthropic/claude-sonnet-4.6",
    });

    expect(fixture.insertedValues).toEqual([
      {
        eventType: RECIPE_GENERATION_EVENT_TYPES.succeeded,
        householdId: HOUSEHOLD_ID,
        payload: {
          attemptCount: 2,
          attemptId: ATTEMPT_ID,
          durationMs: 4_250,
          model: "anthropic/claude-sonnet-4.6",
          usage: {
            inputTokens: 1_200,
            outputTokens: 800,
            totalTokens: 2_000,
          },
          userId: USER_ID,
        },
      },
    ]);
  });

  it("will not complete an attempt that was not reserved for the scope", async () => {
    const fixture = scopedDatabase([[]]);

    await expect(
      recordRecipeGenerationSuccess(fixture.scoped, {
        attemptCount: 1,
        attemptId: ATTEMPT_ID,
        durationMs: 1_000,
        model: "anthropic/claude-sonnet-4.6",
        usage: {
          inputTokens: 100,
          outputTokens: 100,
          totalTokens: 200,
        },
      }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    expect(fixture.insertedValues).toEqual([]);
  });

  it("records a bounded failure reason without provider errors or model output", async () => {
    const fixture = scopedDatabase([
      [
        {
          eventType: RECIPE_GENERATION_EVENT_TYPES.requested,
          payload: { attemptId: ATTEMPT_ID, userId: USER_ID },
        },
      ],
    ]);

    await recordRecipeGenerationFailure(fixture.scoped, {
      attemptCount: 2,
      attemptId: ATTEMPT_ID,
      durationMs: 2_500,
      reason: "validation",
    });

    expect(fixture.insertedValues).toEqual([
      {
        eventType: RECIPE_GENERATION_EVENT_TYPES.failed,
        householdId: HOUSEHOLD_ID,
        payload: {
          attemptCount: 2,
          attemptId: ATTEMPT_ID,
          durationMs: 2_500,
          reason: "validation",
          userId: USER_ID,
        },
      },
    ]);
  });

  it("rejects unbounded failure details before writing an event", async () => {
    const fixture = scopedDatabase([]);

    await expect(
      recordRecipeGenerationFailure(fixture.scoped, {
        attemptId: ATTEMPT_ID,
        reason: "raw provider stack" as "unknown",
      }),
    ).rejects.toMatchObject({ code: "invalid_attempt" });
    expect(fixture.insertedValues).toEqual([]);
  });

  it("records known failure duration when no model attempt count is available", async () => {
    const fixture = scopedDatabase([
      [
        {
          eventType: RECIPE_GENERATION_EVENT_TYPES.requested,
          payload: { attemptId: ATTEMPT_ID, userId: USER_ID },
        },
      ],
    ]);

    await recordRecipeGenerationFailure(fixture.scoped, {
      attemptId: ATTEMPT_ID,
      durationMs: 325,
      reason: "unknown",
    });

    expect(fixture.insertedValues).toEqual([
      {
        eventType: RECIPE_GENERATION_EVENT_TYPES.failed,
        householdId: HOUSEHOLD_ID,
        payload: {
          attemptId: ATTEMPT_ID,
          durationMs: 325,
          reason: "unknown",
          userId: USER_ID,
        },
      },
    ]);
  });

  it("records a validated zero attempt count for preflight failures", async () => {
    const fixture = scopedDatabase([
      [
        {
          eventType: RECIPE_GENERATION_EVENT_TYPES.requested,
          payload: { attemptId: ATTEMPT_ID, userId: USER_ID },
        },
      ],
    ]);

    await recordRecipeGenerationFailure(fixture.scoped, {
      attemptCount: 0,
      attemptId: ATTEMPT_ID,
      durationMs: 5,
      reason: "configuration",
    });

    expect(fixture.insertedValues[0]).toMatchObject({
      payload: { attemptCount: 0, durationMs: 5 },
    });
  });

  it("returns successful provenance for the scoped household and user", async () => {
    const fixture = scopedDatabase([
      [
        {
          payload: {
            attemptId: ATTEMPT_ID,
            model: "anthropic/claude-sonnet-4.6",
            userId: USER_ID,
          },
        },
      ],
    ]);

    await expect(
      getSuccessfulRecipeGenerationAttempt(fixture.scoped, ATTEMPT_ID),
    ).resolves.toEqual({
      attemptId: ATTEMPT_ID,
      model: "anthropic/claude-sonnet-4.6",
    });
  });

  it("rejects an invalid attempt ID before querying the database", async () => {
    const fixture = scopedDatabase([]);

    await expect(
      getSuccessfulRecipeGenerationAttempt(fixture.scoped, "not-an-attempt"),
    ).rejects.toMatchObject({
      code: "invalid_attempt",
    });
  });
});
