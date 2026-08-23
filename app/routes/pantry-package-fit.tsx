import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  Check,
  CircleDot,
  CookingPot,
  PackageCheck,
  PencilLine,
  Scale,
  ShoppingBasket,
} from "lucide-react";
import { Form, Link, redirect } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/pantry-package-fit";
import { Field, FormError, SubmitButton } from "~/components/form-controls";
import { PageHeader } from "~/components/page-header";
import {
  formatDateLabel,
  getWeekStartDate,
  parseDateOnly,
  todayInTimezone,
} from "~/domain/dates";
import { formatUsRecipeQuantity } from "~/domain/us-kitchen-display";
import {
  US_RECIPE_MEASUREMENT_UNITS,
  type CanonicalUnit,
  type UsRecipeMeasurementUnit,
} from "~/domain/units";
import {
  requireIdentity,
  requireScopedDatabase,
  type ScopedDatabase,
} from "~/server/context.server";
import {
  getPantryPackageFitReview,
  PantryPackageFitError,
  resolvePantryPackageFit,
  type PantryPackageFitMismatch,
  type ResolvePantryPackageFitInput,
} from "~/server/data/pantry-package-fit.server";
import { RecipePackageFitEditError } from "~/server/data/recipes.server";

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) => {
      try {
        parseDateOnly(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Use a valid YYYY-MM-DD date." },
  );

const positiveQuantitySchema = z
  .string()
  .trim()
  .refine(
    (value) => value !== "" && Number.isFinite(Number(value)) && Number(value) > 0,
    "Enter an amount greater than zero.",
  )
  .transform(Number)
  .pipe(z.number().positive().max(99_999_999_999));

const baseActionSchema = z.object({
  canonicalIngredientId: z.uuid(),
  weekStart: dateOnlySchema,
});

const keepRecipeSchema = baseActionSchema.extend({
  intent: z.literal("keep-recipe"),
});

const alternateStoreSchema = baseActionSchema.extend({
  intent: z.literal("alternate-store"),
  quantity: positiveQuantitySchema,
  shoppingLabel: z.string().trim().max(120).transform((value) => value || null),
  unit: z.enum(US_RECIPE_MEASUREMENT_UNITS),
});

const editSavedRecipeSchema = baseActionSchema.extend({
  acknowledgedPermanentChange: z
    .literal("true", {
      error: "Confirm that you reviewed the servings and every method step.",
    })
    .transform(() => true as const),
  expectedRecipeUpdatedAt: z.iso.datetime().transform((value) => new Date(value)),
  instructions: z
    .string()
    .trim()
    .min(1, "Keep at least one method instruction.")
    .max(100_000),
  intent: z.literal("edit-saved-recipe"),
  quantity: positiveQuantitySchema,
  recipeId: z.uuid(),
  recipeIngredientId: z.uuid(),
  unit: z.enum(US_RECIPE_MEASUREMENT_UNITS),
});

const actionSchema = z.discriminatedUnion("intent", [
  keepRecipeSchema,
  alternateStoreSchema,
  editSavedRecipeSchema,
]);

export type ParsedPantryPackageFitAction =
  | Readonly<{ data: z.infer<typeof actionSchema>; success: true }>
  | Readonly<{ error: string; success: false }>;

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Review this choice and try again.";
}

/** Parse every package-fit decision from plain FormData for no-JavaScript use. */
export function parsePantryPackageFitAction(
  formData: FormData,
): ParsedPantryPackageFitAction {
  const parsed = actionSchema.safeParse({
    acknowledgedPermanentChange: formData.get("acknowledgedPermanentChange"),
    canonicalIngredientId: formData.get("canonicalIngredientId"),
    expectedRecipeUpdatedAt: formData.get("expectedRecipeUpdatedAt"),
    instructions: formData.get("instructions"),
    intent: formData.get("intent"),
    quantity: formData.get("quantity"),
    recipeId: formData.get("recipeId"),
    recipeIngredientId: formData.get("recipeIngredientId"),
    shoppingLabel: formData.get("shoppingLabel"),
    unit: formData.get("unit"),
    weekStart: formData.get("weekStart"),
  });

  return parsed.success
    ? { data: parsed.data, success: true }
    : { error: firstIssue(parsed.error), success: false };
}

export function splitPackageFitInstructions(
  value: string,
): readonly Readonly<{ instruction: string; position: number }>[] {
  return value
    .split(/\r?\n/)
    .map((instruction) => instruction.trim())
    .filter(Boolean)
    .map((instruction, index) => ({ instruction, position: index + 1 }));
}

const statusCopy = {
  alternate: "Store amount saved. The shopping list and pantry return will use it.",
  kept: "Recipe kept. The shopping list will buy enough whole packages.",
  recipe: "Saved recipe updated. Package fit has been recalculated everywhere.",
} as const;

const errorCopy = {
  amount: "That store amount does not cover what the current recipes still need.",
  invalid: "That choice was incomplete. Review the highlighted option and try again.",
  unchanged:
    "Nothing changed because the saved-recipe amount and method are the same. Update at least one field and try again.",
  recipe: "The saved recipe could not be updated safely. Review its amount, unit, and method steps.",
  stale: "The week or recipe changed while this page was open. Review the fresh amounts before saving.",
} as const;

export const PACKAGE_FIT_RESULT_ANCHOR = "package-fit-result";

export const meta: Route.MetaFunction = () => [
  { title: "Package fit review | Done For You Kitchen" },
  {
    name: "description",
    content:
      "Resolve recipe and store-package mismatches before finalizing the shopping list.",
  },
];

export async function loader({ context, request }: Route.LoaderArgs) {
  const identity = requireIdentity(context);
  const url = new URL(request.url);
  const requestedWeek = url.searchParams.get("week");
  const parsedWeek = requestedWeek
    ? dateOnlySchema.safeParse(requestedWeek)
    : null;

  if (parsedWeek && !parsedWeek.success) {
    throw new Response("The week query must be a valid YYYY-MM-DD date.", {
      status: 400,
      statusText: "Invalid week",
    });
  }

  const weekStart = getWeekStartDate(
    parsedWeek?.data ?? todayInTimezone(identity.householdTimezone),
  );
  const review = await getPantryPackageFitReview(
    requireScopedDatabase(context),
    weekStart,
  );
  const saved = z.enum(["alternate", "kept", "recipe"]).safeParse(
    url.searchParams.get("saved"),
  );
  const error = z
    .enum(["amount", "invalid", "recipe", "stale", "unchanged"])
    .safeParse(url.searchParams.get("error"));

  return {
    ...review,
    error: error.success ? errorCopy[error.data] : null,
    message: saved.success ? statusCopy[saved.data] : null,
  };
}

export function reviewUrl(
  weekStart: string,
  result: Readonly<{ error?: keyof typeof errorCopy; saved?: keyof typeof statusCopy }>,
): string {
  const params = new URLSearchParams({ week: weekStart });
  if (result.error) params.set("error", result.error);
  if (result.saved) params.set("saved", result.saved);
  return `/pantry/package-fit?${params.toString()}#${PACKAGE_FIT_RESULT_ANCHOR}`;
}

async function persistPackageFitDecision(
  scoped: ScopedDatabase,
  input: ResolvePantryPackageFitInput,
  weekStart: string,
  saved: keyof typeof statusCopy,
): Promise<never> {
  try {
    await resolvePantryPackageFit(scoped, input);
  } catch (error) {
    if (error instanceof PantryPackageFitError) {
      const code =
        error.code === "CUSTOM_AMOUNT_INSUFFICIENT"
          ? "amount"
          : error.code === "STALE_BASIS" ||
              error.code === "MEAL_PLAN_NOT_FOUND" ||
              error.code === "CHOICE_NOT_FOUND"
            ? "stale"
            : "invalid";
      throw redirect(reviewUrl(weekStart, { error: code }));
    }
    if (error instanceof RecipePackageFitEditError) {
      throw redirect(
        reviewUrl(weekStart, {
          error:
            error.code === "NO_CHANGE"
              ? "unchanged"
              : error.code === "STALE_RECIPE"
                ? "stale"
                : "recipe",
        }),
      );
    }
    throw error;
  }
  throw redirect(reviewUrl(weekStart, { saved }));
}

export async function action({ context, request }: Route.ActionArgs) {
  const parsed = parsePantryPackageFitAction(await request.formData());
  if (!parsed.success) {
    const requestUrl = new URL(request.url);
    const fallbackWeek = dateOnlySchema.safeParse(requestUrl.searchParams.get("week"));
    throw redirect(reviewUrl(fallbackWeek.success ? fallbackWeek.data : getWeekStartDate(todayInTimezone(requireIdentity(context).householdTimezone)), { error: "invalid" }));
  }

  const scoped = requireScopedDatabase(context);
  const review = await getPantryPackageFitReview(scoped, parsed.data.weekStart);
  const mismatch = review.mismatches.find(
    (item) => item.canonicalIngredientId === parsed.data.canonicalIngredientId,
  );

  if (!mismatch || !review.mealPlanId) {
    throw redirect(reviewUrl(parsed.data.weekStart, { error: "stale" }));
  }

  if (parsed.data.intent === "alternate-store") {
    if (!mismatch.compatibleUnits.includes(parsed.data.unit)) {
      throw redirect(reviewUrl(parsed.data.weekStart, { error: "invalid" }));
    }
    return persistPackageFitDecision(scoped, {
      canonicalIngredientId: parsed.data.canonicalIngredientId,
      expectedBasisHash: mismatch.basisHash,
      intent: parsed.data.intent,
      mealPlanId: review.mealPlanId,
      quantity: parsed.data.quantity,
      shoppingLabel: parsed.data.shoppingLabel,
      unit: parsed.data.unit,
    }, parsed.data.weekStart, "alternate");
  }

  if (parsed.data.intent === "edit-saved-recipe") {
    const recipeDecision = parsed.data;
    const contributor = mismatch.contributors.find(
      (item) =>
        item.recipeId === recipeDecision.recipeId &&
        item.recipeIngredientId === recipeDecision.recipeIngredientId &&
        item.recipeUpdatedAt.getTime() ===
          recipeDecision.expectedRecipeUpdatedAt.getTime(),
    );
    if (!contributor || !mismatch.compatibleUnits.includes(recipeDecision.unit)) {
      throw redirect(reviewUrl(recipeDecision.weekStart, { error: "stale" }));
    }
    const instructions = splitPackageFitInstructions(recipeDecision.instructions);
    if (instructions.length === 0) {
      throw redirect(reviewUrl(recipeDecision.weekStart, { error: "invalid" }));
    }
    return persistPackageFitDecision(scoped, {
      acknowledgedPermanentChange: recipeDecision.acknowledgedPermanentChange,
      expectedRecipeUpdatedAt: recipeDecision.expectedRecipeUpdatedAt,
      instructions,
      intent: recipeDecision.intent,
      quantity: recipeDecision.quantity,
      recipeId: recipeDecision.recipeId,
      recipeIngredientId: recipeDecision.recipeIngredientId,
      unit: recipeDecision.unit,
    }, recipeDecision.weekStart, "recipe");
  }

  return persistPackageFitDecision(scoped, {
    canonicalIngredientId: parsed.data.canonicalIngredientId,
    expectedBasisHash: mismatch.basisHash,
    intent: parsed.data.intent,
    mealPlanId: review.mealPlanId,
  }, parsed.data.weekStart, "kept");
}

function formatBaseQuantity(
  quantity: number,
  baseUnit: CanonicalUnit,
): string {
  return formatUsRecipeQuantity({
    baseUnit,
    quantity,
    quantityInBaseUnit: quantity,
    unit: baseUnit,
  });
}

const unitLabels: Readonly<Record<UsRecipeMeasurementUnit, string>> = {
  count: "count",
  cup: "cups",
  fl_oz: "fluid ounces",
  lb: "pounds",
  oz: "ounces",
  tbsp: "tablespoons",
  tsp: "teaspoons",
};

function WeekDates({ dates }: Readonly<{ dates: readonly string[] }>) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs text-muted">
      <CalendarDays aria-hidden="true" size={13} />
      {dates.map((date) => formatDateLabel(date, { weekday: "short", month: "short", day: "numeric" })).join(", ")}
    </span>
  );
}

