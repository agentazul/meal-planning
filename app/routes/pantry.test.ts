import { describe, expect, it } from "vitest";

import type { PantryRequirementRow } from "~/domain/pantry";
import {
  getPantryShoppingFinalizationBlocker,
  parsePantryRestockFormData,
  resolvePackageFitShoppingPlan,
} from "./pantry";

const BATCH_ID = "690b588d-2de1-45c0-a10f-411d696f7c21";
const FLOUR_ID = "090824a3-c8d3-49fb-801b-0c24ff5730d4";
const LEMON_ID = "b1d23c32-9a87-4db1-9b70-4d319bca3e06";

function formHeader() {
  const formData = new FormData();
  formData.set("restockBatchId", BATCH_ID);
  formData.set("weekStart", "2026-08-17");
  return formData;
}

function appendRestockRow(
  formData: FormData,
  input: Readonly<{
    id: string;
    inventoryMode?: string;
    packageCount?: string;
    quantity?: string;
    selected?: boolean;
    unit?: string;
  }>,
) {
  if (input.selected !== false) {
    formData.append("restockIngredientId", input.id);
  }
  formData.append(`restockQuantity:${input.id}`, input.quantity ?? "1");
  formData.append(`restockUnit:${input.id}`, input.unit ?? "lb");
  formData.append(`restockMode:${input.id}`, input.inventoryMode ?? "purchase");
  formData.append(`restockPackageCount:${input.id}`, input.packageCount ?? "1");
}

