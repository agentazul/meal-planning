import { describe, expect, it, vi } from "vitest";

import {
  eventLogs,
  pantryCustomItems,
  pantryItems,
  pantryRestockBatches,
} from "~/db/schema";
import type { ScopedDatabase } from "~/server/context.server";
import {
  applyPantryRestockBatch,
  createCustomPantryItem,
  getPantryOverview,
  setCustomPantryItemCount,
  setPantryItemCount,
} from "./pantry.server";

const HOUSEHOLD_ID = "f8044a3a-b8e1-4bea-a3db-d8f4f322b411";
const INGREDIENT_ID = "090824a3-c8d3-49fb-801b-0c24ff5730d4";
const USER_ID = "f69ec2b8-a84c-448b-a26c-6571cd8de311";
const CUSTOM_ITEM_ID = "4b075818-e91c-4cb0-af90-0e7b3be53293";
const RESTOCK_BATCH_ID = "690b588d-2de1-45c0-a10f-411d696f7c21";
const SECOND_INGREDIENT_ID = "b1d23c32-9a87-4db1-9b70-4d319bca3e06";

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

function overviewFixture() {
  const catalogRows = [
    {
      baseUnit: "g" as const,
      category: "produce" as const,
      defaultPurchaseDescription: "12 oz bag",
      defaultPurchaseQuantityInBaseUnit: "340.000",
      densityGramsPerMl: null,
      gramsPerCount: null,
      id: INGREDIENT_ID,
      isStaple: false,
      name: "green bean",
      storageClass: "fridge" as const,
    },
  ];
  const requirementRows = [
    {
      baseServings: 4,
      canonicalIngredientId: INGREDIENT_ID,
      isOptional: false,
      planEntryId: "a2f2ffc2-268c-49ca-ac02-63a0f7945347",
      preparation: "trimmed",
      quantity: "16.000",
      quantityInBaseUnit: "453.592",
      recipeId: "c9954f91-828f-4521-bfc4-b72efff37653",
      recipeIngredientId: "56f7ca2b-53d6-451a-8dc1-1e06333f8031",
      recipeTitle: "Steamed green beans",
      scalesLinearly: true,
      scheduledDate: "2026-08-24",
      servingsTarget: 3,
      unit: "oz",
    },
  ];
  const select = vi.fn((selection: Readonly<Record<string, unknown>>) => {
    if ("recipeIngredientId" in selection) {
      return {
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                orderBy: vi.fn(async () => requirementRows),
              })),
            })),
          })),
        })),
      };
    }
    if ("status" in selection) {
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [
              {
                id: "ef633e46-62eb-442f-899f-da1650e33cbd",
                status: "shopping" as const,
              },
            ]),
          })),
        })),
      };
    }
    if ("isStaple" in selection && "updatedAt" in selection) {
      return {
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            leftJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                orderBy: vi.fn(async () => []),
              })),
            })),
          })),
        })),
      };
    }
    if ("isStaple" in selection) {
      return {
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            orderBy: vi.fn(async () => catalogRows),
          })),
        })),
      };
    }
    return {
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(async () => []),
        })),
      })),
    };
  });

  return {
    requirementRows,
    scoped: {
      db: { select },
      scope: { householdId: HOUSEHOLD_ID, userId: USER_ID },
    } as unknown as ScopedDatabase,
    select,
  };
}

