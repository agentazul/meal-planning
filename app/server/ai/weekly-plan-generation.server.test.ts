import { APICallError, LoadAPIKeyError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import {
  normalizeWeeklyCandidatePool,
  type WeeklyCandidateModel,
  type WeeklyGenerationCatalogEntry,
  type WeeklyGenerationSlot,
} from "~/domain/weekly-generation";
import { US_RECIPE_MEASUREMENT_UNITS } from "~/domain/units";
import {
  generateWeeklyCandidates,
  generateWeeklyInstructions,
  generateWeeklySlotCandidates,
  WeeklyPlanGenerationError,
} from "~/server/ai/weekly-plan-generation.server";

const UUIDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
] as const;

const US_RECIPE_MEASUREMENT_UNIT_SET = new Set<string>(
  US_RECIPE_MEASUREMENT_UNITS,
);

const catalog = [
  {
    baseUnit: "g",
    catalogKey: "i001",
    category: "protein",
    densityGramsPerMl: null,
    gramsPerCount: null,
    id: UUIDS[0],
    isStaple: false,
    name: "Chicken breast",
    requiredMinimumInternalTemperatureF: 165,
  },
  {
    baseUnit: "g",
    catalogKey: "i002",
    category: "pantry",
    densityGramsPerMl: null,
    gramsPerCount: null,
    id: UUIDS[1],
    isStaple: true,
    name: "White rice",
    requiredMinimumInternalTemperatureF: null,
  },
  {
    baseUnit: "g",
    catalogKey: "i003",
    category: "produce",
    densityGramsPerMl: null,
    gramsPerCount: null,
    id: UUIDS[2],
    isStaple: false,
    name: "Broccoli",
    requiredMinimumInternalTemperatureF: null,
  },
  {
    baseUnit: "g",
    catalogKey: "i004",
    category: "spice",
    densityGramsPerMl: null,
    gramsPerCount: null,
    id: UUIDS[3],
    isStaple: true,
    name: "Kosher salt",
    requiredMinimumInternalTemperatureF: null,
  },
] as const satisfies readonly WeeklyGenerationCatalogEntry[];

const slots = [
  "2026-08-10",
  "2026-08-11",
  "2026-08-12",
  "2026-08-13",
  "2026-08-14",
].map((date, index) => ({
  date,
  effortTier: "weeknight" as const,
  maxActiveTimeMinutes: 45,
  servingsTarget: 5,
  slotKey: `d${index + 1}`,
})) as readonly WeeklyGenerationSlot[];

const pantryInventory = [
  {
    baseUnit: "g" as const,
    catalogKey: "i002",
    name: "White rice",
    quantityInBaseUnit: 680.389,
  },
  {
    baseUnit: "g" as const,
    catalogKey: "i003",
    name: "Broccoli",
    quantityInBaseUnit: 340.194,
  },
] as const;

function candidate(
  laneIndex: number,
  slotIndex: number,
  overrides: Partial<WeeklyCandidateModel> = {},
): WeeklyCandidateModel {
  return {
    activeTimeMinutes: 25,
    baseServings: 5,
    cuisine: ["American", "Italian", "Mediterranean"][laneIndex]!,
    effortTier: "weeknight",
    ingredients: [
      {
        catalogKey: "i001",
        isOptional: false,
        preparation: "cut into pieces",
        quantity: 1.75,
        scalesLinearly: true,
        unit: "lb",
      },
      {
        catalogKey: "i002",
        isOptional: false,
        preparation: "rinsed",
        quantity: 12,
        scalesLinearly: true,
        unit: "oz",
      },
      {
        catalogKey: "i003",
        isOptional: false,
        preparation: "cut into florets",
        quantity: 10,
        scalesLinearly: true,
        unit: "oz",
      },
    ],
    minInternalTemperatureF: 165,
    primaryProteinCatalogKey: "i001",
    slotDate: slots[slotIndex]!.date,
    techniques: [["roasting"], ["sauteing"], ["simmering"]][laneIndex]!,
    title: `Lane ${laneIndex + 1} dinner ${slotIndex + 1}`,
    totalTimeMinutes: 40,
    ...overrides,
  };
}

function laneOutput(laneIndex: number) {
  return {
    candidates: slots.map((_, slotIndex) => candidate(laneIndex, slotIndex)),
  };
}

function replacementOutput(value: WeeklyCandidateModel) {
  return {
    candidates: [structuredClone(value), structuredClone(value), value],
  };
}

function mockGeneration(
  output: unknown,
  inputTokens = 10,
  outputTokens = 20,
  finishReason: "stop" | "length" = "stop",
  rawFinishReason: string | undefined = undefined,
) {
  return {
    content: [{ text: JSON.stringify(output), type: "text" as const }],
    finishReason: { raw: rawFinishReason, unified: finishReason },
    usage: {
      inputTokens: {
        cacheRead: undefined,
        cacheWrite: undefined,
        noCache: inputTokens,
        total: inputTokens,
      },
      outputTokens: {
        reasoning: undefined,
        text: outputTokens,
        total: outputTokens,
      },
    },
    warnings: [],
  };
}

