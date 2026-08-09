import { describe, expect, it } from "vitest";

import {
  fingerprintGeneratedRecipeCatalog,
  hasValidGeneratedDraftSignature,
  signGeneratedDraft,
} from "./generated-draft-token.server";

const secret = "a-test-session-secret-with-at-least-32-characters";

describe("generated recipe draft signatures", () => {
  it("verifies an unchanged server draft", () => {
    const signed = signGeneratedDraft(
      { attemptId: "attempt-1", title: "Tomato pasta" },
      secret,
    );

    expect(
      hasValidGeneratedDraftSignature(
        signed.envelope,
        signed.signature,
        secret,
      ),
    ).toBe(true);
  });

  it("rejects a changed draft", () => {
    const signed = signGeneratedDraft(
      { attemptId: "attempt-1", title: "Tomato pasta" },
      secret,
    );

    expect(
      hasValidGeneratedDraftSignature(
        signed.envelope.replace("Tomato pasta", "Changed pasta"),
        signed.signature,
        secret,
      ),
    ).toBe(false);
  });

  it("rejects a malformed signature", () => {
    expect(
      hasValidGeneratedDraftSignature("{}", "not-a-signature", secret),
    ).toBe(false);
  });
});

describe("generated recipe catalog fingerprints", () => {
  const catalog = [
    {
      baseUnit: "g",
      catalogKey: "i001",
      category: "produce",
      densityGramsPerMl: null,
      gramsPerCount: 50,
      id: "11111111-1111-4111-8111-111111111111",
      name: "garlic",
      requiredMinimumInternalTemperatureF: null,
    },
    {
      baseUnit: "g",
      catalogKey: "i002",
      category: "protein",
      densityGramsPerMl: null,
      gramsPerCount: null,
      id: "22222222-2222-4222-8222-222222222222",
      name: "chicken thigh",
      requiredMinimumInternalTemperatureF: 165,
    },
  ] as const;

  it("is stable when an equivalent catalog arrives in a different array order", () => {
    expect(fingerprintGeneratedRecipeCatalog(catalog)).toBe(
      fingerprintGeneratedRecipeCatalog([...catalog].reverse()),
    );
  });

  it("changes when a key mapping or conversion field changes", () => {
    const fingerprint = fingerprintGeneratedRecipeCatalog(catalog);

    expect(
      fingerprintGeneratedRecipeCatalog([
        { ...catalog[0], gramsPerCount: 42 },
        catalog[1],
      ]),
    ).not.toBe(fingerprint);
    expect(
      fingerprintGeneratedRecipeCatalog([
        { ...catalog[0], id: "33333333-3333-4333-8333-333333333333" },
        catalog[1],
      ]),
    ).not.toBe(fingerprint);
  });
});