describe("getPantryOverview", () => {
  it("retains scheduled recipe-line provenance in pantry contributions", async () => {
    const subject = overviewFixture();

    const result = await getPantryOverview(subject.scoped, "2026-08-23");

    expect(result.requirements).toHaveLength(1);
    expect(result.requirements[0]).toMatchObject({
      canonicalIngredientId: INGREDIENT_ID,
      contributions: [
        {
          baseServings: 4,
          isOptional: false,
          planEntryId: "a2f2ffc2-268c-49ca-ac02-63a0f7945347",
          preparation: "trimmed",
          recipeId: "c9954f91-828f-4521-bfc4-b72efff37653",
          recipeIngredientId: "56f7ca2b-53d6-451a-8dc1-1e06333f8031",
          recipeTitle: "Steamed green beans",
          requiredQuantityInBaseUnit: 340.194,
          scalesLinearly: true,
          scheduledDate: "2026-08-24",
          servingsTarget: 3,
          storedQuantity: 16,
          storedQuantityInBaseUnit: 453.592,
          storedUnit: "oz",
        },
      ],
      requiredQuantityInBaseUnit: 340.194,
    });
  });
});

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

type RestockIngredientRow = Readonly<{
  baseUnit: "count" | "g" | "ml";
  defaultPurchaseQuantityInBaseUnit: string | null;
  densityGramsPerMl: string | null;
  gramsPerCount: string | null;
  id: string;
}>;

