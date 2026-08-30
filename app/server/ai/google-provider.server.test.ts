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

  it("creates a Vertex Express language model without exposing the key", () => {
    const model = createGoogleLanguageModel({
      apiKey: "test-vertex-express-key",
      modelId: "google/gemini-3.7-flash",
    });

    expect(model.modelId).toBe("gemini-3.7-flash");
    expect(model.provider).toBe("google.vertex.chat");
    expect(JSON.stringify(model)).toContain(
      "https://aiplatform.googleapis.com/v1/publishers/google",
    );
    expect(JSON.stringify(model)).not.toContain("test-vertex-express-key");
  });

  it("fails only the AI feature when Google credentials are absent", () => {
    expect(() =>
      createGoogleLanguageModel({
        apiKey: undefined,
        modelId: "gemini-3.7-flash",
      }),
    ).toThrow("Google Vertex AI credentials are not configured.");
  });
});
