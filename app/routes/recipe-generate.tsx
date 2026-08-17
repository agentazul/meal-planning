import {
  ArrowLeft,
  BookOpenCheck,
  ListChecks,
  ShieldCheck,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { data, Form, Link, redirect } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/recipe-generate";
import { Field, FormError, SubmitButton } from "~/components/form-controls";
import {
  GeneratedRecipeReview,
  type GeneratedRecipeReview as GeneratedRecipeReviewData,
} from "~/components/generated-recipe-review";
import { PageHeader } from "~/components/page-header";
import { todayInTimezone } from "~/domain/dates";
import {
  buildGeneratedRecipeCatalog,
  GENERATED_RECIPE_ACTIVE_TIME_RANGES,
  generatedRecipeConstraintsSchema,
  generatedRecipeModelOutputSchema,
  GeneratedRecipeValidationError,
  normalizeGeneratedRecipeDraft,
  type GeneratedRecipeConstraints,
  type NormalizedGeneratedRecipeDraft,
} from "~/domain/generated-recipe";
import { calculateServingTarget } from "~/domain/servings";
import {
  fingerprintGeneratedRecipeCatalog,
  hasValidGeneratedDraftSignature,
  signGeneratedDraft,
} from "~/server/ai/generated-draft-token.server";
import {
  generateRecipeDraft,
  RecipeGenerationError,
} from "~/server/ai/recipe-generation.server";
import {
  requireIdentity,
  requireScopedDatabase,
} from "~/server/context.server";
import {
  getSuccessfulRecipeGenerationAttempt,
  RecipeGenerationAttemptError,
  recordRecipeGenerationFailure,
  recordRecipeGenerationSuccess,
  reserveRecipeGenerationAttempt,
  type RecipeGenerationFailureReason,
} from "~/server/data/recipe-generation.server";
import {
  createHouseholdRecipe,
  listIngredientReferences,
  type IngredientReference,
} from "~/server/data/recipes.server";
import { listPresenceMembers } from "~/server/data/presence.server";
import { getServerEnv } from "~/server/env.server";

const MAX_DRAFT_AGE_MS = 2 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

const wholeNumberField = (minimum: number, maximum: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, "Enter a whole number.")
    .transform(Number)
    .pipe(z.number().int().min(minimum).max(maximum));

const generateFormSchema = z
  .strictObject({
    baseServings: wholeNumberField(1, 20),
    brief: z
      .string()
      .trim()
      .min(3, "Describe the dinner you want.")
      .max(1_000, "Keep the dinner request under 1,000 characters."),
    effortTier: z.enum(["weeknight", "weekend", "project"]),
    maxActiveTimeMinutes: wholeNumberField(5, 240),
  })
  .superRefine((values, context) => {
    const range = GENERATED_RECIPE_ACTIVE_TIME_RANGES[values.effortTier];
    if (
      values.maxActiveTimeMinutes < range.minimumMinutes ||
      values.maxActiveTimeMinutes > range.maximumMinutes
    ) {
      context.addIssue({
        code: "custom",
        message: `${values.effortTier} active-time maximum must be from ${Math.max(5, range.minimumMinutes)} through ${range.maximumMinutes} minutes.`,
        path: ["maxActiveTimeMinutes"],
      });
    }
  });

const saveFormSchema = z.strictObject({
  draftEnvelope: z.string().min(2).max(200_000),
  draftSignature: z.string().min(1).max(200),
});

const signedDraftEnvelopeSchema = z.strictObject({
  attemptId: z.uuid(),
  catalogFingerprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  constraints: generatedRecipeConstraintsSchema,
  generatedAtEpochMs: z.number().int().nonnegative(),
  householdId: z.uuid(),
  model: z.string().min(1).max(200),
  modelOutput: generatedRecipeModelOutputSchema,
  userId: z.uuid(),
});

type GenerateFormValues = Readonly<{
  baseServings: string;
  brief: string;
  effortTier: "weeknight" | "weekend" | "project";
  maxActiveTimeMinutes: string;
}>;

const defaultFormValues: GenerateFormValues = {
  baseServings: "",
  brief: "",
  effortTier: "weeknight",
  maxActiveTimeMinutes: "30",
};

export const meta: Route.MetaFunction = () => [
  { title: "Generate a recipe | Done For You Kitchen" },
  {
    name: "description",
    content:
      "Generate and review a structured household recipe using canonical ingredients.",
  },
];

function firstIssue(
  result: Readonly<{ issues: readonly Readonly<{ message: string }>[] }>,
): string {
  return result.issues[0]?.message ?? "Check the recipe request and try again.";
}

function formValues(formData: FormData): GenerateFormValues {
  const effortTier = formData.get("effortTier");
  return {
    baseServings: String(formData.get("baseServings") ?? ""),
    brief: String(formData.get("brief") ?? ""),
    effortTier:
      effortTier === "weekend" || effortTier === "project"
        ? effortTier
        : "weeknight",
    maxActiveTimeMinutes: String(
      formData.get("maxActiveTimeMinutes") ?? "30",
    ),
  };
}

function createCatalog(references: readonly IngredientReference[]) {
  return buildGeneratedRecipeCatalog(
    references.map((ingredient) => ({
      baseUnit: ingredient.baseUnit,
      category: ingredient.category,
      densityGramsPerMl: ingredient.densityGramsPerMl,
      gramsPerCount: ingredient.gramsPerCount,
      id: ingredient.id,
      name: ingredient.name,
    })),
  );
}

function createReviewDraft(
  draft: NormalizedGeneratedRecipeDraft,
  references: readonly IngredientReference[],
): GeneratedRecipeReviewData {
  const referenceById = new Map(
    references.map((ingredient) => [ingredient.id, ingredient]),
  );

  return {
    ...draft,
    ingredients: draft.ingredients.map((ingredient) => {
      const reference = referenceById.get(ingredient.canonicalIngredientId);
      if (!reference) {
        throw new Error("Generated recipe references a missing ingredient");
      }

      return {
        ...ingredient,
        baseUnit: reference.baseUnit,
        name: reference.name,
      };
    }),
  };
}

function failureReason(error: unknown): RecipeGenerationFailureReason {
  if (error instanceof GeneratedRecipeValidationError) {
    return "validation";
  }
  if (error instanceof RecipeGenerationError) {
    if (error.code === "invalid_model_output" || error.code === "invalid_input") {
      return "validation";
    }
    if (error.code === "request_cancelled") {
      return "timeout";
    }
    return "provider";
  }
  return "unknown";
}

function generationErrorMessage(error: unknown): string {
  if (error instanceof RecipeGenerationError) {
    return error.message;
  }
  if (error instanceof GeneratedRecipeValidationError) {
    return "The generated recipe could not be validated. Try a clearer request.";
  }
  return "Recipe generation is temporarily unavailable. Try again.";
}

async function handleGenerate(
  context: Route.ActionArgs["context"],
  request: Request,
  formData: FormData,
) {
  const submittedValues = formValues(formData);
  const parsed = generateFormSchema.safeParse({
    baseServings: formData.get("baseServings"),
    brief: formData.get("brief"),
    effortTier: formData.get("effortTier"),
    maxActiveTimeMinutes: formData.get("maxActiveTimeMinutes"),
  });

  if (!parsed.success) {
    return data(
      {
        error: firstIssue(parsed.error),
        form: submittedValues,
        kind: "error" as const,
      },
      { status: 400 },
    );
  }

  const scoped = requireScopedDatabase(context);
  const references = await listIngredientReferences(scoped);
  const catalog = createCatalog(references);
  const constraints: GeneratedRecipeConstraints = {
    maxActiveTimeMinutes: parsed.data.maxActiveTimeMinutes,
    requestedEffortTier: parsed.data.effortTier,
    requestedServings: parsed.data.baseServings,
  };
  const env = getServerEnv();

  let attemptId: string;
  ({ attemptId } = await reserveRecipeGenerationAttempt(scoped));

  const startedAt = Date.now();
  try {
    const generated = await generateRecipeDraft({
      abortSignal: request.signal,
      catalog,
      constraints,
      model: env.AI_RECIPE_MODEL,
      userBrief: parsed.data.brief,
    });

    await recordRecipeGenerationSuccess(scoped, {
      attemptCount: generated.attemptCount,
      attemptId,
      durationMs: Date.now() - startedAt,
      model: env.AI_RECIPE_MODEL,
      usage: generated.usage,
    });

    const signed = signGeneratedDraft(
      {
        attemptId,
        catalogFingerprint: fingerprintGeneratedRecipeCatalog(catalog),
        constraints,
        generatedAtEpochMs: Date.now(),
        householdId: scoped.scope.householdId,
        model: env.AI_RECIPE_MODEL,
        modelOutput: generated.modelOutput,
        userId: scoped.scope.userId,
      },
      env.SESSION_COOKIE_SECRET,
    );

    return {
      attemptCount: generated.attemptCount,
      draft: createReviewDraft(generated.draft, references),
      envelope: signed.envelope,
      form: submittedValues,
      kind: "draft" as const,
      signature: signed.signature,
    };
  } catch (error) {
    try {
      await recordRecipeGenerationFailure(scoped, {
        attemptCount:
          error instanceof RecipeGenerationError
            ? error.attemptCount
            : undefined,
        attemptId,
        durationMs: Date.now() - startedAt,
        reason: failureReason(error),
      });
    } catch {
      // The primary request still returns a safe recoverable error.
    }

    return data(
      {
        error: generationErrorMessage(error),
        form: submittedValues,
        kind: "error" as const,
      },
      { status: error instanceof RecipeGenerationError ? 502 : 500 },
    );
  }
}

async function handleSave(
  context: Route.ActionArgs["context"],
  formData: FormData,
) {
  const parsed = saveFormSchema.safeParse({
    draftEnvelope: formData.get("draftEnvelope"),
    draftSignature: formData.get("draftSignature"),
  });

  if (!parsed.success) {
    return data(
      {
        error: "This recipe draft could not be read. Generate a new draft.",
        form: null,
        kind: "error" as const,
      },
      { status: 400 },
    );
  }

  const scoped = requireScopedDatabase(context);
  const env = getServerEnv();

  if (
    !hasValidGeneratedDraftSignature(
      parsed.data.draftEnvelope,
      parsed.data.draftSignature,
      env.SESSION_COOKIE_SECRET,
    )
  ) {
    return data(
      {
        error: "This recipe draft was changed or is no longer valid. Generate a new draft.",
        form: null,
        kind: "error" as const,
      },
      { status: 400 },
    );
  }

  let envelopeValue: unknown;
  try {
    envelopeValue = JSON.parse(parsed.data.draftEnvelope) as unknown;
  } catch {
    envelopeValue = null;
  }

  const parsedEnvelope = signedDraftEnvelopeSchema.safeParse(envelopeValue);
  const now = Date.now();
  if (
    !parsedEnvelope.success ||
    parsedEnvelope.data.householdId !== scoped.scope.householdId ||
    parsedEnvelope.data.userId !== scoped.scope.userId ||
    parsedEnvelope.data.generatedAtEpochMs < now - MAX_DRAFT_AGE_MS ||
    parsedEnvelope.data.generatedAtEpochMs > now + MAX_CLOCK_SKEW_MS
  ) {
    return data(
      {
        error: "This recipe draft has expired. Generate a fresh draft before saving.",
        form: null,
        kind: "error" as const,
      },
      { status: 400 },
    );
  }

  const successfulAttempt = await getSuccessfulRecipeGenerationAttempt(
    scoped,
    parsedEnvelope.data.attemptId,
  );
  if (!successfulAttempt || successfulAttempt.model !== parsedEnvelope.data.model) {
    return data(
      {
        error: "This recipe draft could not be verified. Generate a new draft.",
        form: null,
        kind: "error" as const,
      },
      { status: 400 },
    );
  }

  try {
    const references = await listIngredientReferences(scoped);
    const currentCatalog = createCatalog(references);
    if (
      fingerprintGeneratedRecipeCatalog(currentCatalog) !==
      parsedEnvelope.data.catalogFingerprint
    ) {
      return data(
        {
          error:
            "The ingredient catalog changed after this draft was generated. Generate a fresh draft before saving.",
          form: null,
          kind: "error" as const,
        },
        { status: 409 },
      );
    }
    const normalized = normalizeGeneratedRecipeDraft(
      parsedEnvelope.data.modelOutput,
      currentCatalog,
      parsedEnvelope.data.constraints,
    );
    const recipeId = await createHouseholdRecipe(scoped, {
      ...normalized,
      generationAttemptId: parsedEnvelope.data.attemptId,
      source: "generated",
    });

    throw redirect(`/recipes/${recipeId}`);
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }
    if (error instanceof RecipeGenerationAttemptError) {
      return data(
        {
          error:
            error.code === "already_saved"
              ? "This AI draft has already been saved to the recipe library."
              : "This AI draft could not be verified. Generate a new draft.",
          form: null,
          kind: "error" as const,
        },
        { status: 409 },
      );
    }
    if (error instanceof GeneratedRecipeValidationError) {
      return data(
        {
          error:
            "The ingredient catalog changed and this draft no longer passes validation. Generate a new draft.",
          form: null,
          kind: "error" as const,
        },
        { status: 409 },
      );
    }
    throw error;
  }
}