function restockFixture({
  created = true,
  existingBatch,
  ingredients,
}: Readonly<{
  created?: boolean;
  existingBatch?: Readonly<{ appliedCount: number; householdId: string }>;
  ingredients: readonly RestockIngredientRow[];
}>) {
  const inserts: InsertRecord[] = [];
  const pantryUpserts: unknown[] = [];
  const onConflictDoUpdate = vi.fn(async (config: unknown) => {
    pantryUpserts.push(config);
  });
  const returning = vi.fn(async () =>
    created ? [{ batchId: RESTOCK_BATCH_ID }] : [],
  );
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const transaction = {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        inserts.push({ table, values });
        if (table === pantryRestockBatches) return { onConflictDoNothing };
        if (table === pantryItems) return { onConflictDoUpdate };
        return Promise.resolve();
      }),
    })),
    select: vi.fn((selection: Readonly<Record<string, unknown>>) => {
      if ("appliedCount" in selection) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => (existingBatch ? [existingBatch] : [])),
            })),
          })),
        };
      }
      return {
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn(async () => ingredients),
          })),
        })),
      };
    }),
  };
  const db = {
    transaction: vi.fn(
      async (callback: (value: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
  };

  return {
    db,
    inserts,
    onConflictDoUpdate,
    pantryUpserts,
    scoped: {
      db,
      scope: { householdId: HOUSEHOLD_ID, userId: USER_ID },
    } as unknown as ScopedDatabase,
    transaction,
  };
}

const flourRestock: RestockIngredientRow = {
  baseUnit: "g",
  defaultPurchaseQuantityInBaseUnit: "907.000",
  densityGramsPerMl: null,
  gramsPerCount: null,
  id: INGREDIENT_ID,
};

const lemonRestock: RestockIngredientRow = {
  baseUnit: "g",
  defaultPurchaseQuantityInBaseUnit: "907.000",
  densityGramsPerMl: null,
  gramsPerCount: "58.000",
  id: INGREDIENT_ID,
};

function restockInput(
  overrides: Partial<Parameters<typeof applyPantryRestockBatch>[1]> = {},
) {
  return {
    batchId: RESTOCK_BATCH_ID,
    items: [
      {
        canonicalIngredientId: INGREDIENT_ID,
        inventoryMode: "purchase" as const,
        packageCount: 1,
        quantity: null,
        unit: "lb" as const,
      },
    ],
    weekStart: "2026-08-17",
    ...overrides,
  };
}

describe("applyPantryRestockBatch", () => {
  it("multiplies the authoritative default package by package count", async () => {
    const subject = restockFixture({ ingredients: [flourRestock] });

    await expect(
      applyPantryRestockBatch(
        subject.scoped,
        restockInput({
          items: [{ ...restockInput().items[0], packageCount: 2 }],
        }),
      ),
    ).resolves.toEqual({ appliedCount: 1, duplicate: false });

    expect(subject.db.transaction).toHaveBeenCalledOnce();
    expect(
      subject.inserts.find((insert) => insert.table === pantryRestockBatches)
        ?.values,
    ).toEqual({
      appUserId: USER_ID,
      appliedCount: 1,
      batchId: RESTOCK_BATCH_ID,
      householdId: HOUSEHOLD_ID,
      weekStartDate: "2026-08-17",
    });
    expect(
      subject.inserts.find((insert) => insert.table === pantryItems)?.values,
    ).toEqual({
      canonicalIngredientId: INGREDIENT_ID,
      householdId: HOUSEHOLD_ID,
      quantity: "3.999",
      quantityInBaseUnit: "1814.000",
      unit: "lb",
      updatedByAppUserId: USER_ID,
    });
    expect(subject.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          quantity: expect.objectContaining({ queryChunks: expect.any(Array) }),
          quantityInBaseUnit: expect.objectContaining({
            queryChunks: expect.any(Array),
          }),
          unit: "lb",
          updatedByAppUserId: USER_ID,
        }),
        target: [pantryItems.householdId, pantryItems.canonicalIngredientId],
      }),
    );
    expect(
      subject.inserts.find((insert) => insert.table === eventLogs)?.values,
    ).toEqual({
      eventType: "pantry.restock_batch_applied",
      householdId: HOUSEHOLD_ID,
      payload: {
        batchId: RESTOCK_BATCH_ID,
        items: [
          {
            canonicalIngredientId: INGREDIENT_ID,
            inventoryMode: "purchase",
            packageCount: 2,
            quantity: 3.999,
            quantityInBaseUnit: 1814,
            unit: "lb",
            usedDefaultPurchaseFormat: true,
          },
        ],
        userId: USER_ID,
        weekStart: "2026-08-17",
      },
    });
  });

  it("normalizes a two-count lemon audible to 116 grams", async () => {
    const subject = restockFixture({ ingredients: [lemonRestock] });

    await applyPantryRestockBatch(
      subject.scoped,
      restockInput({
        items: [
          {
            canonicalIngredientId: INGREDIENT_ID,
            inventoryMode: "purchase",
            packageCount: 2,
            quantity: 2,
            unit: "count",
          },
        ],
      }),
    );

    expect(
      subject.inserts.find((insert) => insert.table === pantryItems)?.values,
    ).toMatchObject({
      quantity: "2.000",
      quantityInBaseUnit: "116.000",
      unit: "count",
    });
    expect(
      subject.inserts.find((insert) => insert.table === eventLogs)?.values,
    ).toMatchObject({
      payload: {
        batchId: RESTOCK_BATCH_ID,
        items: [
          expect.objectContaining({
            packageCount: 2,
            quantity: 2,
            quantityInBaseUnit: 116,
            usedDefaultPurchaseFormat: false,
          }),
        ],
        userId: USER_ID,
        weekStart: "2026-08-17",
      },
    });
  });

  it("replaces the pantry balance when the reviewed amount is a total", async () => {
    const subject = restockFixture({ ingredients: [flourRestock] });

    await applyPantryRestockBatch(
      subject.scoped,
      restockInput({
        items: [
          {
            canonicalIngredientId: INGREDIENT_ID,
            inventoryMode: "total",
            packageCount: 1,
            quantity: 3,
            unit: "lb",
          },
        ],
      }),
    );

    expect(subject.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          quantity: "3.000",
          quantityInBaseUnit: "1360.777",
          unit: "lb",
          updatedByAppUserId: USER_ID,
        }),
      }),
    );
  });

  it("returns the stored count on replay without pantry or audit writes", async () => {
    const subject = restockFixture({
      created: false,
      existingBatch: { appliedCount: 7, householdId: HOUSEHOLD_ID },
      ingredients: [],
    });

    await expect(
      applyPantryRestockBatch(subject.scoped, restockInput()),
    ).resolves.toEqual({ appliedCount: 7, duplicate: true });

    expect(subject.transaction.select).toHaveBeenCalledOnce();
    expect(
      subject.inserts.filter((insert) => insert.table === pantryItems),
    ).toHaveLength(0);
    expect(
      subject.inserts.filter((insert) => insert.table === eventLogs),
    ).toHaveLength(0);
  });

  it("rejects a replay token owned by another household", async () => {
    const subject = restockFixture({
      created: false,
      existingBatch: {
        appliedCount: 1,
        householdId: "bed4663d-80f4-408c-8c6a-c46635a827f5",
      },
      ingredients: [],
    });

    await expect(
      applyPantryRestockBatch(subject.scoped, restockInput()),
    ).rejects.toMatchObject({ code: "INVALID_RESTOCK_BATCH" });
    expect(
      subject.inserts.filter((insert) => insert.table === pantryItems),
    ).toHaveLength(0);
    expect(
      subject.inserts.filter((insert) => insert.table === eventLogs),
    ).toHaveLength(0);
  });

  it.each([
    { expectedCode: "INGREDIENT_NOT_FOUND", ingredients: [] },
    {
      expectedCode: "PURCHASE_FORMAT_NOT_FOUND",
      ingredients: [
        { ...flourRestock, defaultPurchaseQuantityInBaseUnit: null },
      ],
    },
  ])(
    "rejects a missing ingredient or package before pantry writes ($expectedCode)",
    async ({ expectedCode, ingredients }) => {
      const subject = restockFixture({ ingredients });

      await expect(
        applyPantryRestockBatch(subject.scoped, restockInput()),
      ).rejects.toMatchObject({ code: expectedCode });
      expect(
        subject.inserts.filter((insert) => insert.table === pantryItems),
      ).toHaveLength(0);
      expect(
        subject.inserts.filter((insert) => insert.table === eventLogs),
      ).toHaveLength(0);
    },
  );

  it("rejects duplicate ingredient IDs before opening a transaction", async () => {
    const subject = restockFixture({ ingredients: [flourRestock] });
    const duplicateItem = restockInput().items[0];

    await expect(
      applyPantryRestockBatch(
        subject.scoped,
        restockInput({ items: [duplicateItem, duplicateItem] }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESTOCK_BATCH" });
    expect(subject.db.transaction).not.toHaveBeenCalled();
  });

  it("applies multiple groceries in one transaction and writes one household-scoped audit", async () => {
    const secondIngredient = {
      ...flourRestock,
      defaultPurchaseQuantityInBaseUnit: "454.000",
      id: SECOND_INGREDIENT_ID,
    };
    const subject = restockFixture({
      ingredients: [flourRestock, secondIngredient],
    });

    await applyPantryRestockBatch(
      subject.scoped,
      restockInput({
        items: [
          restockInput().items[0],
          {
            canonicalIngredientId: SECOND_INGREDIENT_ID,
            inventoryMode: "purchase",
            packageCount: 1,
            quantity: null,
            unit: "oz",
          },
        ],
      }),
    );

    expect(subject.db.transaction).toHaveBeenCalledOnce();
    expect(
      subject.inserts.filter((insert) => insert.table === pantryItems),
    ).toHaveLength(2);
    const auditWrites = subject.inserts.filter(
      (insert) => insert.table === eventLogs,
    );
    expect(auditWrites).toHaveLength(1);
    expect(auditWrites[0]?.values).toMatchObject({
      householdId: HOUSEHOLD_ID,
      payload: {
        items: expect.arrayContaining([expect.any(Object), expect.any(Object)]),
      },
    });
  });
});

function customCreateFixture(
  canonicalRows: readonly Readonly<{
    aliases: readonly string[];
    name: string;
  }>[] = [],
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
      subject.inserts.find((insert) => insert.table === pantryCustomItems)
        ?.values,
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
      subject.inserts.find((insert) => insert.table === pantryCustomItems)
        ?.values,
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