describe("parsePantryRestockFormData", () => {
  it("parses repeated no-JavaScript row fields by selected ingredient ID", () => {
    const formData = formHeader();
    appendRestockRow(formData, { id: FLOUR_ID, quantity: "2", unit: "lb" });
    appendRestockRow(formData, {
      id: LEMON_ID,
      inventoryMode: "total",
      quantity: "2",
      unit: "count",
    });

    expect(parsePantryRestockFormData(formData)).toEqual({
      data: {
        batchId: BATCH_ID,
        items: [
          {
            canonicalIngredientId: FLOUR_ID,
            inventoryMode: "purchase",
            packageCount: 1,
            quantity: 2,
            unit: "lb",
          },
          {
            canonicalIngredientId: LEMON_ID,
            inventoryMode: "total",
            packageCount: 1,
            quantity: 2,
            unit: "count",
          },
        ],
        weekStart: "2026-08-17",
      },
      success: true,
    });
  });

  it("maps a blank amount to the authoritative default package", () => {
    const formData = formHeader();
    appendRestockRow(formData, {
      id: FLOUR_ID,
      quantity: "   ",
      unit: "lb",
    });

    expect(parsePantryRestockFormData(formData)).toMatchObject({
      data: {
        items: [
          {
            canonicalIngredientId: FLOUR_ID,
            packageCount: 1,
            quantity: null,
          },
        ],
      },
      success: true,
    });
  });

  it("submits the same whole-package count shown in the grocery review", () => {
    const formData = formHeader();
    appendRestockRow(formData, {
      id: FLOUR_ID,
      packageCount: "3",
      quantity: "   ",
    });

    expect(parsePantryRestockFormData(formData)).toMatchObject({
      data: { items: [{ packageCount: 3, quantity: null }] },
      success: true,
    });
  });

  it("ignores complete fields for an unchecked grocery", () => {
    const formData = formHeader();
    appendRestockRow(formData, { id: FLOUR_ID, quantity: "2" });
    appendRestockRow(formData, {
      id: LEMON_ID,
      quantity: "4",
      selected: false,
      unit: "count",
    });

    const result = parsePantryRestockFormData(formData);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.items).toHaveLength(1);
      expect(result.data.items[0]?.canonicalIngredientId).toBe(FLOUR_ID);
    }
  });

  it("rejects duplicate selected ingredient IDs", () => {
    const formData = formHeader();
    appendRestockRow(formData, { id: FLOUR_ID });
    formData.append("restockIngredientId", FLOUR_ID);

    expect(parsePantryRestockFormData(formData)).toEqual({
      error: "A grocery can only be added once per review.",
      success: false,
    });
  });

  it("rejects a review with no selected groceries", () => {
    expect(parsePantryRestockFormData(formHeader())).toEqual({
      error: "Select at least one grocery to add.",
      success: false,
    });
  });

  it.each([
    {
      label: "package count below one",
      mutate: (formData: FormData) =>
        formData.set(`restockPackageCount:${FLOUR_ID}`, "0"),
    },
    {
      label: "fractional package count",
      mutate: (formData: FormData) =>
        formData.set(`restockPackageCount:${FLOUR_ID}`, "1.5"),
    },
    {
      label: "package count above limit",
      mutate: (formData: FormData) =>
        formData.set(`restockPackageCount:${FLOUR_ID}`, "101"),
    },
    {
      label: "quantity",
      mutate: (formData: FormData) =>
        formData.set(`restockQuantity:${FLOUR_ID}`, "0"),
    },
    {
      label: "unit",
      mutate: (formData: FormData) =>
        formData.set(`restockUnit:${FLOUR_ID}`, "kg"),
    },
    {
      label: "inventory mode",
      mutate: (formData: FormData) =>
        formData.set(`restockMode:${FLOUR_ID}`, "subtract"),
    },
    {
      label: "week",
      mutate: (formData: FormData) => formData.set("weekStart", "2026-02-30"),
    },
    {
      label: "batch UUID",
      mutate: (formData: FormData) =>
        formData.set("restockBatchId", "not-a-uuid"),
    },
    {
      label: "ingredient UUID",
      mutate: (formData: FormData) => {
        formData.delete("restockIngredientId");
        formData.append("restockIngredientId", "not-a-uuid");
      },
    },
  ])("rejects an invalid $label", ({ mutate }) => {
    const formData = formHeader();
    appendRestockRow(formData, { id: FLOUR_ID });
    mutate(formData);

    expect(parsePantryRestockFormData(formData).success).toBe(false);
  });

  it("rejects more than 100 selected groceries before parsing rows", () => {
    const formData = formHeader();
    for (let index = 1; index <= 101; index += 1) {
      formData.append(
        "restockIngredientId",
        `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      );
    }

    expect(parsePantryRestockFormData(formData)).toEqual({
      error: "Add no more than 100 groceries at a time.",
      success: false,
    });
  });

  it("rejects duplicate indexed amount fields for one selected grocery", () => {
    const formData = formHeader();
    appendRestockRow(formData, { id: FLOUR_ID });
    formData.append(`restockQuantity:${FLOUR_ID}`, "3");

    expect(parsePantryRestockFormData(formData)).toEqual({
      error:
        "Each selected grocery needs one package count, amount, and measurement.",
      success: false,
    });
  });

  it("rejects a missing package count for a selected grocery", () => {
    const formData = formHeader();
    appendRestockRow(formData, { id: FLOUR_ID });
    formData.delete(`restockPackageCount:${FLOUR_ID}`);

    expect(parsePantryRestockFormData(formData)).toEqual({
      error:
        "Each selected grocery needs one package count, amount, and measurement.",
      success: false,
    });
  });

  it("rejects duplicate package counts for one selected grocery", () => {
    const formData = formHeader();
    appendRestockRow(formData, { id: FLOUR_ID });
    formData.append(`restockPackageCount:${FLOUR_ID}`, "2");

    expect(parsePantryRestockFormData(formData)).toEqual({
      error:
        "Each selected grocery needs one package count, amount, and measurement.",
      success: false,
    });
  });
});

function requirement(
  coverage: PantryRequirementRow["coverage"],
  optionalOnly = false,
): PantryRequirementRow {
  return {
    canonicalIngredientId: FLOUR_ID,
    contributions: [],
    coverage,
    currentQuantityInBaseUnit: coverage === "uncounted" ? null : 0,
    optionalOnly,
    recipeTitles: ["Dinner"],
    requiredQuantityInBaseUnit: 100,
    shortageQuantityInBaseUnit: coverage === "short" ? 100 : 0,
  };
}

describe("getPantryShoppingFinalizationBlocker", () => {
  it("blocks final output until every unknown is counted", () => {
    expect(
      getPantryShoppingFinalizationBlocker([requirement("uncounted")], 0),
    ).toBe("count-ingredients");
  });

  it("also blocks an optional unknown before it can inherit a default package", () => {
    expect(
      getPantryShoppingFinalizationBlocker(
        [requirement("uncounted", true)],
        0,
      ),
    ).toBe("count-ingredients");
  });

  it("blocks a counted list on unresolved material package fit", () => {
    expect(
      getPantryShoppingFinalizationBlocker([requirement("short")], 1),
    ).toBe("resolve-package-fit");
  });

  it("allows a counted list whose package decisions are resolved", () => {
    expect(
      getPantryShoppingFinalizationBlocker([requirement("short")], 0),
    ).toBeNull();
  });
});

describe("resolvePackageFitShoppingPlan", () => {
  const fallback = { label: "2 lb bag", packageCount: 1 };

  it("carries the exact alternate label and amount into export and restock", () => {
    expect(
      resolvePackageFitShoppingPlan(
        {
          canonicalIngredientId: LEMON_ID,
          customLabel: "2 large lemons",
          customQuantity: 2,
          customUnit: "count",
          kind: "custom_store_amount",
        },
        fallback,
      ),
    ).toEqual({
      label: "2 large lemons",
      packageCount: 1,
      quantity: 2,
      unit: "count",
    });
  });

  it("keeps the whole-package fallback when the recipe is preserved", () => {
    expect(
      resolvePackageFitShoppingPlan(
        {
          canonicalIngredientId: FLOUR_ID,
          customLabel: null,
          customQuantity: null,
          customUnit: null,
          kind: "keep_recipe_buy_enough",
        },
        { label: "12 oz bag", packageCount: 2 },
      ),
    ).toEqual({
      label: "12 oz bag",
      packageCount: 2,
      quantity: null,
      unit: null,
    });
  });
});
