import { describe, expect, it } from "vitest";

import { canonicalIngredients } from "~/data/ingredients";

import {
  extractNeverUseItems,
  matchNeverUseIngredients,
  withoutNeverUseIngredients,
} from "./never-use-ingredients";

const references = canonicalIngredients.map((ingredient) => ({
  aliases: ingredient.aliases,
  category: ingredient.category,
  id: ingredient.slug,
  name: ingredient.name,
  pluralName: ingredient.pluralName,
}));

function excludedNames(markdown: string): readonly string[] {
  return matchNeverUseIngredients(markdown, references).excluded.map(
    (reference) => reference.name,
  );
}

describe("never use ingredients", () => {
  it("reads bullets under a Never use heading until the next peer heading", () => {
    expect(
      extractNeverUseItems(`# Kitchen

## Never use

Ingredients listed here are removed from suggestions, like "- Pork".

- Pork
* mushrooms, olives

### Notes

- cilantro

## Foods and cuisines

- Rotate chicken and beef.
`),
    ).toEqual(["Pork", "mushrooms", "olives", "cilantro"]);
  });

  it("reads inline Never use lines anywhere in the note", () => {
    expect(
      extractNeverUseItems(
        "## Hard nos\n\n- **Never use:** pork; blue cheese\n- Do not create gimmicky meals.",
      ),
    ).toEqual(["pork", "blue cheese"]);
  });

  it("ignores ordinary preference text that only mentions an ingredient", () => {
    expect(
      excludedNames(`## Flavor

- Season every protein: chicken, beef, pork, shrimp, and fish.

## Hard nos

- Do not require a hard-to-find ingredient for the meal to work.
`),
    ).toEqual([]);
  });

  it("expands pork to every pork-based catalog protein", () => {
    expect(excludedNames("## Never use\n\n- Pork")).toEqual([
      "bacon",
      "breakfast sausage",
      "deli ham",
      "frozen meatball",
      "ground pork",
      "ham steak",
      "hot dog",
      "Italian sausage",
      "kielbasa",
      "pork chop",
      "pork shoulder",
      "pork tenderloin",
    ]);
  });

  it("expands families listed together and matches plural and alias names", () => {
    expect(
      excludedNames(
        "## Never use\n\n- Shellfish or lamb\n- Mushrooms\n- scallions",
      ),
    ).toEqual([
      "crab meat",
      "green onion",
      "ground lamb",
      "lamb chop",
      "mushroom",
      "scallop",
      "shrimp",
    ]);
  });

  it("keeps a specific item specific instead of excluding its whole family", () => {
    expect(excludedNames("## Never use\n\n- Chicken thighs")).toEqual([
      "chicken thigh",
    ]);
  });

  it("reports items that are not in the catalog", () => {
    const result = matchNeverUseIngredients(
      "## Never use\n\n- Pork (any cut)\n- liver",
      references,
    );
    expect(result.unmatchedItems).toEqual(["liver"]);
    expect(result.excluded.length).toBeGreaterThan(0);
  });

  it("removes excluded references and leaves the rest untouched", () => {
    const remaining = withoutNeverUseIngredients(
      "## Never use\n\n- Pork",
      references,
    );
    expect(remaining).toHaveLength(references.length - 12);
    expect(remaining.some((reference) => reference.name === "bacon")).toBe(
      false,
    );
    expect(
      remaining.some((reference) => reference.name === "chicken breast"),
    ).toBe(true);
    expect(withoutNeverUseIngredients("# No list", references)).toBe(
      references,
    );
  });
});
