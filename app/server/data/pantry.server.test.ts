import { describe, expect, it, vi } from "vitest";

import { eventLogs, pantryItems } from "~/db/schema";
import type { ScopedDatabase } from "~/server/context.server";
import { setPantryItemCount } from "./pantry.server";

const HOUSEHOLD_ID = "f8044a3a-b8e1-4bea-a3db-d8f4f322b411";
const INGREDIENT_ID = "090824a3-c8d3-49fb-801b-0c24ff5730d4";
const USER_ID = "f69ec2b8-a84c-448b-a26c-6571cd8de311";

type IngredientRow = Readonly<{
  baseUnit: "count" | "g" | "ml";
  densityGramsPerMl: string | null;
  gramsPerCount: string | null;
  id: string;
  name: string;
}>;

type InsertRecord = Readonly<{ table: unknown; values: unknown }>;

function fixture(ingredient: IngredientRow | undefined) {
  const inserts: InsertRecord[] = [];
  const onConflictDoUpdate = vi.fn(async () => undefined);
  const transaction = {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        inserts.push({ table, values });
        return table === pantryItems
          ? { onConflictDoUpdate }
          : Promise.resolve();
      }),
    })),
  };
  const limit = vi.fn(async () => (ingredient ? [ingredient] : []));
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit })),
      })),
    })),
    transaction: vi.fn(
      async (callback: (value: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
  };

  return {
    db,
    inserts,
    onConflictDoUpdate,
    scoped: {
      db,
      scope: { householdId: HOUSEHOLD_ID, userId: USER_ID },
    } as unknown as ScopedDatabase,
  };
}

const flour: IngredientRow = {
  baseUnit: "g",
  densityGramsPerMl: null,
  gramsPerCount: null,
  id: INGREDIENT_ID,
  name: "All-purpose flour",
};

describe("setPantryItemCount", () => {
  it("converts a US quantity and upserts it within the household and user scope", async () => {
    const subject = fixture(flour);

    await expect(
      setPantryItemCount(subject.scoped, {
        canonicalIngredientId: INGREDIENT_ID,
        quantity: 2,
        unit: "lb",
      }),
    ).resolves.toEqual({
      ingredientName: "All-purpose flour",
      quantityInBaseUnit: 907.185,
    });

    expect(
      subject.inserts.find((insert) => insert.table === pantryItems)?.values,
    ).toEqual({
      canonicalIngredientId: INGREDIENT_ID,
      householdId: HOUSEHOLD_ID,
      quantity: "2.000",
      quantityInBaseUnit: "907.185",
      unit: "lb",
      updatedByAppUserId: USER_ID,
    });
    expect(subject.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          quantity: "2.000",
          quantityInBaseUnit: "907.185",
          unit: "lb",
          updatedByAppUserId: USER_ID,
        }),
        target: [pantryItems.householdId, pantryItems.canonicalIngredientId],
      }),
    );
    expect(
      subject.inserts.find((insert) => insert.table === eventLogs)?.values,
    ).toEqual({
      eventType: "pantry.item_counted",
      householdId: HOUSEHOLD_ID,
      payload: {
        canonicalIngredientId: INGREDIENT_ID,
        quantityInBaseUnit: 907.185,
        unit: "lb",
        userId: USER_ID,
      },
    });
  });

  it("allows zero to record an empty pantry count", async () => {
    const subject = fixture(flour);

    await expect(
      setPantryItemCount(subject.scoped, {
        canonicalIngredientId: INGREDIENT_ID,
        quantity: 0,
        unit: "oz",
      }),
    ).resolves.toEqual({
      ingredientName: "All-purpose flour",
      quantityInBaseUnit: 0,
    });

    expect(
      subject.inserts.find((insert) => insert.table === pantryItems)?.values,
    ).toMatchObject({ quantity: "0.000", quantityInBaseUnit: "0.000" });
  });

  it("rejects an invalid quantity before selecting or writing", async () => {
    const subject = fixture(flour);

    await expect(
      setPantryItemCount(subject.scoped, {
        canonicalIngredientId: INGREDIENT_ID,
        quantity: -1,
        unit: "oz",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_QUANTITY",
    });

    expect(subject.db.select).not.toHaveBeenCalled();
    expect(subject.db.transaction).not.toHaveBeenCalled();
  });

  it("rejects an unknown ingredient without writing", async () => {
    const subject = fixture(undefined);

    await expect(
      setPantryItemCount(subject.scoped, {
        canonicalIngredientId: INGREDIENT_ID,
        quantity: 1,
        unit: "oz",
      }),
    ).rejects.toMatchObject({
      code: "INGREDIENT_NOT_FOUND",
    });

    expect(subject.db.transaction).not.toHaveBeenCalled();
  });

  it("rejects a unit that cannot convert for the selected ingredient", async () => {
    const subject = fixture(flour);

    await expect(
      setPantryItemCount(subject.scoped, {
        canonicalIngredientId: INGREDIENT_ID,
        quantity: 1,
        unit: "cup",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_UNIT",
    });

    expect(subject.db.transaction).not.toHaveBeenCalled();
  });
});