function userPrompt(model: MockLanguageModelV4, callIndex: number): string {
  const message = model.doGenerateCalls[callIndex]?.prompt.find(
    (item) => item.role === "user",
  );
  if (!message || message.role !== "user") {
    throw new Error("Expected a user prompt");
  }
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

const candidateRequest = {
  catalog,
  dietaryNotes: ["No shellfish."],
  pantryInventory,
  preferenceMarkdown: "Prefer practical, mild dinners.",
  recentHistory: [
    {
      cuisine: "American",
      primaryProtein: "Chicken",
      techniques: ["baking\nthen resting"],
      title: "Chicken Alfredo",
    },
  ],
  slots,
} as const;

describe("direct provider boundary", () => {
  it("rejects a plain provider route instead of using AI Gateway", async () => {
    await expect(
      generateWeeklyCandidates({
        ...candidateRequest,
        model: "google/gemini-3.7-flash",
      }),
    ).rejects.toMatchObject({
      attemptCount: 0,
      code: "invalid_input",
      phase: "candidates",
    });
  });

  it("rejects an unknown pantry key before full-week provider generation", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: mockGeneration(laneOutput(0)),
    });

    const error = await generateWeeklyCandidates({
      ...candidateRequest,
      model,
      pantryInventory: [{ ...pantryInventory[0], catalogKey: "i999" }],
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      attemptCount: 0,
      code: "invalid_input",
      phase: "candidates",
    });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it.each([
    [401, "invalid_api_key"],
    [402, "quota_exceeded"],
    [403, "permission_denied"],
    [404, "model_unavailable"],
    [408, "provider_timeout"],
    [429, "rate_limited"],
    [500, "provider_request_failed"],
  ] as const)(
    "classifies candidate provider status %i without retaining provider details",
    async (statusCode, providerFailureCode) => {
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          throw new APICallError({
            isRetryable: false,
            message: "RAW-PROVIDER-MESSAGE-SENTINEL",
            requestBodyValues: {
              prompt: "RAW-PROVIDER-REQUEST-SENTINEL",
            },
            responseBody: "RAW-PROVIDER-RESPONSE-SENTINEL",
            statusCode,
            url: "https://provider.invalid/RAW-PROVIDER-URL-SENTINEL",
          });
        },
      });

      const error = await generateWeeklyCandidates({
        ...candidateRequest,
        model,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(WeeklyPlanGenerationError);
      expect(error).toMatchObject({
        code: "request_failed",
        message: "Weekly recipe generation is temporarily unavailable.",
        phase: "candidates",
        providerFailureCode,
      });
      expect(JSON.stringify(error)).not.toContain("RAW-PROVIDER");
    },
  );

  it("classifies a missing direct-provider key through the AI SDK guard", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new LoadAPIKeyError({
          message: "RAW-MISSING-KEY-MESSAGE-SENTINEL",
        });
      },
    });

    const error = await generateWeeklyCandidates({
      ...candidateRequest,
      model,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "request_failed",
      providerFailureCode: "invalid_api_key",
    });
    expect(JSON.stringify(error)).not.toContain("RAW-MISSING-KEY");
  });

  it("uses Google's structured reason to classify a 400 invalid API key", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({
          data: {
            error: {
              code: 400,
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  domain: "googleapis.com",
                  reason: "API_KEY_INVALID",
                },
              ],
              message: "RAW-GOOGLE-MESSAGE-SENTINEL",
              status: "INVALID_ARGUMENT",
            },
          },
          isRetryable: false,
          message: "RAW-PROVIDER-MESSAGE-SENTINEL",
          requestBodyValues: { prompt: "RAW-REQUEST-SENTINEL" },
          responseBody: "RAW-RESPONSE-SENTINEL",
          statusCode: 400,
          url: "https://provider.invalid/RAW-URL-SENTINEL",
        });
      },
    });

    const error = await generateWeeklyCandidates({
      ...candidateRequest,
      model,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "request_failed",
      providerFailureCode: "invalid_api_key",
    });
    expect(JSON.stringify(error)).not.toContain("RAW-");
  });

  it("classifies the AI SDK timeout without retaining its message", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new DOMException("RAW-TIMEOUT-SENTINEL", "TimeoutError");
      },
    });

    const error = await generateWeeklyCandidates({
      ...candidateRequest,
      model,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "request_failed",
      providerFailureCode: "provider_timeout",
    });
    expect(JSON.stringify(error)).not.toContain("RAW-TIMEOUT");
  });

  it("attaches the safe provider classification to instruction failures", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({
          isRetryable: false,
          message: "RAW-INSTRUCTION-MESSAGE-SENTINEL",
          requestBodyValues: {
            prompt: "RAW-INSTRUCTION-REQUEST-SENTINEL",
          },
          responseBody: "RAW-INSTRUCTION-RESPONSE-SENTINEL",
          statusCode: 403,
          url: "https://provider.invalid/RAW-INSTRUCTION-URL-SENTINEL",
        });
      },
    });

    const error = await generateWeeklyInstructions({
      model,
      selectedCandidates: normalizedPool().slice(0, 5),
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "request_failed",
      message: "Weekly instruction generation is temporarily unavailable.",
      phase: "instructions",
      providerFailureCode: "permission_denied",
    });
    expect(JSON.stringify(error)).not.toContain("RAW-INSTRUCTION");
  });
});

function normalizedPool() {
  return normalizeWeeklyCandidatePool({
    candidates: [0, 1, 2].flatMap((laneIndex) =>
      slots.map((_, slotIndex) => candidate(laneIndex, slotIndex)),
    ),
    catalog,
    slots,
  });
}

function instructionOutput(
  candidates: ReturnType<typeof normalizedPool>,
  omitBroccoli = false,
) {
  return {
    recipes: candidates.map((item) => ({
      candidateKey: item.candidateKey,
      description: `A complete dinner for ${item.candidateKey}.`,
      steps: [
        {
          ingredientKeysUsed: omitBroccoli ? ["i002"] : ["i002", "i003"],
          instruction: "Cook the rice and broccoli until tender.",
        },
        {
          ingredientKeysUsed: ["i001"],
          instruction:
            "Cook the chicken until it reaches 165 degrees Fahrenheit.",
        },
      ],
    })),
  };
}

function slotCandidateOutput(
  overrides: readonly Partial<WeeklyCandidateModel>[] = [],
) {
  const ideas: readonly Partial<WeeklyCandidateModel>[] = [
    {
      cuisine: "American",
      techniques: ["roasting"],
      title: "Roasted Lemon Chicken",
    },
    {
      cuisine: "Italian",
      techniques: ["sauteing"],
      title: "Chicken Rice Skillet",
    },
    {
      cuisine: "Mediterranean",
      techniques: ["simmering"],
      title: "Chicken Broccoli Soup",
    },
  ];
  return {
    candidates: ideas.map((idea, index) =>
      candidate(index, 0, { ...idea, ...overrides[index] }),
    ),
  };
}

