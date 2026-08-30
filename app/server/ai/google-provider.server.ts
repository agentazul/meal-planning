import { createGoogle } from "@ai-sdk/google";

const GOOGLE_MODEL_ID_PATTERN = /^gemini-[a-z0-9][a-z0-9._-]*$/;
const LEGACY_GOOGLE_MODEL_ID_PATTERN =
  /^google\/(gemini-[a-z0-9][a-z0-9._-]*)$/;

export function normalizeGoogleModelId(modelId: string): string {
  if (GOOGLE_MODEL_ID_PATTERN.test(modelId)) {
    return modelId;
  }

  const legacyMatch = LEGACY_GOOGLE_MODEL_ID_PATTERN.exec(modelId);
  if (legacyMatch) {
    return legacyMatch[1];
  }

  throw new Error("Google model must use a supported Gemini model identifier.");
}

export function createGoogleLanguageModel(input: {
  apiKey: string;
  modelId: string;
}) {
  if (input.apiKey.trim().length === 0) {
    throw new Error("Google Generative AI credentials are not configured.");
  }

  const google = createGoogle({ apiKey: input.apiKey });
  return google(normalizeGoogleModelId(input.modelId));
}
