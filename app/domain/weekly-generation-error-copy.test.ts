import { describe, expect, it } from "vitest";

import { weeklyGenerationInvalidOutputMessage } from "./weekly-generation-error-copy";

describe("weekly generation error copy", () => {
  it("uses distinct-dinner copy for duplicate and similarity issues", () => {
    const message = weeklyGenerationInvalidOutputMessage("candidates", [
      "SIMILAR_CANDIDATE_POOL: dinners overlap too much",
    ]);

    expect(message).toBe(
      "We could not create a complete set of distinct dinners in this attempt. Try building the week again.",
    );
    expect(message).not.toContain("DUPLICATE_CANDIDATE_TITLE");
  });

  it.each(["MISSING_OUTPUT", "INCOMPLETE_OUTPUT", "SCHEMA_MISMATCH"])(
    "explains that an incomplete %s response was not saved",
    (issue) => {
      const message = weeklyGenerationInvalidOutputMessage("candidates", [
        `${issue}: provider detail`,
      ]);

      expect(message).toBe(
        "The dinner generator did not finish this attempt, so nothing was saved. Try building the week again.",
      );
      expect(message).not.toContain(issue);
    },
  );

  it("uses recipe-check copy for other candidate validation issues", () => {
    expect(
      weeklyGenerationInvalidOutputMessage("candidates", [
        "INVALID_RECIPE: missing ingredient",
      ]),
    ).toBe(
      "The dinner options did not pass our recipe checks, so nothing was saved. Try building the week again.",
    );
  });

  it("uses the incomplete-response copy when multiple issue types are present", () => {
    expect(
      weeklyGenerationInvalidOutputMessage("candidates", [
        "SIMILAR_CANDIDATE_POOL",
        "MISSING_OUTPUT",
      ]),
    ).toBe(
      "The dinner generator did not finish this attempt, so nothing was saved. Try building the week again.",
    );
  });

  it("uses separate friendly copy when instruction writing fails", () => {
    expect(weeklyGenerationInvalidOutputMessage("instructions")).toBe(
      "We could not finish writing every recipe in this attempt. Try again.",
    );
  });
});