describe("weekly slot candidate regeneration", () => {
  it("generates exactly three target-slot ideas distinct from every existing idea", async () => {
    const existingCandidates = normalizedPool();
    const repeatedExisting = slotCandidateOutput([
      {
        cuisine: existingCandidates[0]!.cuisine,
        techniques: existingCandidates[0]!.techniques,
        title: existingCandidates[0]!.title,
      },
    ]);
    const wrongSlot = slotCandidateOutput([{ slotDate: slots[1]!.date }]);
    const model = new MockLanguageModelV4({
      doGenerate: [
        mockGeneration(repeatedExisting),
        mockGeneration(wrongSlot),
        mockGeneration(slotCandidateOutput()),
      ],
      modelId: "gemini-3.7-flash",
    });

    const result = await generateWeeklySlotCandidates({
      catalog,
      dietaryNotes: candidateRequest.dietaryNotes,
      existingCandidates,
      model,
      pantryInventory,
      preferenceMarkdown: candidateRequest.preferenceMarkdown,
      recentHistory: candidateRequest.recentHistory,
      slot: slots[0]!,
    });

    expect(result.candidates).toHaveLength(3);
    expect(
      result.candidates.every((item) => item.slotDate === slots[0]!.date),
    ).toBe(true);
    expect(new Set(result.candidates.map((item) => item.title)).size).toBe(3);
    expect(result.attemptCount).toBe(3);
    expect(result.usage).toEqual({
      inputTokens: 30,
      outputTokens: 60,
      totalTokens: 90,
    });
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(model.doGenerateCalls[0]?.reasoning).toBe("medium");
    expect(model.doGenerateCalls[0]?.responseFormat).toMatchObject({
      name: "WeeklySlotCandidates",
      type: "json",
    });
    expect(userPrompt(model, 0)).toContain(
      "UNTRUSTED_RESERVED_CANDIDATE_SUMMARIES_JSON",
    );
    expect(userPrompt(model, 0)).toContain(
      "UNTRUSTED_ESTIMATED_WEEK_START_PANTRY_JSON",
    );
    expect(userPrompt(model, 0)).not.toContain(
      "UNTRUSTED_CURRENT_PANTRY_INVENTORY_JSON",
    );
    expect(userPrompt(model, 0)).toContain('"quantityInBaseUnit":680.389');
    expect(userPrompt(model, 0)).toContain(
      "after presumed use by earlier scheduled recipes",
    );
    expect(userPrompt(model, 0)).toContain(
      "They are not exact physical counts",
    );
    expect(userPrompt(model, 0)).not.toContain("rawQuantityInBaseUnit");
    expect(userPrompt(model, 0)).not.toContain("scheduledRecipe");
    expect(userPrompt(model, 0)).not.toContain("checkpoint");
    expect(userPrompt(model, 0)).not.toContain("deduction");
    expect(userPrompt(model, 0)).toContain(existingCandidates[0]!.title);
    expect(userPrompt(model, 0)).toContain(
      `DINNER_SLOTS_JSON\n${JSON.stringify([slots[0]])}`,
    );
    expect(userPrompt(model, 0)).toContain(
      "Generate exactly 3 meaningfully different alternatives for the single supplied slot now.",
    );
    expect(userPrompt(model, 1)).toContain("RESERVED_MEAL_REPEAT");
    expect(userPrompt(model, 2)).toContain("SLOT_COVERAGE");
  });

  it("sanitizes direct-provider failures for a single-slot request", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({
          isRetryable: false,
          message: "RAW-SLOT-MESSAGE-SENTINEL",
          requestBodyValues: { prompt: "RAW-SLOT-REQUEST-SENTINEL" },
          responseBody: "RAW-SLOT-RESPONSE-SENTINEL",
          statusCode: 429,
          url: "https://provider.invalid/RAW-SLOT-URL-SENTINEL",
        });
      },
    });

    const error = await generateWeeklySlotCandidates({
      catalog,
      dietaryNotes: candidateRequest.dietaryNotes,
      existingCandidates: normalizedPool(),
      model,
      pantryInventory,
      preferenceMarkdown: candidateRequest.preferenceMarkdown,
      recentHistory: candidateRequest.recentHistory,
      slot: slots[0]!,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WeeklyPlanGenerationError);
    expect(error).toMatchObject({
      attemptCount: 1,
      batch: "slot-candidates",
      code: "request_failed",
      message: "Weekly recipe generation is temporarily unavailable.",
      phase: "candidates",
      providerFailureCode: "rate_limited",
    });
    expect(JSON.stringify(error)).not.toContain("RAW-SLOT");
  });

  it.each([
    ["unknown catalog key", [{ ...pantryInventory[0], catalogKey: "i999" }]],
    ["malformed quantity", [{ ...pantryInventory[0], quantityInBaseUnit: -1 }]],
  ])(
    "rejects %s in the pantry snapshot before calling the provider",
    async (_name, invalidPantry) => {
      const model = new MockLanguageModelV4({
        doGenerate: mockGeneration(slotCandidateOutput()),
      });

      const error = await generateWeeklySlotCandidates({
        catalog,
        dietaryNotes: candidateRequest.dietaryNotes,
        existingCandidates: normalizedPool(),
        model,
        pantryInventory: invalidPantry,
        preferenceMarkdown: candidateRequest.preferenceMarkdown,
        recentHistory: candidateRequest.recentHistory,
        slot: slots[0]!,
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        attemptCount: 0,
        code: "invalid_input",
        phase: "candidates",
      });
      expect(model.doGenerateCalls).toHaveLength(0);
    },
  );
});

