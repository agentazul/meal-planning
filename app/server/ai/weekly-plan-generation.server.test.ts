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
  WeeklyPlanGenerationError,
} from "~/server/ai/weekly-plan-generation.server";

const UUIDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
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

function mockGeneration(
  output: unknown,
  inputTokens = 10,
  outputTokens = 20,
) {
  return {
    content: [{ text: JSON.stringify(output), type: "text" as const }],
    finishReason: { raw: undefined, unified: "stop" as const },
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
  gateway: { tags: ["environment:test"], user: "household-test" },
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

describe("weekly plan AI generation", () => {
  it("runs three metadata-only candidate lanes with safe bounded context", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [0, 1, 2].map((laneIndex) =>
        mockGeneration(laneOutput(laneIndex)),
      ),
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
      expect(call.maxOutputTokens).toBe(4_500);
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
      expect(call.providerOptions?.gateway).toMatchObject({
        caching: "auto",
        user: "household-test",
      });
      const instructions = call.prompt.find((item) => item.role === "system");
      expect(instructions?.content).toContain(
        "conventional US recipe units only",
      );
      expect(instructions?.content).toContain("Never use metric units");

      const prompt = userPrompt(model, index);
      expect(prompt).toContain("UNTRUSTED_RECENT_MEAL_HISTORY_JSON");
      expect(prompt).toContain("Chicken Alfredo");
      expect(prompt).toContain("baking then resting");
      expect(prompt).not.toContain("Matt");
      expect(prompt).not.toContain("Desirae");
      for (const id of UUIDS) expect(prompt).not.toContain(id);
    }
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
    expect(result.candidates.every((item) =>
      item.ingredients.every((ingredient) =>
        US_RECIPE_MEASUREMENT_UNIT_SET.has(ingredient.unit),
      ),
    )).toBe(true);
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
    expect(model.doGenerateCalls).toHaveLength(4);
    const retryPrompt = userPrompt(model, 3);
    expect(retryPrompt).toContain("SLOT_CONSTRAINT_MISMATCH");
    expect(retryPrompt).not.toContain("RAW-FIRST-DRAFT-SENTINEL");
  });

  it("retries each eligible lane once when domain normalization rejects the pool", async () => {
    const invalid = laneOutput(0);
    invalid.candidates[0] = candidate(0, 0, {
      ingredients: [
        invalid.candidates[0]!.ingredients[0]!,
        {
          ...invalid.candidates[0]!.ingredients[1]!,
          unit: "cup",
        },
        invalid.candidates[0]!.ingredients[2]!,
      ],
      title: "RAW-DOMAIN-FAILURE-SENTINEL",
    });
    const model = new MockLanguageModelV4({
      doGenerate: [
        mockGeneration(invalid),
        mockGeneration(laneOutput(1)),
        mockGeneration(laneOutput(2)),
        mockGeneration(laneOutput(0)),
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
      "ingredient-sharing": 2,
      variety: 2,
    });
    expect(model.doGenerateCalls).toHaveLength(6);
    for (const callIndex of [3, 4, 5]) {
      const retryPrompt = userPrompt(model, callIndex);
      expect(retryPrompt).toContain("INVALID_UNIT");
      expect(retryPrompt).not.toContain("RAW-DOMAIN-FAILURE-SENTINEL");
    }
  });

  it("writes five locked recipes in parallel batches of three and two", async () => {
    const selected = normalizedPool().slice(0, 5);
    const before = structuredClone(selected);
    const model = new MockLanguageModelV4({
      doGenerate: [
        mockGeneration(instructionOutput(selected.slice(0, 3))),
        mockGeneration(instructionOutput(selected.slice(3, 5))),
      ],
    });

    const result = await generateWeeklyInstructions({
      gateway: candidateRequest.gateway,
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
      gateway: candidateRequest.gateway,
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
      gateway: candidateRequest.gateway,
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
      gateway: candidateRequest.gateway,
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
      ],
    });

    const error = await generateWeeklyInstructions({
      gateway: candidateRequest.gateway,
      model,
      selectedCandidates: selected,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WeeklyPlanGenerationError);
    expect(error).toMatchObject({
      attemptCount: 2,
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
