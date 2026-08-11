import { describe, expect, it } from "vitest";

import { weeklyGenerationInvalidOutputMessage } from "./weekly-generation-error-copy";

describe("weekly generation error copy", () => {
  it("uses friendly candidate copy without an internal validation code", () => {
    const message = weeklyGenerationInvalidOutputMessage("candidates");

    expect(message).toBe(
      "We could not create a complete set of distinct dinners in this attempt. Try building the week again.",
    );
    expect(message).not.toContain("DUPLICATE_CANDIDATE_TITLE");
  });

  it("uses separate friendly copy when instruction writing fails", () => {
    expect(weeklyGenerationInvalidOutputMessage("instructions")).toBe(
      "We could not finish writing every recipe in this attempt. Try again.",
    );
  });
});