function unitLabel(unit: string): string {
  return unit in unitLabels
    ? unitLabels[unit as UsRecipeMeasurementUnit]
    : unit;
}

export function formatAlternateStoreChoice(
  choice: Readonly<{
    customLabel: string | null;
    customQuantity: number | null;
    customUnit: string | null;
  }>,
  defaultPurchaseDescription: string,
): string {
  const amount = `${choice.customQuantity} ${unitLabel(choice.customUnit ?? "")}`;
  const chosen = choice.customLabel
    ? `${choice.customLabel} (${amount})`
    : amount;
  return `${chosen}, instead of ${defaultPurchaseDescription}.`;
}

function HiddenDecisionFields({
  canonicalIngredientId,
  weekStart,
}: Readonly<{ canonicalIngredientId: string; weekStart: string }>) {
  return (
    <>
      <input name="canonicalIngredientId" type="hidden" value={canonicalIngredientId} />
      <input name="weekStart" type="hidden" value={weekStart} />
    </>
  );
}

function PermanentRecipeChoice({
  contributor,
  mismatch,
  weekStart,
}: Readonly<{
  contributor: PantryPackageFitMismatch["contributors"][number];
  mismatch: PantryPackageFitMismatch;
  weekStart: string;
}>) {
  const suggestion = contributor.suggestedQuantity;
  const fieldKey = `${contributor.recipeIngredientId}-${contributor.planEntryId}`;
  const risky =
    mismatch.risk !== "standard" ||
    contributor.methodReferenceRisk ||
    suggestion === null;
  const defaultQuantity = risky ? "" : String(suggestion);
  const beforePerServing = contributor.perServingBefore;
  const afterPerServing = contributor.perServingAfter;

  return (
    <details className="rounded-xl border border-rule bg-paper-light p-4 open:shadow-[3px_3px_0_rgba(29,42,34,0.10)]" name={`recipe-choice-${mismatch.canonicalIngredientId}`}>
      <summary className="cursor-pointer list-none">
        <span className="flex items-start justify-between gap-3">
          <span>
            <strong className="block text-ink">{contributor.recipeTitle}</strong>
            <WeekDates dates={contributor.scheduledDates} />
          </span>
          <span className="rounded-full border border-rule px-2.5 py-1 text-xs font-bold text-muted">
            Review
          </span>
        </span>
      </summary>

      <Form className="mt-5 grid gap-5 border-t border-rule pt-5" method="post">
        <HiddenDecisionFields canonicalIngredientId={mismatch.canonicalIngredientId} weekStart={weekStart} />
        <input name="intent" type="hidden" value="edit-saved-recipe" />
        <input name="recipeId" type="hidden" value={contributor.recipeId} />
        <input name="recipeIngredientId" type="hidden" value={contributor.recipeIngredientId} />
        <input name="expectedRecipeUpdatedAt" type="hidden" value={contributor.recipeUpdatedAt.toISOString()} />

        <div className="grid gap-3 rounded-xl border border-butter bg-butter/15 p-4 sm:grid-cols-2">
          <div>
            <span className="block text-[0.67rem] font-bold tracking-[0.12em] text-muted uppercase">Before</span>
            <strong className="mt-1 block text-lg text-ink">{contributor.quantity} {unitLabel(contributor.unit)}</strong>
            <span className="text-xs text-muted">{Number(beforePerServing.toFixed(3))} {unitLabel(contributor.unit)} per serving</span>
          </div>
          <div>
            <span className="block text-[0.67rem] font-bold tracking-[0.12em] text-herb uppercase">After</span>
            {risky ? (
              <p className="mt-1 mb-0 text-sm leading-5 text-clay">No automatic reduction. Choose an amount only after reviewing how this ingredient behaves.</p>
            ) : (
              <>
                <strong className="mt-1 block text-lg text-ink">{suggestion} {unitLabel(contributor.unit)}</strong>
                <span className="text-xs text-muted">{Number((afterPerServing ?? 0).toFixed(3))} {unitLabel(contributor.unit)} per serving</span>
              </>
            )}
          </div>
        </div>

        {risky ? (
          <div className="flex gap-3 rounded-xl border border-clay/35 bg-clay/10 p-4 text-sm leading-6 text-ink">
            <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0 text-clay" size={19} />
            <p className="m-0"><strong>Manual culinary decision required.</strong> Protein portions, non-linear ingredients, and method-sensitive amounts are never reduced automatically.</p>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
          <Field htmlFor={`recipe-quantity-${fieldKey}`} label="New saved-recipe amount">
            <input defaultValue={defaultQuantity} id={`recipe-quantity-${fieldKey}`} min="0.001" name="quantity" required step="any" type="number" />
          </Field>
          <Field htmlFor={`recipe-unit-${fieldKey}`} label="Measurement">
            <select defaultValue={contributor.unit} id={`recipe-unit-${fieldKey}`} name="unit">
              {mismatch.compatibleUnits.map((unit) => <option key={unit} value={unit}>{unitLabels[unit]}</option>)}
            </select>
          </Field>
        </div>

        <Field help="One instruction per line. Rewrite every step that mentions the old quantity, count, timing, or portion." htmlFor={`instructions-${fieldKey}`} label="All method instructions">
          <textarea defaultValue={contributor.instructions.map((step) => step.instruction).join("\n")} id={`instructions-${fieldKey}`} name="instructions" required rows={Math.max(7, contributor.instructions.length + 2)} />
        </Field>

        <label className="flex items-start gap-3 rounded-xl border border-clay/30 bg-clay/5 p-4 text-sm leading-6 text-ink">
          <input className="mt-1 size-4 shrink-0" name="acknowledgedPermanentChange" required type="checkbox" value="true" />
          <span><strong>This changes this recipe everywhere it is used, including other weeks and previously planned weeks.</strong> I reviewed servings, portions, and every method reference, not just this week’s shopping list.</span>
        </label>

        <SubmitButton pendingLabel="Updating saved recipe" pendingMatch={{ intent: "edit-saved-recipe", recipeId: contributor.recipeId }}>
          <PencilLine aria-hidden="true" size={17} />
          Update saved recipe
        </SubmitButton>
      </Form>
    </details>
  );
}

function PackageMismatchCard({
  mismatch,
  weekStart,
}: Readonly<{ mismatch: PantryPackageFitMismatch; weekStart: string }>) {
  const packageLabel = mismatch.defaultPurchaseDescription ?? "usual store package";
  const customChoice =
    mismatch.choice?.kind === "custom_store_amount" ? mismatch.choice : null;
  const resolved = mismatch.choice !== null;
  const alternateDefaultUnit =
    customChoice?.customUnit &&
    mismatch.compatibleUnits.includes(
      customChoice.customUnit as UsRecipeMeasurementUnit,
    )
      ? (customChoice.customUnit as UsRecipeMeasurementUnit)
      : mismatch.compatibleUnits[0];

  return (
    <article className="surface overflow-hidden">
      <header className="grid gap-4 border-b border-rule bg-paper-light p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:p-6">
        <div>
          <p className="eyebrow">Package decision</p>
          <h2 className="mt-1 mb-2 text-3xl leading-none text-ink">{mismatch.ingredientName}</h2>
          <p className="m-0 max-w-2xl text-sm leading-6 text-muted">
            The recipes and the store package do not line up cleanly. Pick the tradeoff before this ingredient reaches the final list.
          </p>
        </div>
        <span className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold ${resolved ? "border-herb/30 bg-herb/10 text-herb" : "border-clay/30 bg-clay/10 text-clay"}`}>
          {resolved ? <Check aria-hidden="true" size={14} /> : <CircleDot aria-hidden="true" size={14} />}
          {resolved ? "Decision saved" : "Needs a choice"}
        </span>
      </header>

      {customChoice ? (
        <div className="flex items-start gap-3 border-b border-herb/25 bg-herb/10 px-5 py-4 text-sm leading-6 text-ink sm:px-6">
          <Check aria-hidden="true" className="mt-0.5 shrink-0 text-herb" size={18} />
          <p className="m-0">
            <strong>Resolved as a different store amount:</strong>{" "}
            {formatAlternateStoreChoice(customChoice, packageLabel)}
          </p>
        </div>
      ) : mismatch.choice?.kind === "keep_recipe_buy_enough" ? (
        <div className="flex items-start gap-3 border-b border-herb/25 bg-herb/10 px-5 py-4 text-sm leading-6 text-ink sm:px-6">
          <Check aria-hidden="true" className="mt-0.5 shrink-0 text-herb" size={18} />
          <p className="m-0"><strong>Resolved by keeping the recipe:</strong> buy {mismatch.packageCount} × {packageLabel}.</p>
        </div>
      ) : null}

      <div className="grid divide-y divide-rule sm:grid-cols-3 sm:divide-x sm:divide-y-0 lg:grid-cols-6">
        {[
          ["On hand", mismatch.currentQuantityInBaseUnit === null ? "Not counted" : formatBaseQuantity(mismatch.currentQuantityInBaseUnit, mismatch.baseUnit)],
          ["Recipes need", formatBaseQuantity(mismatch.requiredQuantityInBaseUnit, mismatch.baseUnit)],
          ["Gap to cover", formatBaseQuantity(mismatch.neededQuantityInBaseUnit, mismatch.baseUnit)],
          ["Package size", packageLabel],
          ["Projected purchase", `${mismatch.packageCount} packages · ${formatBaseQuantity(mismatch.projectedQuantityInBaseUnit, mismatch.baseUnit)}`],
          ["Extra after week", formatBaseQuantity(mismatch.surplusQuantityInBaseUnit, mismatch.baseUnit)],
        ].map(([label, value]) => (
          <div className="p-4 sm:p-5" key={label}>
            <span className="block text-[0.65rem] font-bold tracking-[0.12em] text-muted uppercase">{label}</span>
            <strong className="mt-1 block text-sm leading-5 text-ink">{value}</strong>
          </div>
        ))}
      </div>

      <div className="grid gap-3 border-t border-rule p-4 sm:p-6">
        <details className="rounded-2xl border border-rule bg-paper-light p-4 open:border-herb/40 sm:p-5">
          <summary className="cursor-pointer list-none">
            <span className="flex items-center gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-herb text-paper-light"><PencilLine aria-hidden="true" size={18} /></span>
              <span><strong className="block text-ink">Adjust a saved recipe permanently</strong><span className="text-sm text-muted">Change every plan that uses this saved recipe, including previously planned weeks.</span></span>
            </span>
          </summary>
          <div className="mt-5 grid gap-3 border-t border-rule pt-5">
            <p className="m-0 text-sm leading-6 text-muted">Choose one contributing recipe to inspect. Recipe edits are handled one at a time so each method stays intentional.</p>
            {mismatch.contributors.map((contributor) => (
              <PermanentRecipeChoice contributor={contributor} key={`${contributor.recipeIngredientId}:${contributor.planEntryId}`} mismatch={mismatch} weekStart={weekStart} />
            ))}
          </div>
        </details>

        <details className="rounded-2xl border border-rule bg-paper-light p-4 open:border-herb/40 sm:p-5">
          <summary className="cursor-pointer list-none">
            <span className="flex items-center gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-butter text-ink"><PackageCheck aria-hidden="true" size={19} /></span>
              <span><strong className="block text-ink">Keep the recipe and buy enough</strong><span className="text-sm text-muted">Buy {mismatch.packageCount} × {packageLabel}; plan for {formatBaseQuantity(mismatch.surplusQuantityInBaseUnit, mismatch.baseUnit)} left.</span></span>
            </span>
          </summary>
          <Form className="mt-5 border-t border-rule pt-5" method="post">
            <HiddenDecisionFields canonicalIngredientId={mismatch.canonicalIngredientId} weekStart={weekStart} />
            <input name="intent" type="hidden" value="keep-recipe" />
            <p className="mt-0 text-sm leading-6 text-muted">This preserves every serving and method step. The whole-package amount becomes the shopping and pantry-return default.</p>
            <SubmitButton pendingLabel="Keeping recipe" pendingMatch={{ canonicalIngredientId: mismatch.canonicalIngredientId, intent: "keep-recipe" }}>
              <Check aria-hidden="true" size={17} />
              Keep recipe and package plan
            </SubmitButton>
          </Form>
        </details>

        <details className="rounded-2xl border border-rule bg-paper-light p-4 open:border-herb/40 sm:p-5">
          <summary className="cursor-pointer list-none">
            <span className="flex items-center gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-clay text-paper-light"><Scale aria-hidden="true" size={19} /></span>
              <span><strong className="block text-ink">Use a different store amount</strong><span className="text-sm text-muted">For loose produce, butcher-counter amounts, or a package you found in store.</span></span>
            </span>
          </summary>
          <Form className="mt-5 grid gap-4 border-t border-rule pt-5" method="post">
            <HiddenDecisionFields canonicalIngredientId={mismatch.canonicalIngredientId} weekStart={weekStart} />
            <input name="intent" type="hidden" value="alternate-store" />
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
              <Field htmlFor={`alternate-quantity-${mismatch.canonicalIngredientId}`} label="Amount you plan to buy">
                <input defaultValue={customChoice?.customQuantity ?? undefined} id={`alternate-quantity-${mismatch.canonicalIngredientId}`} min="0.001" name="quantity" required step="any" type="number" />
              </Field>
              <Field htmlFor={`alternate-unit-${mismatch.canonicalIngredientId}`} label="Measurement">
                <select defaultValue={alternateDefaultUnit} id={`alternate-unit-${mismatch.canonicalIngredientId}`} name="unit">
                  {mismatch.compatibleUnits.map((unit) => <option key={unit} value={unit}>{unitLabels[unit]}</option>)}
                </select>
              </Field>
            </div>
            <Field help='Optional. Example: "2 large lemons" or "one 20 oz family pack".' htmlFor={`shopping-label-${mismatch.canonicalIngredientId}`} label="Short shopping-list label">
              <input defaultValue={customChoice?.customLabel ?? undefined} id={`shopping-label-${mismatch.canonicalIngredientId}`} maxLength={120} name="shoppingLabel" placeholder="What you will recognize in the store" type="text" />
            </Field>
            {mismatch.compatibleUnits.includes("count") && mismatch.baseUnit !== "count" ? (
              <p className="m-0 flex gap-2 rounded-xl border border-butter bg-butter/15 p-3 text-xs leading-5 text-ink">
                <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={15} />
                A count uses the catalog’s average weight per item. Size varies, so your pantry can be corrected to the actual amount after shopping.
              </p>
            ) : null}
            <SubmitButton pendingLabel="Saving store amount" pendingMatch={{ canonicalIngredientId: mismatch.canonicalIngredientId, intent: "alternate-store" }}>
              <ShoppingBasket aria-hidden="true" size={17} />
              Use this store amount
            </SubmitButton>
          </Form>
        </details>
      </div>
    </article>
  );
}

function weekLabel(weekStart: string): string {
  const weekEnd = parseDateOnly(weekStart).add({ days: 6 }).toString();
  return `${formatDateLabel(weekStart, { month: "short", day: "numeric" })} to ${formatDateLabel(weekEnd, { month: "short", day: "numeric", year: "numeric" })}`;
}

export default function PantryPackageFit({ loaderData }: Route.ComponentProps) {
  const unresolvedCount = loaderData.mismatches.filter(
    (mismatch) => mismatch.choice === null,
  ).length;

  return (
    <main className="mx-auto max-w-5xl">
      <PageHeader
        actions={<Link className="button button-secondary" to={`/pantry?week=${loaderData.weekStart}`}><ArrowLeft aria-hidden="true" size={17} />Pantry</Link>}
        description="Decide whether the recipe or the purchase should bend before the shopping list is finalized. Nothing changes until you choose a path."
        eyebrow={weekLabel(loaderData.weekStart)}
        title="Make the package fit the plan."
      />

      <div
        aria-live="polite"
        className="scroll-mt-24"
        id={PACKAGE_FIT_RESULT_ANCHOR}
        tabIndex={-1}
      >
        {loaderData.message ? (
          <div className="mb-5 flex items-start gap-3 rounded-2xl border border-herb/30 bg-herb/10 p-4 text-sm text-ink" role="status"><Check aria-hidden="true" className="mt-0.5 shrink-0 text-herb" size={18} /><p className="m-0">{loaderData.message}</p></div>
        ) : null}
        <FormError>{loaderData.error}</FormError>
      </div>

      {loaderData.mismatches.length === 0 ? (
        <section className="surface grid place-items-center px-6 py-14 text-center">
          <span className="grid size-14 place-items-center rounded-full bg-herb text-paper-light"><CookingPot aria-hidden="true" size={25} /></span>
          <p className="eyebrow mt-5">Shopping list ready</p>
          <h2 className="mt-1 mb-2 text-3xl text-ink">Every package has a decision.</h2>
          <p className="m-0 max-w-xl text-sm leading-6 text-muted">There are no unresolved package mismatches for this week.</p>
          <Link className="button button-primary mt-6" to={`/pantry?week=${loaderData.weekStart}`}><ShoppingBasket aria-hidden="true" size={17} />Return to shopping list</Link>
        </section>
      ) : (
        <>
          <aside className={`mb-5 grid gap-4 rounded-2xl border p-5 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center ${unresolvedCount === 0 ? "border-herb/30 bg-herb/10" : "border-butter bg-butter/15"}`}>
            <span className={`grid size-11 place-items-center rounded-full border border-ink shadow-[2px_2px_0_#1d2a22] ${unresolvedCount === 0 ? "bg-herb text-paper-light" : "bg-butter"}`}>
              {unresolvedCount === 0 ? <Check aria-hidden="true" size={20} /> : <AlertTriangle aria-hidden="true" size={20} />}
            </span>
            <div><p className="m-0 font-semibold text-ink">{unresolvedCount === 0 ? `All ${loaderData.mismatches.length} package decisions are saved.` : `${unresolvedCount} ${unresolvedCount === 1 ? "ingredient needs" : "ingredients need"} a package decision.`}</p><p className="mt-1 mb-0 text-sm leading-6 text-muted">Permanent recipe edits affect other weeks and previously planned weeks. Protein portions and method-sensitive quantities are never silently reduced.</p></div>
          </aside>
          <div className="grid gap-6">
            {loaderData.mismatches.map((mismatch) => <PackageMismatchCard key={mismatch.canonicalIngredientId} mismatch={mismatch} weekStart={loaderData.weekStart} />)}
          </div>
        </>
      )}
    </main>
  );
}
