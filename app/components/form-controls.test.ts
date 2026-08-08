import { describe, expect, it } from "vitest";

import { matchesPendingSubmission } from "./form-controls";

describe("matchesPendingSubmission", () => {
  it("matches the intent and entity belonging to one form", () => {
    const formData = new FormData();
    formData.set("intent", "update-member");
    formData.set("memberId", "member-2");

    expect(
      matchesPendingSubmission(formData, {
        intent: "update-member",
        memberId: "member-2",
      }),
    ).toBe(true);
    expect(
      matchesPendingSubmission(formData, {
        intent: "update-member",
        memberId: "member-1",
      }),
    ).toBe(false);
  });

  it("keeps unscoped single-form buttons compatible", () => {
    expect(matchesPendingSubmission(undefined, undefined)).toBe(true);
  });
});
