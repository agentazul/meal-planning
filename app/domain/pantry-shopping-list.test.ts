import { describe, expect, it, vi } from "vitest";

import {
  APPLE_NOTES_SHORTCUT_NAME,
  PANTRY_SHOPPING_CATEGORY_METADATA,
  buildAppleNotesShortcutUrl,
  buildPantryShoppingChecklistInput,
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
      launchAppleNotesShortcut(
        "Onion: 3-count bag",
        {
          copyText,
          openUrl,
        },
      ),
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