export async function loader({ context }: Route.LoaderArgs) {
  const identity = requireIdentity(context);
  const scoped = requireScopedDatabase(context);
  const today = todayInTimezone(identity.householdTimezone);
  const [references, members] = await Promise.all([
    listIngredientReferences(scoped),
    listPresenceMembers(scoped, { from: today, to: today }),
  ]);
  const servingTarget = calculateServingTarget({
    date: today,
    leftoverBufferServings: 0,
    members: members.map((member) => ({
      appetiteMultiplier: member.appetiteMultiplier,
      defaultIsPresent: member.defaultIsPresent,
      id: member.id,
      active: member.active,
      presenceOverrides: member.overrides,
      presenceRules: member.rules,
    })),
  });

  return {
    ingredientCount: references.length,
    suggestedBaseServings: Math.max(1, Math.min(20, servingTarget.target)),
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  const formData = await request.formData();
  const intent = formData.get("_intent");

  if (intent === "generate") {
    return handleGenerate(context, request, formData);
  }
  if (intent === "save") {
    return handleSave(context, formData);
  }

  return data(
    {
      error: "Choose a recipe action and try again.",
      form: null,
      kind: "error" as const,
    },
    { status: 400 },
  );
}

export default function GenerateRecipe({
  actionData,
  loaderData,
}: Route.ComponentProps) {
  const form = actionData?.form ?? {
    ...defaultFormValues,
    baseServings: String(loaderData.suggestedBaseServings),
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        actions={
          <Link className="button button-secondary" to="/recipes">
            <ArrowLeft aria-hidden="true" size={17} />
            Recipe library
          </Link>
        }
        description="Describe a real dinner, set the boundaries, and get a complete recipe built from the household ingredient catalog. Nothing is saved until you approve the draft."
        eyebrow="AI recipe workshop"
        title="Turn a dinner idea into a cookable plan."
      />

      <div className="mb-7 grid items-start gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
        <Form
          className="surface overflow-hidden"
          id="recipe-generator"
          method="post"
        >
          <input name="_intent" type="hidden" value="generate" />
          <header className="border-b border-rule bg-herb px-5 py-5 text-paper-light sm:px-7">
            <p className="mb-2 flex items-center gap-2 text-[0.68rem] font-bold tracking-[0.14em] text-butter uppercase">
              <WandSparkles aria-hidden="true" size={15} />
              Your recipe request
            </p>
            <h2 className="m-0 text-3xl text-paper-light">
              What sounds good tonight?
            </h2>
          </header>

          <div className="grid gap-5 p-5 sm:p-7">
            <Field
              help="Include the protein, flavor, spice level, ingredients to avoid, and equipment that matter."
              htmlFor="brief"
              label="Dinner brief"
            >
              <textarea
                autoFocus
                className="textarea min-h-36"
                defaultValue={form.brief}
                id="brief"
                maxLength={1_000}
                name="brief"
                placeholder="A cozy chicken dinner with plenty of vegetables, mild spice, and no mushrooms. Use one sheet pan."
                required
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field
                help="Prefilled from who is home tonight and each person's appetite. You can change it for this recipe."
                htmlFor="baseServings"
                label="Servings"
              >
                <input
                  className="input"
                  defaultValue={form.baseServings}
                  id="baseServings"
                  inputMode="numeric"
                  max="20"
                  min="1"
                  name="baseServings"
                  required
                  step="1"
                  type="number"
                />
              </Field>

              <Field htmlFor="effortTier" label="Effort">
                <select
                  className="select"
                  defaultValue={form.effortTier}
                  id="effortTier"
                  name="effortTier"
                >
                  <option value="weeknight">Weeknight</option>
                  <option value="weekend">Weekend</option>
                  <option value="project">Project</option>
                </select>
              </Field>

              <Field
                help="Weeknight max 45. Weekend 20 to 120. Project 45 to 240."
                htmlFor="maxActiveTimeMinutes"
                label="Active minutes max"
              >
                <input
                  className="input"
                  defaultValue={form.maxActiveTimeMinutes}
                  id="maxActiveTimeMinutes"
                  inputMode="numeric"
                  max="240"
                  min="5"
                  name="maxActiveTimeMinutes"
                  required
                  step="5"
                  type="number"
                />
              </Field>
            </div>

            <FormError>
              {actionData?.kind === "error" ? actionData.error : null}
            </FormError>

            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-rule pt-5">
              <p className="m-0 flex max-w-md items-center gap-2 text-xs leading-5 text-muted">
                <ShieldCheck aria-hidden="true" className="shrink-0" size={16} />
                Uses only {loaderData.ingredientCount} canonical ingredients and
                checks the result before showing it.
              </p>
              <SubmitButton
                pendingLabel="Drafting recipe"
                pendingMatch={{ _intent: "generate" }}
              >
                <Sparkles aria-hidden="true" size={17} />
                {actionData?.kind === "draft"
                  ? "Generate another"
                  : "Generate recipe draft"}
              </SubmitButton>
            </div>
          </div>
        </Form>

        <aside className="surface overflow-hidden">
          <div className="border-b border-rule bg-butter/25 p-5 sm:p-6">
            <p className="eyebrow">What happens next</p>
            <h2 className="m-0 text-2xl">A draft, not a blind save.</h2>
          </div>
          <ol className="m-0 grid list-none gap-0 p-0">
            <li className="flex gap-3 border-b border-rule p-5 sm:p-6">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-ink font-mono text-xs font-bold text-paper-light">
                01
              </span>
              <span>
                <strong className="block text-sm text-ink">Structured generation</strong>
                <span className="mt-1 block text-xs leading-5 text-muted">
                  The AI must return recipe fields and catalog keys, not a block
                  of free text.
                </span>
              </span>
            </li>
            <li className="flex gap-3 border-b border-rule p-5 sm:p-6">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-clay font-mono text-xs font-bold text-paper-light">
                02
              </span>
              <span>
                <strong className="block text-sm text-ink">Validation gate</strong>
                <span className="mt-1 block text-xs leading-5 text-muted">
                  Yield, time, units, canonical ingredients, and protein
                  temperatures are checked before review.
                </span>
              </span>
            </li>
            <li className="flex gap-3 p-5 sm:p-6">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-herb font-mono text-xs font-bold text-paper-light">
                03
              </span>
              <span>
                <strong className="block text-sm text-ink">You decide</strong>
                <span className="mt-1 block text-xs leading-5 text-muted">
                  Review every ingredient and step. Save only the recipe you
                  want on your household shelf.
                </span>
              </span>
            </li>
          </ol>
          <div className="flex gap-3 border-t border-rule bg-paper-light p-5 text-xs leading-5 text-muted sm:p-6">
            <BookOpenCheck aria-hidden="true" className="shrink-0 text-herb" size={18} />
            <p className="m-0">
              This creates one complete recipe. Weekly candidate scoring,
              pantry-aware sharing, and bench meals come with the full planner
              generation phase.
            </p>
          </div>
        </aside>
      </div>

      {actionData?.kind === "draft" ? (
        <GeneratedRecipeReview
          draft={actionData.draft}
          envelope={actionData.envelope}
          signature={actionData.signature}
        />
      ) : (
        <section className="surface flex items-center gap-4 border-dashed p-5 text-sm text-muted sm:p-6">
          <span className="grid size-11 shrink-0 place-items-center rounded-full border border-rule bg-paper-light text-herb">
            <ListChecks aria-hidden="true" size={20} />
          </span>
          <p className="m-0 max-w-2xl leading-6">
            Your reviewed recipe draft will appear here. Generating does not add
            anything to the recipe library until you choose Save to recipes.
          </p>
        </section>
      )}
    </div>
  );
}
