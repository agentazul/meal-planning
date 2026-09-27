import { describe, expect, it, vi } from "vitest";

import { cookingDaysOff, eventLogs } from "~/db/schema";
import type { ScopedDatabase } from "~/server/context.server";
import { WeekPlannerError } from "~/server/data/week.server";
import { clearCookingDayOff, setCookingDayOff } from "./cooking-days.server";

const HOUSEHOLD_ID = "f8044a3a-b8e1-4bea-a3db-d8f4f322b411";
const USER_ID = "f69ec2b8-a84c-448b-a26c-6571cd8de311";
const TIMEZONE = "America/Chicago";
const FUTURE_DATE = "2099-01-05";

type InsertRecord = Readonly<{ table: unknown; values: unknown }>;

function fixture(
  options: Readonly<{ conflictingEntries?: readonly unknown[] }> = {},
) {
  const conflictingEntries = options.conflictingEntries ?? [];
  const inserts: InsertRecord[] = [];
  const onConflictDoNothing = vi.fn(async () => undefined);

  const transaction = {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        inserts.push({ table, values });
        return table === cookingDaysOff
          ? { onConflictDoNothing }
          : Promise.resolve();
      }),
    })),
  };

  const select = vi.fn((selection: Readonly<Record<string, unknown>>) => {
    if ("timezone" in selection) {
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [{ timezone: TIMEZONE }]),
          })),
        })),
      };
    }

    return {
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => conflictingEntries),
        })),
      })),
    };
  });

  const db = {
    select,
    transaction: vi.fn(
      async (callback: (value: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
  };

  return {
    db,
    inserts,
    onConflictDoNothing,
    scoped: {
      db,
      scope: { householdId: HOUSEHOLD_ID, userId: USER_ID },
    } as unknown as ScopedDatabase,
  };
}

describe("setCookingDayOff", () => {
  it("inserts the day off and logs the event", async () => {
    const { inserts, scoped } = fixture();

    await setCookingDayOff(scoped, { date: FUTURE_DATE });

    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.table).toBe(cookingDaysOff);
    expect(inserts[0]?.values).toEqual({
      createdByAppUserId: USER_ID,
      date: FUTURE_DATE,
      householdId: HOUSEHOLD_ID,
    });
    expect(inserts[1]?.table).toBe(eventLogs);
    expect(inserts[1]?.values).toEqual({
      eventType: "plan.day_off_set",
      householdId: HOUSEHOLD_ID,
      payload: { appUserId: USER_ID, date: FUTURE_DATE },
    });
  });

  it("rejects when a planned dinner already exists on that date", async () => {
    const { inserts, scoped } = fixture({
      conflictingEntries: [{ id: "existing-entry" }],
    });

    await expect(
      setCookingDayOff(scoped, { date: FUTURE_DATE }),
    ).rejects.toMatchObject(
      new WeekPlannerError(
        "DAY_HAS_DINNER",
        "Remove this dinner before turning the day off.",
      ),
    );
    expect(inserts).toHaveLength(0);
  });

  it("rejects dates in the past", async () => {
    const { inserts, scoped } = fixture();

    await expect(
      setCookingDayOff(scoped, { date: "2000-01-01" }),
    ).rejects.toMatchObject(
      new WeekPlannerError(
        "PAST_DATE",
        "Choose today or a future date to turn off cooking.",
      ),
    );
    expect(inserts).toHaveLength(0);
  });
});

describe("clearCookingDayOff", () => {
  it("deletes the day off row and logs the event", async () => {
    const inserts: InsertRecord[] = [];
    const deleted = { id: "day-off-id" };
    const transaction = {
      delete: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => [deleted]),
        })),
      })),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn((values: unknown) => {
          inserts.push({ table, values });
          return Promise.resolve();
        }),
      })),
    };
    const db = {
      transaction: vi.fn(
        async (callback: (value: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      ),
    };
    const scoped = {
      db,
      scope: { householdId: HOUSEHOLD_ID, userId: USER_ID },
    } as unknown as ScopedDatabase;

    await expect(
      clearCookingDayOff(scoped, { date: FUTURE_DATE }),
    ).resolves.toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.table).toBe(eventLogs);
    expect(inserts[0]?.values).toEqual({
      eventType: "plan.day_off_cleared",
      householdId: HOUSEHOLD_ID,
      payload: { appUserId: USER_ID, date: FUTURE_DATE },
    });
  });

  it("returns false when there was nothing to clear", async () => {
    const transaction = {
      delete: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => []),
        })),
      })),
      insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    };
    const db = {
      transaction: vi.fn(
        async (callback: (value: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      ),
    };
    const scoped = {
      db,
      scope: { householdId: HOUSEHOLD_ID, userId: USER_ID },
    } as unknown as ScopedDatabase;

    await expect(
      clearCookingDayOff(scoped, { date: FUTURE_DATE }),
    ).resolves.toBe(false);
  });
});
