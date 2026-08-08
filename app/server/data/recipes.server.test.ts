import { describe, expect, it } from "vitest";

import {
  type RecipeIngredientInput,
  withRecipeIngredientPositions,
} from "./recipes.server";

function ingredient(name: string): RecipeIngredientInput {
  return {
    canonicalIngredientId: name,
    isOptional: false,
    preparation: null,
    quantity: 1,
    quantityInBaseUnit: 1,
    scalesLinearly: true,
    unit: "count",
  };
}

describe("withRecipeIngredientPositions", () => {
  it("assigns stable one-based positions without changing input order", () => {
    const positioned = withRecipeIngredientPositions([
      ingredient("chicken"),
      ingredient("lemon"),
      ingredient("oil"),
    ]);

    expect(
      positioned.map(({ canonicalIngredientId, position }) => ({
        canonicalIngredientId,
        position,
      })),
    ).toEqual([
      { canonicalIngredientId: "chicken", position: 1 },
      { canonicalIngredientId: "lemon", position: 2 },
      { canonicalIngredientId: "oil", position: 3 },
    ]);
  });
});
