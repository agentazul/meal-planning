import { describe, expect, it } from "vitest";

import {
  formatAlternateStoreChoice,
  PACKAGE_FIT_RESULT_ANCHOR,
  parsePantryPackageFitAction,
  reviewUrl,
  splitPackageFitInstructions,
} from "./pantry-package-fit";

const WEEK = "2026-08-23";
const INGREDIENT_ID = "11111111-1111-4111-8111-111111111111";
const RECIPE_ID = "22222222-2222-4222-8222-222222222222";
const RECIPE_INGREDIENT_ID = "33333333-3333-4333-8333-333333333333";

function baseForm(intent: string): FormData {
  const formData = new FormData();
  formData.set("canonicalIngredientId", INGREDIENT_ID);
  formData.set("intent", intent);
  formData.set("weekStart", WEEK);
  return formData;
}

describe("parsePantryPackageFitAction", () => {
  it("parses the explicit keep-recipe path", () => {
    expect(parsePantryPackageFitAction(baseForm("keep-recipe"))).toEqual({
      data: {
        canonicalIngredientId: INGREDIENT_ID,
        intent: "keep-recipe",
        weekStart: WEEK,
      },
      success: true,
    });
  });

  it("preserves the two-large-lemons alternate instead of the default two-pound bag", () => {
    const formData = baseForm("alternate-store");
    formData.set("quantity", "2");
    formData.set("shoppingLabel", "2 large lemons");
    formData.set("unit", "count");

    expect(parsePantryPackageFitAction(formData)).toEqual({
      data: {
        canonicalIngredientId: INGREDIENT_ID,
        intent: "alternate-store",
        quantity: 2,
        shoppingLabel: "2 large lemons",
        unit: "count",
        weekStart: WEEK,
      },
      success: true,
    });
  });

  it("rejects zero and negative alternate amounts", () => {
    for (const quantity of ["0", "-2"]) {
      const formData = baseForm("alternate-store");
      formData.set("quantity", quantity);
      formData.set("shoppingLabel", "");
      formData.set("unit", "count");

      expect(parsePantryPackageFitAction(formData)).toMatchObject({
        success: false,
      });
    }
  });

  it("requires an explicit permanent-change acknowledgement", () => {
    const formData = baseForm("edit-saved-recipe");
    formData.set("expectedRecipeUpdatedAt", "2026-08-23T12:00:00.000Z");
    formData.set("instructions", "Slice the lemons.\nAdd to the pan.");
    formData.set("quantity", "2");
    formData.set("recipeId", RECIPE_ID);
    formData.set("recipeIngredientId", RECIPE_INGREDIENT_ID);
    formData.set("unit", "count");

    expect(parsePantryPackageFitAction(formData)).toEqual({
      error: "Confirm that you reviewed the servings and every method step.",
      success: false,
    });

    formData.set("acknowledgedPermanentChange", "true");
    expect(parsePantryPackageFitAction(formData)).toMatchObject({
      data: {
        acknowledgedPermanentChange: true,
        intent: "edit-saved-recipe",
        quantity: 2,
      },
      success: true,
    });
  });
});

describe("splitPackageFitInstructions", () => {
  it("normalizes editable method lines into ordered instructions", () => {
    expect(
      splitPackageFitInstructions(
        " Slice the lemons. \n\nAdd to the pan.\r\n Serve. ",
      ),
    ).toEqual([
      { instruction: "Slice the lemons.", position: 1 },
      { instruction: "Add to the pan.", position: 2 },
      { instruction: "Serve.", position: 3 },
    ]);
  });
});

describe("formatAlternateStoreChoice", () => {
  it("shows two large lemons as a resolution distinct from the two-pound bag", () => {
    expect(
      formatAlternateStoreChoice(
        {
          customLabel: "2 large lemons",
          customQuantity: 2,
          customUnit: "count",
        },
        "2 lb bag",
      ),
    ).toBe("2 large lemons (2 count), instead of 2 lb bag.");
  });
});

describe("reviewUrl", () => {
  it("anchors successful package-fit redirects to visible feedback", () => {
    expect(reviewUrl(WEEK, { saved: "recipe" })).toBe(
      `/pantry/package-fit?week=${WEEK}&saved=recipe#${PACKAGE_FIT_RESULT_ANCHOR}`,
    );
  });

  it("anchors error redirects to visible feedback", () => {
    expect(reviewUrl(WEEK, { error: "unchanged" })).toBe(
      `/pantry/package-fit?week=${WEEK}&error=unchanged#${PACKAGE_FIT_RESULT_ANCHOR}`,
    );
  });
});
