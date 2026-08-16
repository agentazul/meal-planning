import { describe, expect, it, vi } from "vitest";

import { eventLogs, pantryCustomItems, pantryItems } from "~/db/schema";
import type { ScopedDatabase } from "~/server/context.server";
import {
  createCustomPantryItem,
  setCustomPantryItemCount,
  setPantryItemCount,
} from "./pantry.server";

const HOUSEHOLD_ID = "f8044a3a-b8e1-4bea-a3db-d8f4f322b411";
const INGREDIENT_ID = "090824a3-c8d3-49fb-801b-0c24ff5730d4";
const USER_ID = "f69ec2b8-a84c-448b-a26c-6571cd8de311";
const CUSTOM_ITEM_ID = "4b075818-e91c-4cb0-af90-0e7b3be53293";

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

function customCreateFixture(
  canonicalRows: readonly Readonly<{ aliases: readonly string[]; name: string }>[] = [],
  transactionError?: unknown,
) {
  const inserts: InsertRecord[] = [];
  const returning = vi.fn(async () => [{ id: CUSTOM_ITEM_ID }]);
  const transaction = {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        inserts.push({ table, values });
        return table === pantryCustomItems ? { returning } : Promise.resolve();
      }),
    })),
  };
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(async () => canonicalRows),
    })),
    transaction: vi.fn(
      async (callback: (value: typeof transaction) => Promise<unknown>) => {
        if (transactionError) throw transactionError;
        return callback(transaction);
      },
    ),
  };
  return {
    db,
    inserts,
    scoped: {
      db,
      scope: { householdId: HOUSEHOLD_ID, userId: USER_ID },
    } as unknown as ScopedDatabase,
  };
}

describe("createCustomPantryItem", () => {
  it("creates and counts a household-scoped custom item atomically", async () => {
    const subject = customCreateFixture();

    await expect(
      createCustomPantryItem(subject.scoped, {
        name: "  Grandma's   salsa  ",
        quantity: 2,
        storageClass: "fridge",
        unit: "cup",
      }),
    ).resolves.toEqual({
      id: CUSTOM_ITEM_ID,
      ingredientName: "Grandma's salsa",
      quantityInBaseUnit: 473.176,
    });

    expect(
      subject.inserts.find((insert) => insert.table === pantryCustomItems)?.values,
    ).toEqual({
      baseUnit: "ml",
      householdId: HOUSEHOLD_ID,
      name: "Grandma's salsa",
      nameKey: "grandma's salsa",
      quantity: "2.000",
      quantityInBaseUnit: "473.176",
      storageClass: "fridge",
      unit: "cup",
      updatedByAppUserId: USER_ID,
    });
    expect(
      subject.inserts.find((insert) => insert.table === eventLogs)?.values,
    ).toEqual({
      eventType: "pantry.custom_item_created",
      householdId: HOUSEHOLD_ID,
      payload: {
        customPantryItemId: CUSTOM_ITEM_ID,
        quantityInBaseUnit: 473.176,
        unit: "cup",
        userId: USER_ID,
      },
    });
  });

  it("accepts a zero count and derives count as its canonical unit", async () => {
    const subject = customCreateFixture();

    await createCustomPantryItem(subject.scoped, {
      name: "Freezer burrito",
      quantity: 0,
      storageClass: "freezer",
      unit: "count",
    });

    expect(
      subject.inserts.find((insert) => insert.table === pantryCustomItems)?.values,
    ).toMatchObject({
      baseUnit: "count",
      quantity: "0.000",
      quantityInBaseUnit: "0.000",
    });
  });

  it("rejects a canonical name or alias before writing", async () => {
    const subject = customCreateFixture([
      { aliases: ["garbanzo bean"], name: "chickpea" },
    ]);

    await expect(
      createCustomPantryItem(subject.scoped, {
        name: " Garbanzo   Bean ",
        quantity: 1,
        storageClass: "pantry",
        unit: "lb",
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_CUSTOM_ITEM" });
    expect(subject.db.transaction).not.toHaveBeenCalled();
  });

  it("rejects blank and overlong names before reading or writing", async () => {
    for (const name of ["   ", "a".repeat(101)]) {
      const subject = customCreateFixture();
      await expect(
        createCustomPantryItem(subject.scoped, {
          name,
          quantity: 1,
          storageClass: "pantry",
          unit: "oz",
        }),
      ).rejects.toMatchObject({ code: "INVALID_NAME" });
      expect(subject.db.select).not.toHaveBeenCalled();
      expect(subject.db.transaction).not.toHaveBeenCalled();
    }
  });

  it("returns a pantry error when the household already has that custom name", async () => {
    const subject = customCreateFixture([], { code: "23505" });

    await expect(
      createCustomPantryItem(subject.scoped, {
        name: "Bulk snack mix",
        quantity: 1,
        storageClass: "pantry",
        unit: "lb",
      }),
    ).rejects.toMatchObject({
      code: "DUPLICATE_CUSTOM_ITEM",
      userMessage:
        "That custom item is already in your pantry. Choose it from the list to update its count.",
    });
  });
});

function customCountFixture(
  item:
    | Readonly<{ baseUnit: "count" | "g" | "ml"; id: string; name: string }>
    | undefined,
) {
  const inserts: InsertRecord[] = [];
  const updateWhere = vi.fn(async () => undefined);
  const transaction = {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        inserts.push({ table, values });
        return Promise.resolve();
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: updateWhere })),
    })),
  };
  const limit = vi.fn(async () => (item ? [item] : []));
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })),
    })),
    transaction: vi.fn(
      async (callback: (value: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
  };
  return {
    db,
    inserts,
    scoped: {
      db,
      scope: { householdId: HOUSEHOLD_ID, userId: USER_ID },
    } as unknown as ScopedDatabase,
    transaction,
    updateWhere,
  };
}

describe("setCustomPantryItemCount", () => {
  it("updates only the scoped custom row and audits the count", async () => {
    const subject = customCountFixture({
      baseUnit: "g",
      id: CUSTOM_ITEM_ID,
      name: "Bulk snack mix",
    });

    await expect(
      setCustomPantryItemCount(subject.scoped, {
        customPantryItemId: CUSTOM_ITEM_ID,
        quantity: 3,
        unit: "lb",
      }),
    ).resolves.toEqual({
      ingredientName: "Bulk snack mix",
      quantityInBaseUnit: 1360.777,
    });
    expect(subject.transaction.update).toHaveBeenCalledWith(pantryCustomItems);
    expect(subject.updateWhere).toHaveBeenCalledOnce();
    expect(
      subject.inserts.find((insert) => insert.table === eventLogs)?.values,
    ).toMatchObject({
      eventType: "pantry.custom_item_counted",
      householdId: HOUSEHOLD_ID,
      payload: {
        customPantryItemId: CUSTOM_ITEM_ID,
        quantityInBaseUnit: 1360.777,
        unit: "lb",
        userId: USER_ID,
      },
    });
  });

  it("does not write when the custom item is outside the household scope", async () => {
    const subject = customCountFixture(undefined);

    await expect(
      setCustomPantryItemCount(subject.scoped, {
        customPantryItemId: CUSTOM_ITEM_ID,
        quantity: 1,
        unit: "count",
      }),
    ).rejects.toMatchObject({ code: "INGREDIENT_NOT_FOUND" });
    expect(subject.db.transaction).not.toHaveBeenCalled();
  });
});