describe("weekly plan AI generation", () => {
  it("runs three metadata-only candidate lanes with safe bounded context", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [0, 1, 2].map((laneIndex) =>
        mockGeneration(laneOutput(laneIndex)),
      ),
      modelId: "gemini-3.7-flash",
    });

    const result = await generateWeeklyCandidates({
      ...candidateRequest,
      model,
    });

    expect(result.candidates).toHaveLength(15);
    expect(result.batchAttempts).toEqual({
      "familiar-fast": 1,
      "ingredient-sharing": 1,
      variety: 1,
    });
    expect(result.usage).toEqual({
      inputTokens: 30,
      outputTokens: 60,
      totalTokens: 90,
    });
    expect(model.doGenerateCalls).toHaveLength(3);

    for (const [index, call] of model.doGenerateCalls.entries()) {
      expect(call.maxOutputTokens).toBe(12_000);
      expect(call.reasoning).toBe("low");
      expect(call.responseFormat).toMatchObject({
        name: "WeeklyCandidateLane",
        type: "json",
      });
      const responseSchema = JSON.stringify(
        (call.responseFormat as { schema?: unknown }).schema,
      );
      expect(responseSchema).not.toContain('"description"');
      expect(responseSchema).not.toContain('"instructions"');
      expect(responseSchema).not.toContain('"steps"');
      expect(responseSchema).toContain(
        `"enum":${JSON.stringify(US_RECIPE_MEASUREMENT_UNITS)}`,
      );
      const instructions = call.prompt.find((item) => item.role === "system");
      expect(instructions?.content).toContain(
        "conventional US recipe units only",
      );
      expect(instructions?.content).toContain("Never use metric units");
      expect(instructions?.content).toContain(
        "treat pantry fit as a soft preference",
      );
      expect(instructions?.content).toContain(
        "estimated to be available at the start of the generated week after presumed use by earlier scheduled recipes",
      );
      expect(instructions?.content).toContain(
        "forecasts, not exact physical counts",
      );

      const prompt = userPrompt(model, index);
      expect(prompt).toContain("UNTRUSTED_ESTIMATED_WEEK_START_PANTRY_JSON");
      expect(prompt).not.toContain("UNTRUSTED_CURRENT_PANTRY_INVENTORY_JSON");
      expect(prompt).toContain('"catalogKey":"i002"');
      expect(prompt).toContain('"quantityInBaseUnit":680.389');
      expect(prompt).toContain('"catalogKey":"i003"');
      expect(prompt).toContain('"quantityInBaseUnit":340.194');
      expect(prompt).toContain(
        "after presumed use by earlier scheduled recipes",
      );
      expect(prompt).not.toContain("rawQuantityInBaseUnit");
      expect(prompt).not.toContain("scheduledRecipe");
      expect(prompt).not.toContain("checkpoint");
      expect(prompt).not.toContain("deduction");
      expect(prompt).toContain("UNTRUSTED_RECENT_MEAL_HISTORY_JSON");
      expect(prompt).toContain("Chicken Alfredo");
      expect(prompt).toContain("baking then resting");
      expect(prompt).toContain("changing only toppings, cheese, sauce");
      expect(prompt).toContain(
        "Reusing a protein, cuisine, or technique by itself is allowed.",
      );
      expect(prompt).not.toContain("Matt");
      expect(prompt).not.toContain("Desirae");
      for (const id of UUIDS) expect(prompt).not.toContain(id);
    }
    expect(userPrompt(model, 1)).toContain(
      "UNTRUSTED_RESERVED_CANDIDATE_SUMMARIES_JSON",
    );
    expect(userPrompt(model, 1)).toContain(candidate(0, 0).title);
    expect(userPrompt(model, 2)).toContain(candidate(0, 0).title);
    expect(userPrompt(model, 2)).toContain(candidate(1, 0).title);
    expect(result.candidates[0]?.ingredients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          baseUnit: "g",
          quantity: 1.75,
          quantityInBaseUnit: 793.787,
          unit: "lb",
        }),
      ]),
    );
  });

  it("does not force reasoning on a non-Gemini weekly model", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [0, 1, 2].map((laneIndex) =>
        mockGeneration(laneOutput(laneIndex)),
      ),
      modelId: "anthropic/claude-sonnet-4.6",
    });

    await generateWeeklyCandidates({
      ...candidateRequest,
      model,
    });

    expect(model.doGenerateCalls).toHaveLength(3);
    expect(
      model.doGenerateCalls.every((call) => call.reasoning === undefined),
    ).toBe(true);
  });

  it("repairs a cross-lane duplicate with concrete reserved candidates", async () => {
    const duplicateLane = laneOutput(1);
    duplicateLane.candidates[0] = candidate(1, 0, {
      title: candidate(0, 0).title,
    });
    const model = new MockLanguageModelV4({
      doGenerate: [
        mockGeneration(laneOutput(0)),
        mockGeneration(duplicateLane),
        mockGeneration(laneOutput(2)),
        mockGeneration(replacementOutput(candidate(1, 0))),
      ],
    });

    const result = await generateWeeklyCandidates({
      ...candidateRequest,
      model,
    });

    expect(result.batchAttempts).toEqual({
      "familiar-fast": 1,
      "ingredient-sharing": 1,
      variety: 2,
    });
    expect(model.doGenerateCalls).toHaveLength(4);
    const retryPrompt = userPrompt(model, 3);
    expect(retryPrompt).toContain(
      "UNTRUSTED_RESERVED_CANDIDATE_SUMMARIES_JSON",
    );
    expect(retryPrompt).toContain(candidate(0, 0).title);
    expect(retryPrompt).toContain(candidate(2, 4).title);
    expect(retryPrompt).toContain(candidate(1, 4).title);
    expect(retryPrompt).toContain(
      "Generate exactly 3 meaningfully different alternatives for the single supplied slot now.",
    );
    expect(retryPrompt).toContain(
      `DINNER_SLOTS_JSON\n${JSON.stringify([slots[0]])}`,
    );
    for (const slotIndex of [1, 2, 3, 4]) {
      expect(result.candidates.map((item) => item.title)).toContain(
        candidate(1, slotIndex).title,
      );
    }
    expect(
      new Set(
        result.candidates.map((item) =>
          item.title.trim().toLocaleLowerCase("en-US"),
        ),
      ).size,
    ).toBe(15);
  });

  it("retries incomplete candidate output and reports only bounded finish details", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        mockGeneration(
          laneOutput(0),
          10,
          20,
          "length",
          "MAX_TOKENS_RAW_OUTPUT_SENTINEL",
        ),
        mockGeneration(
          laneOutput(0),
          10,
          20,
          "length",
          "MAX_TOKENS_RAW_OUTPUT_SENTINEL",
        ),
        mockGeneration(
          laneOutput(0),
          10,
          20,
          "length",
          "MAX_TOKENS_RAW_OUTPUT_SENTINEL",
        ),
        mockGeneration(
          laneOutput(0),
          10,
          20,
          "length",
          "MAX_TOKENS_RAW_OUTPUT_SENTINEL",
        ),
        mockGeneration(
          laneOutput(0),
          10,
          20,
          "length",
          "MAX_TOKENS_RAW_OUTPUT_SENTINEL",
        ),
        mockGeneration(laneOutput(1)),
        mockGeneration(laneOutput(2)),
      ],
    });

    const error = await generateWeeklyCandidates({
      ...candidateRequest,
      model,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WeeklyPlanGenerationError);
    expect(error).toMatchObject({
      attemptCount: 5,
      batch: "familiar-fast",
      validationIssues: [
        "INCOMPLETE_OUTPUT: Structured output did not finish cleanly (finishReason=length; rawFinishReason=MAX_TOKENS_RAW_OUTPUT_SENTINEL).",
      ],
    });
    expect(model.doGenerateCalls).toHaveLength(5);
    expect(JSON.stringify(error)).not.toContain("RAW-FIRST-DRAFT");
  });

  it("repairs different titles that describe the same cross-lane core dish", async () => {
    const firstLane = laneOutput(0);
    firstLane.candidates[0] = candidate(0, 0, {
      title: "Chicken Tacos and Cheddar Salsa",
    });
    const similarLane = laneOutput(1);
    similarLane.candidates[0] = candidate(1, 0, {
      title: "Chicken Tacos - Spanish Rice",
    });
    const model = new MockLanguageModelV4({
      doGenerate: [
        mockGeneration(firstLane),
        mockGeneration(similarLane),
        mockGeneration(laneOutput(2)),
        mockGeneration(replacementOutput(candidate(1, 0))),
      ],
    });

    const result = await generateWeeklyCandidates({
      ...candidateRequest,
      model,
    });

    expect(result.batchAttempts.variety).toBe(2);
    const retryPrompt = userPrompt(model, 3);
    expect(retryPrompt).toContain("SIMILAR_CANDIDATE_POOL");
    expect(retryPrompt).toContain(
      "suspend pantry-overlap optimization; semantic distinctness from the indexed reserved or candidate conflict takes priority",
    );
    expect(retryPrompt).toContain(
      "every replacement alternative must use a different primary protein and a different core cooking format from the indexed conflict",
    );
    expect(retryPrompt).toContain(
      "The three replacement alternatives must use different core cooking formats from one another.",
    );
    expect(retryPrompt).toContain("Chicken Tacos and Cheddar Salsa");
    expect(retryPrompt).not.toContain("Chicken Tacos - Spanish Rice");
    expect(result.candidates.map((item) => item.title)).not.toContain(
      "Chicken Tacos - Spanish Rice",
    );
  });

  it("repairs the earlier collision candidate when the later lane exhausts its budget", async () => {
    const firstLane = laneOutput(0);
    firstLane.candidates[0] = candidate(0, 0, {
      title: "Chicken Tacos and Cheddar Salsa",
    });
    const laterLane = laneOutput(1);
    laterLane.candidates[0] = candidate(1, 0, {
      title: "Chicken Tacos - Spanish Rice",
    });
    const stillConflicting = replacementOutput(
      candidate(1, 0, { title: "Chicken Tacos - Spanish Rice" }),
    );
    const model = new MockLanguageModelV4({
      doGenerate: [
        mockGeneration(firstLane),
        mockGeneration(laterLane),
        mockGeneration(laneOutput(2)),
        mockGeneration(stillConflicting),
        mockGeneration(stillConflicting),
        mockGeneration(stillConflicting),
        mockGeneration(stillConflicting),
        mockGeneration(replacementOutput(candidate(0, 0))),
      ],
    });

    const result = await generateWeeklyCandidates({
      ...candidateRequest,
      model,
    });

    expect(result.batchAttempts).toEqual({
      "familiar-fast": 2,
      "ingredient-sharing": 1,
      variety: 5,
    });
    expect(result.usage).toEqual({
      inputTokens: 80,
      outputTokens: 160,
      totalTokens: 240,
    });
    expect(model.doGenerateCalls).toHaveLength(8);
    expect(userPrompt(model, 7)).toContain("lane=familiar-fast");
    expect(userPrompt(model, 7)).toContain("candidateIndex=0");
    expect(result.candidates.map((item) => item.title)).not.toContain(
      "Chicken Tacos and Cheddar Salsa",
    );
  });

  it("regenerates aggregate-fallback lanes in order with current reservations", async () => {
    const invalidAggregateLane = laneOutput(0);
    invalidAggregateLane.candidates[0] = candidate(0, 0, {
      ingredients: invalidAggregateLane.candidates[0]!.ingredients.map(
        (ingredient, ingredientIndex) =>
          ingredientIndex === 1
            ? { ...ingredient, quantity: 99_999_999_999 }
            : ingredient,
      ),
    });
    const repairedLane0 = laneOutput(0);
    repairedLane0.candidates[0] = candidate(0, 0, {
      title: "Casserole supreme",
    });
    const repairedLane1 = laneOutput(1);
    repairedLane1.candidates[0] = candidate(1, 0, {
      title: "Stir fry supreme",
    });
    const repairedLane2 = laneOutput(2);
    repairedLane2.candidates[0] = candidate(2, 0, {
      title: "Skillet supreme",
    });
    const model = new MockLanguageModelV4({
      doGenerate: [
        mockGeneration(invalidAggregateLane),
        mockGeneration(laneOutput(1)),
        mockGeneration(laneOutput(2)),
        mockGeneration(repairedLane0),
        mockGeneration(repairedLane1),
        mockGeneration(repairedLane2),
      ],
    });

    const result = await generateWeeklyCandidates({
      ...candidateRequest,
      model,
    });

    expect(result.batchAttempts).toEqual({
      "familiar-fast": 2,
      "ingredient-sharing": 2,
      variety: 2,
    });
    expect(model.doGenerateCalls).toHaveLength(6);
    expect(userPrompt(model, 4)).toContain(repairedLane0.candidates[0]!.title);
    expect(userPrompt(model, 5)).toContain(repairedLane0.candidates[0]!.title);
    expect(userPrompt(model, 5)).toContain(repairedLane1.candidates[0]!.title);
    expect(result.candidates).toHaveLength(15);
  });

  it("retries a candidate that is too similar to the 21-day history", async () => {
    const repeated = laneOutput(0);
    repeated.candidates[0] = candidate(0, 0, {
      title: "Chicken Tacos with Spanish Rice",
    });
    const model = new MockLanguageModelV4({
      doGenerate: [
        mockGeneration(repeated),
        mockGeneration({
          candidates: [
            candidate(0, 0, { title: "Chicken Tacos with Spanish Rice" }),
            candidate(0, 0),
            candidate(0, 0, { title: "Backup valid dinner" }),
          ],
        }),
        mockGeneration(laneOutput(1)),
        mockGeneration(laneOutput(2)),
      ],
      modelId: "gemini-3.7-flash",
    });

    const result = await generateWeeklyCandidates({
      ...candidateRequest,
      model,
      recentHistory: [
        {
          cuisine: "American",
          primaryProtein: "Chicken breast",
          techniques: ["sauteing"],
          title: "Chicken Tacos with Cheddar and Salsa",
        },
      ],
    });

    expect(result.batchAttempts["familiar-fast"]).toBe(2);
    const retryPrompt = userPrompt(model, 1);
    expect(retryPrompt).toContain("RECENT_MEAL_REPEAT");
    expect(retryPrompt).toContain("recentHistoryIndex=0");
    expect(retryPrompt).toContain("CORRECTION_ATTEMPT 1 OF 4");
    expect(retryPrompt).toContain(
      "suspend pantry-overlap optimization; semantic distinctness from the indexed recent meal takes priority",
    );
    expect(retryPrompt).toContain(
      "every replacement alternative must use a different primary protein and a different core cooking format from the indexed recent meal",
    );
    expect(retryPrompt).toContain(
      "The three replacement alternatives must use different core cooking formats from one another.",
    );
    expect(model.doGenerateCalls[1]?.reasoning).toBe("medium");
    expect(retryPrompt).toContain(
      "Generate exactly 3 meaningfully different alternatives for the single supplied slot now.",
    );
    expect(retryPrompt).toContain(
      `DINNER_SLOTS_JSON\n${JSON.stringify([slots[0]])}`,
    );
    expect(retryPrompt).not.toContain("Chicken Tacos with Spanish Rice");
    for (const slotIndex of [1, 2, 3, 4]) {
      expect(result.candidates.map((item) => item.title)).toContain(
        candidate(0, slotIndex).title,
      );
    }
  });

  it("allows a recent-meal retry to recover on the final bounded attempt", async () => {
    const repeated = laneOutput(0);
    repeated.candidates[0] = candidate(0, 0, {
      title: "Chicken Tacos with Spanish Rice",
    });
    const model = new MockLanguageModelV4({
      doGenerate: [
        mockGeneration(repeated),
        mockGeneration(
          replacementOutput(
            candidate(0, 0, { title: "Chicken Tacos with Spanish Rice" }),
          ),
        ),
        mockGeneration(
          replacementOutput(
            candidate(0, 0, { title: "Chicken Tacos with Spanish Rice" }),
          ),
        ),
        mockGeneration(
          replacementOutput(
            candidate(0, 0, { title: "Chicken Tacos with Spanish Rice" }),
          ),
        ),
        mockGeneration(replacementOutput(candidate(0, 0))),
        mockGeneration(laneOutput(1)),
        mockGeneration(laneOutput(2)),
      ],
    });

    const result = await generateWeeklyCandidates({
      ...candidateRequest,
      model,
      recentHistory: [
        {
          cuisine: "American",
          primaryProtein: "Chicken breast",
          techniques: ["sauteing"],
          title: "Chicken Tacos with Cheddar and Salsa",
        },
      ],
    });

    expect(result.batchAttempts["familiar-fast"]).toBe(5);
    expect(model.doGenerateCalls).toHaveLength(7);
    expect(userPrompt(model, 1)).toContain("RECENT_MEAL_REPEAT");
    expect(userPrompt(model, 1)).toContain("slotDate=2026-08-10");
    expect(userPrompt(model, 4)).toContain("CORRECTION_ATTEMPT 4 OF 4");
    expect(userPrompt(model, 4)).toContain(
      "different primary protein, cuisine, and core cooking format",
    );
  });

  it("rejects metric candidate units and retries that lane", async () => {
    const metric = laneOutput(0);
    metric.candidates[0] = candidate(0, 0, {
      ingredients: [
        {
          ...metric.candidates[0]!.ingredients[0]!,
          quantity: 750,
          unit: "g",
        },
        ...metric.candidates[0]!.ingredients.slice(1),
      ],
    });
    const model = new MockLanguageModelV4({
      doGenerate: [
        mockGeneration(metric),
        mockGeneration(laneOutput(1)),
        mockGeneration(laneOutput(2)),
        mockGeneration(laneOutput(0)),
      ],
    });

    const result = await generateWeeklyCandidates({
      ...candidateRequest,
      model,
    });

    expect(result.batchAttempts).toEqual({
      "familiar-fast": 2,
      "ingredient-sharing": 1,
      variety: 1,
    });
    expect(
      result.candidates.every((item) =>
        item.ingredients.every((ingredient) =>
          US_RECIPE_MEASUREMENT_UNIT_SET.has(ingredient.unit),
        ),
      ),
    ).toBe(true);
  });

  it("rejects metric measurements in candidate preparation text", async () => {
    const metric = laneOutput(0);
    metric.candidates[0] = candidate(0, 0, {
      ingredients: [
        {
          ...metric.candidates[0]!.ingredients[0]!,
          preparation: "cut into 2 cm pieces",
        },
        ...metric.candidates[0]!.ingredients.slice(1),
      ],
    });
    const model = new MockLanguageModelV4({
      doGenerate: [
        mockGeneration(metric),
        mockGeneration(laneOutput(1)),
        mockGeneration(laneOutput(2)),
        mockGeneration(laneOutput(0)),
      ],
    });

    const result = await generateWeeklyCandidates({
      ...candidateRequest,
      model,
    });

    expect(result.batchAttempts["familiar-fast"]).toBe(2);
    expect(result.candidates[0]?.ingredients[0]?.preparation).toBe(
      "cut into pieces",
    );
  });

  it("retries one invalid candidate lane without replaying raw model output", async () => {
    const invalid = laneOutput(0);
    invalid.candidates[0] = candidate(0, 0, {
      baseServings: 4,
      title: "RAW-FIRST-DRAFT-SENTINEL",
    });
    const model = new MockLanguageModelV4({
      doGenerate: [
        mockGeneration(invalid),
        mockGeneration(replacementOutput(candidate(0, 0))),
        mockGeneration(laneOutput(1)),
        mockGeneration(laneOutput(2)),
      ],
    });

    const result = await generateWeeklyCandidates({
      ...candidateRequest,
      model,
    });

    expect(result.batchAttempts["familiar-fast"]).toBe(2);
    expect(model.doGenerateCalls).toHaveLength(4);
    const retryPrompt = userPrompt(model, 1);
    expect(retryPrompt).toContain("SLOT_CONSTRAINT_MISMATCH");
    expect(retryPrompt).toContain(
      "Generate exactly 3 meaningfully different alternatives for the single supplied slot now.",
    );
    expect(retryPrompt).not.toContain("RAW-FIRST-DRAFT-SENTINEL");
    for (const slotIndex of [1, 2, 3, 4]) {
      expect(result.candidates.map((item) => item.title)).toContain(
        candidate(0, slotIndex).title,
      );
    }
  });

  it("retries only the lane with a US unit incompatible with its catalog row", async () => {
    const invalid = laneOutput(0);
    invalid.candidates[0] = candidate(0, 0, {
      ingredients: [
        ...invalid.candidates[0]!.ingredients,
        {
          catalogKey: "i004",
          isOptional: false,
          preparation: null,
          quantity: 2,
          scalesLinearly: true,
          unit: "tsp",
        },
      ],
      title: "RAW-DOMAIN-FAILURE-SENTINEL",
    });
    const corrected = laneOutput(0);
    corrected.candidates[0] = candidate(0, 0, {
      ingredients: [
        ...corrected.candidates[0]!.ingredients,
        {
          catalogKey: "i004",
          isOptional: false,
          preparation: null,
          quantity: 0.25,
          scalesLinearly: true,
          unit: "oz",
        },
      ],
    });
    const model = new MockLanguageModelV4({
      doGenerate: [
        mockGeneration(invalid),
        mockGeneration(replacementOutput(corrected.candidates[0]!)),
        mockGeneration(laneOutput(1)),
        mockGeneration(laneOutput(2)),
      ],
    });

    const result = await generateWeeklyCandidates({
      ...candidateRequest,
      model,
    });

    expect(result.batchAttempts).toEqual({
      "familiar-fast": 2,
      "ingredient-sharing": 1,
      variety: 1,
    });
    expect(model.doGenerateCalls).toHaveLength(4);
    const retryPrompt = userPrompt(model, 1);
    expect(retryPrompt).toContain("INVALID_UNIT_FOR_INGREDIENT");
    expect(retryPrompt).toContain("catalogKey=i004");
    expect(retryPrompt).toContain("unit=tsp");
    expect(retryPrompt).toContain("allowedUnits=oz,lb");
    expect(retryPrompt).toContain(
      "Generate exactly 3 meaningfully different alternatives for the single supplied slot now.",
    );
    expect(retryPrompt).not.toContain("RAW-DOMAIN-FAILURE-SENTINEL");
  });

  it("repairs two invalid candidates sequentially without replacing the valid three", async () => {
    const invalid = laneOutput(0);
    for (const slotIndex of [0, 1]) {
      invalid.candidates[slotIndex] = candidate(0, slotIndex, {
        ingredients: [
          ...invalid.candidates[slotIndex]!.ingredients,
          {
            catalogKey: "i004",
            isOptional: false,
            preparation: null,
            quantity: 2,
            scalesLinearly: true,
            unit: "tsp",
          },
        ],
      });
    }
    const firstReplacement = candidate(0, 0, {
      title: "Repaired first dinner",
    });
    const secondReplacement = candidate(0, 1, {
      title: "Repaired second dinner",
    });
    const model = new MockLanguageModelV4({
      doGenerate: [
        mockGeneration(invalid),
        mockGeneration(replacementOutput(firstReplacement)),
        mockGeneration(replacementOutput(secondReplacement)),
        mockGeneration(laneOutput(1)),
        mockGeneration(laneOutput(2)),
      ],
    });

    const result = await generateWeeklyCandidates({
      ...candidateRequest,
      model,
    });

    expect(result.batchAttempts["familiar-fast"]).toBe(3);
    expect(model.doGenerateCalls).toHaveLength(5);
    expect(userPrompt(model, 1)).toContain(
      `DINNER_SLOTS_JSON\n${JSON.stringify([slots[0]])}`,
    );
    expect(userPrompt(model, 2)).toContain(
      `DINNER_SLOTS_JSON\n${JSON.stringify([slots[1]])}`,
    );
    expect(userPrompt(model, 2)).toContain(firstReplacement.title);
    expect(result.candidates.map((item) => item.title)).toEqual(
      expect.arrayContaining([
        firstReplacement.title,
        secondReplacement.title,
        candidate(0, 2).title,
        candidate(0, 3).title,
        candidate(0, 4).title,
      ]),
    );
  });

  it("writes five locked recipes in parallel batches of three and two", async () => {
    const selected = normalizedPool().slice(0, 5);
    const before = structuredClone(selected);
    const model = new MockLanguageModelV4({
      doGenerate: [
        mockGeneration(instructionOutput(selected.slice(0, 3))),
        mockGeneration(instructionOutput(selected.slice(3, 5))),
      ],
      modelId: "gemini-3.7-flash",
    });

    const result = await generateWeeklyInstructions({
      model,
      selectedCandidates: selected,
    });

    expect(result.recipes).toHaveLength(5);
    expect(result.batchAttempts).toEqual([1, 1]);
    expect(result.recipes[0]?.steps.map((step) => step.position)).toEqual([
      1, 2,
    ]);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(selected).toEqual(before);

    for (const [index, call] of model.doGenerateCalls.entries()) {
      expect(call.maxOutputTokens).toBe(12_000);
      expect(call.reasoning).toBe("low");
      const schema = JSON.stringify(
        (call.responseFormat as { schema?: unknown }).schema,
      );
      expect(schema).not.toContain('"title"');
      expect(schema).not.toContain('"ingredients"');
      expect(schema).not.toContain('"baseServings"');
      const prompt = userPrompt(model, index);
      for (const id of UUIDS) expect(prompt).not.toContain(id);
    }
    expect(userPrompt(model, 0)).toContain('"candidateKey":"c003"');
    expect(userPrompt(model, 0)).toContain(
      '"requiredIngredientKeys":["i001","i002","i003"]',
    );
    expect(userPrompt(model, 0)).toContain(
      '"requiredTemperaturePhrase":"165 degrees Fahrenheit"',
    );
    expect(userPrompt(model, 0)).toContain('"validationChecklist"');
    expect(userPrompt(model, 0)).not.toContain('"candidateKey":"c004"');
    expect(userPrompt(model, 1)).toContain('"candidateKey":"c005"');
  });

  it("retries an instruction coverage failure with summarized feedback only", async () => {
    const selected = normalizedPool().slice(0, 5);
    const invalidFirstBatch = instructionOutput(selected.slice(0, 3), true);
    invalidFirstBatch.recipes[0]!.description = "RAW-INSTRUCTION-SENTINEL";
    const model = new MockLanguageModelV4({
      doGenerate: [
        mockGeneration(invalidFirstBatch),
        mockGeneration(instructionOutput(selected.slice(3, 5))),
        mockGeneration(instructionOutput(selected.slice(0, 3))),
      ],
    });

    const result = await generateWeeklyInstructions({
      model,
      selectedCandidates: selected,
    });

    expect(result.batchAttempts).toEqual([2, 1]);
    expect(model.doGenerateCalls).toHaveLength(3);
    const retryPrompt = userPrompt(model, 2);
    expect(retryPrompt).toContain("INGREDIENT_COVERAGE");
    expect(retryPrompt).toContain("candidateKey=c001");
    expect(retryPrompt).toContain("missingRequiredIngredientKeys=i003");
    expect(retryPrompt).not.toContain("RAW-INSTRUCTION-SENTINEL");
  });

  it("rejects metric measurements and Celsius in generated instructions", async () => {
    const selected = normalizedPool().slice(0, 5);
    const invalidFirstBatch = instructionOutput(selected.slice(0, 3));
    invalidFirstBatch.recipes[0]!.description =
      "A chicken dinner with 350 grams of rice and 200 ml of sauce.";
    invalidFirstBatch.recipes[0]!.steps[1]!.instruction =
      "Cook at 75 degrees Celsius until the chicken reaches 165 degrees Fahrenheit.";
    const model = new MockLanguageModelV4({
      doGenerate: [
        mockGeneration(invalidFirstBatch),
        mockGeneration(instructionOutput(selected.slice(3, 5))),
        mockGeneration(instructionOutput(selected.slice(0, 3))),
      ],
    });

    const result = await generateWeeklyInstructions({
      model,
      selectedCandidates: selected,
    });

    expect(result.batchAttempts).toEqual([2, 1]);
    expect(JSON.stringify(result.recipes)).not.toMatch(/grams|Celsius/iu);
    const retryPrompt = userPrompt(model, 2);
    expect(retryPrompt).toContain("SCHEMA_MISMATCH");
    expect(retryPrompt).not.toContain("350 grams");
    expect(retryPrompt).not.toContain("75 degrees Celsius");
  });

  it("retries with the candidate key and exact required temperature phrase", async () => {
    const selected = normalizedPool().slice(0, 5);
    const invalidFirstBatch = instructionOutput(selected.slice(0, 3));
    invalidFirstBatch.recipes[0]!.steps[1]!.instruction =
      "Cook the chicken completely and check it with a thermometer.";
    const model = new MockLanguageModelV4({
      doGenerate: [
        mockGeneration(invalidFirstBatch),
        mockGeneration(instructionOutput(selected.slice(3, 5))),
        mockGeneration(instructionOutput(selected.slice(0, 3))),
      ],
    });

    await generateWeeklyInstructions({
      model,
      selectedCandidates: selected,
    });

    const retryPrompt = userPrompt(model, 2);
    expect(retryPrompt).toContain("MISSING_INTERNAL_TEMPERATURE");
    expect(retryPrompt).toContain("candidateKey=c001");
    expect(retryPrompt).toContain(
      'requiredTemperaturePhrase="165 degrees Fahrenheit"',
    );
  });

  it("exposes only bounded validation diagnostics after the final attempt", async () => {
    const selected = normalizedPool().slice(0, 5);
    const invalid = instructionOutput(selected.slice(0, 3), true);
    invalid.recipes[0]!.description = "RAW-OUTPUT-MUST-NOT-BE-AUDITED";
    const model = new MockLanguageModelV4({
      doGenerate: [
        mockGeneration(invalid),
        mockGeneration(instructionOutput(selected.slice(3, 5))),
        mockGeneration(invalid),
        mockGeneration(invalid),
      ],
    });

    const error = await generateWeeklyInstructions({
      model,
      selectedCandidates: selected,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WeeklyPlanGenerationError);
    expect(error).toMatchObject({
      attemptCount: 3,
      batch: "1",
      validationIssues: [
        "INGREDIENT_COVERAGE: candidateKey=c001; missingRequiredIngredientKeys=i003",
      ],
    });
    expect(JSON.stringify(error)).not.toContain(
      "RAW-OUTPUT-MUST-NOT-BE-AUDITED",
    );
  });
});
