import { describe, expect, it, vi } from "vitest";

import {
  APPLE_NOTES_SHORTCUT_NAME,
  PANTRY_SHOPPING_CATEGORY_METADATA,
  buildAppleNotesShortcutUrl,
  buildPantryShoppingChecklistInput,
  calculatePantryPackageCount,
  formatPantryPackageRecommendation,
  groupPantryShoppingItemsByCategory,
  launchAppleNotesShortcut,
  type PantryShoppingListExportItem,
} from "./pantry-shopping-list";

const item = (
  overrides: Partial<PantryShoppingListExportItem>,
): PantryShoppingListExportItem => ({
  category: "produce",
  coverage: "short",
  defaultPurchaseDescription: null,
  name: "yellow onion",
  optionalOnly: false,
  packageCount: 1,
  ...overrides,
});

describe("buildPantryShoppingChecklistInput", () => {
  it("groups actionable rows by store category and status", () => {
    const text = buildPantryShoppingChecklistInput([
      item({
        category: "pantry",
        coverage: "uncounted",
        name: "olive oil",
      }),
      item({
        category: "protein",
        defaultPurchaseDescription: "1-pound package",
        name: "ground beef",
      }),
      item({
        coverage: "uncounted",
        name: "cilantro",
        optionalOnly: true,
      }),
      item({ defaultPurchaseDescription: "3-count bag" }),
      item({
        category: "produce",
        coverage: "uncounted",
        name: "garlic",
      }),
      item({
        category: "produce",
        name: "lime",
        optionalOnly: true,
      }),
      item({ category: "spice", coverage: "enough", name: "salt" }),
    ]);

    expect(text.split("\n")).toEqual([
      "PRODUCE",
      "Yellow onion: 3-count bag",
      "Garlic",
      "Cilantro",
      "Lime",
      "PROTEINS",
      "Ground beef: 1-pound package",
      "DRY GOODS & PANTRY",
      "Olive oil",
    ]);
    expect(text.match(/^PRODUCE$/gm)).toHaveLength(1);
    expect(text.match(/^PROTEINS$/gm)).toHaveLength(1);
    expect(text.match(/^DRY GOODS & PANTRY$/gm)).toHaveLength(1);
    expect(text).not.toContain("PRODUCE ·");
    expect(text).not.toContain("Salt");
    expect(text).not.toContain("☐");
    expect(text).not.toMatch(/Buy|Check pantry|Optional|Package reference/);
    expect(text.split("\n")).not.toContain("");
  });

  it("returns no checklist rows when saved counts cover every item", () => {
    const text = buildPantryShoppingChecklistInput([
      item({ coverage: "enough", name: "rice" }),
    ]);

    expect(text).toBe("");
  });

  it("includes the number of whole packages needed in exported rows", () => {
    const text = buildPantryShoppingChecklistInput([
      item({
        defaultPurchaseDescription: "12 oz bag",
        name: "green bean",
        packageCount: 2,
      }),
    ]);

    expect(text.split("\n")).toEqual(["PRODUCE", "Green bean: 2 × 12 oz bag"]);
  });

  it("preserves an exact alternate store decision instead of the catalog bag", () => {
    const text = buildPantryShoppingChecklistInput([
      item({
        defaultPurchaseDescription: "2 large lemons",
        name: "lemon",
        packageCount: 1,
      }),
    ]);

    expect(text.split("\n")).toEqual(["PRODUCE", "Lemon: 2 large lemons"]);
    expect(text).not.toContain("2 lb bag");
  });

  it("builds a short launch URL without an embedded input payload", () => {
    const url = new URL(buildAppleNotesShortcutUrl());

    expect(url.protocol).toBe("shortcuts:");
    expect(url.searchParams.get("name")).toBe(APPLE_NOTES_SHORTCUT_NAME);
    expect(url.searchParams.has("input")).toBe(false);
    expect(url.searchParams.has("text")).toBe(false);
    expect(url.toString().length).toBeLessThan(150);
  });

  it("copies a long checklist before opening the short URL", async () => {
    const events: string[] = [];
    const checklistInput = Array.from(
      { length: 40 },
      (_, index) => `Item ${index + 1}: 1-count package`,
    ).join("\n");
    const copyText = vi.fn(async (text: string) => {
      expect(text).toBe(checklistInput);
      events.push("copied");
    });
    const openUrl = vi.fn((url: string) => {
      expect(url).toBe(buildAppleNotesShortcutUrl());
      expect(url).not.toContain(encodeURIComponent(checklistInput));
      events.push("opened");
    });

    await launchAppleNotesShortcut(checklistInput, { copyText, openUrl });

    expect(events).toEqual(["copied", "opened"]);
    expect(copyText).toHaveBeenCalledOnce();
    expect(openUrl).toHaveBeenCalledOnce();
  });

  it("does not open Shortcuts when clipboard preparation fails", async () => {
    const copyError = new Error("Clipboard unavailable");
    const copyText = vi.fn(async () => {
      throw copyError;
    });
    const openUrl = vi.fn();

    await expect(
      launchAppleNotesShortcut("Onion: 3-count bag", {
        copyText,
        openUrl,
      }),
    ).rejects.toBe(copyError);

    expect(openUrl).not.toHaveBeenCalled();
  });

  it("does not copy or open an empty checklist", async () => {
    const copyText = vi.fn(async () => undefined);
    const openUrl = vi.fn();

    await expect(
      launchAppleNotesShortcut("  \n", { copyText, openUrl }),
    ).rejects.toThrow("without rows");

    expect(copyText).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe("pantry package recommendation", () => {
  it("rounds a 16 ounce need up to two 12 ounce bags", () => {
    expect(calculatePantryPackageCount(16, 12)).toBe(2);
    expect(formatPantryPackageRecommendation("12 oz bag", 2)).toBe(
      "2 × 12 oz bag",
    );
  });

  it("does not add a package for floating point noise at an exact boundary", () => {
    expect(calculatePantryPackageCount(24.0000000001, 12)).toBe(2);
  });

  it("keeps a single package description unprefixed", () => {
    expect(calculatePantryPackageCount(12, 12)).toBe(1);
    expect(formatPantryPackageRecommendation("12 oz bag", 1)).toBe("12 oz bag");
  });

  it("falls back to one package when no default package quantity is available", () => {
    expect(calculatePantryPackageCount(16, null)).toBe(1);
    expect(formatPantryPackageRecommendation(null, 1)).toBeNull();
  });
});

describe("groupPantryShoppingItemsByCategory", () => {
  it("returns only nonempty groups in store order without mutating item order", () => {
    const items = [
      { category: "spice" as const, name: "cumin" },
      { category: "produce" as const, name: "onion" },
      { category: "spice" as const, name: "paprika" },
      { category: "frozen" as const, name: "peas" },
    ];
    const original = [...items];

    const groups = groupPantryShoppingItemsByCategory(
      items,
      (value) => value.category,
    );

    expect(groups).toEqual([
      { category: "produce", label: "Produce", items: [items[1]] },
      { category: "frozen", label: "Frozen", items: [items[3]] },
      {
        category: "spice",
        label: "Seasonings & Spices",
        items: [items[0], items[2]],
      },
    ]);
    expect(items).toEqual(original);
  });

  it("exports the complete fixed category order and labels", () => {
    expect(PANTRY_SHOPPING_CATEGORY_METADATA).toEqual([
      { category: "produce", label: "Produce" },
      { category: "protein", label: "Proteins" },
      { category: "dairy", label: "Dairy & Refrigerated" },
      { category: "bakery", label: "Bakery & Bread" },
      { category: "frozen", label: "Frozen" },
      { category: "pantry", label: "Dry Goods & Pantry" },
      { category: "spice", label: "Seasonings & Spices" },
      { category: "other", label: "Other" },
    ]);
  });
});
