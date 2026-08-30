import { describe, expect, it } from "vitest";

import {
  createGoogleLanguageModel,
  normalizeGoogleModelId,
} from "./google-provider.server";

describe("Google provider", () => {
  it("keeps direct Gemini model identifiers", () => {
    expect(normalizeGoogleModelId("gemini-3.7-flash")).toBe(
      "gemini-3.7-flash",
    );
  });

  it("normalizes legacy Gateway identifiers", () => {
    expect(normalizeGoogleModelId("google/gemini-3.7-flash")).toBe(
      "gemini-3.7-flash",
    );
  });

  it.each([
    "openai/gpt-5",
    "google/gemma-3-27b-it",
    "gemini 3.7 flash",
    "gemini-3.7-flash/extra",
    "",
  ])("rejects unsupported model identifier %j", (modelId) => {
    expect(() => normalizeGoogleModelId(modelId)).toThrow(
      "supported Gemini model identifier",
    );
  });

  it("creates a direct Google language model without exposing the key", () => {
    const model = createGoogleLanguageModel({
      apiKey: "test-secret-key",
      modelId: "google/gemini-3.7-flash",
    });

    expect(model.modelId).toBe("gemini-3.7-flash");
    expect(JSON.stringify(model)).not.toContain("test-secret-key");
  });
});
