import {
  AlertTriangle,
  Check,
  Clock3,
  CookingPot,
  Flame,
  Save,
  Scale,
  ShieldCheck,
  Sparkles,
  UsersRound,
} from "lucide-react";
import { Form } from "react-router";

import { SubmitButton } from "~/components/form-controls";
import {
  formatRecipeTextForUsKitchen,
  formatUsRecipeQuantity,
} from "~/domain/us-kitchen-display";

export type GeneratedRecipeReviewIngredient = Readonly<{
  baseUnit: "g" | "ml" | "count";
  canonicalIngredientId: string;
  isOptional: boolean;
  name: string;
  preparation: string | null;
  quantity: number;
  quantityInBaseUnit: number;
  scalesLinearly: boolean;
  unit: string;
}>;

export type GeneratedRecipeReview = Readonly<{
  activeTimeMinutes: number;
  baseServings: number;
  cuisine: string | null;
  description: string | null;
  effortTier: "weeknight" | "weekend" | "project";
  ingredients: readonly GeneratedRecipeReviewIngredient[];
  instructions: readonly Readonly<{
    instruction: string;
    position: number;
  }>[];
  minInternalTemperatureF: number | null;
  primaryProtein: string | null;
  techniques: readonly string[];
  title: string;
  totalTimeMinutes: number;
}>;

const effortLabels = {
  weeknight: "Weeknight",
  weekend: "Weekend",
  project: "Project",
} as const;

function Metric({
  icon,
  label,
  value,
}: Readonly<{
  icon: React.ReactNode;
  label: string;
  value: string;
}>) {
  return (
    <div className="flex min-w-0 items-center gap-3 border-r border-rule px-3 py-3 last:border-r-0 sm:px-4">
      <span className="shrink-0 text-herb" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[0.64rem] font-bold tracking-[0.12em] text-muted uppercase">
          {label}
        </span>
        <strong className="block truncate text-sm text-ink">{value}</strong>
      </span>
    </div>
  );
}

export function GeneratedRecipeReview({
  draft,
  envelope,
  signature,
}: Readonly<{
  draft: GeneratedRecipeReview;
  envelope: string;
  signature: string;
}>) {
  return (
    <section aria-labelledby="generated-recipe-title" className="grid gap-5">
      <div className="surface overflow-hidden border-herb/40">
        <header className="relative overflow-hidden border-b border-herb-dark bg-herb px-5 py-6 text-paper-light sm:px-7">
          <div
            aria-hidden="true"
            className="absolute -top-12 -right-8 size-40 rounded-full border border-paper-light/10 bg-paper-light/5"
          />
          <div className="relative flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl">
              <p className="mb-2 flex items-center gap-2 text-[0.68rem] font-bold tracking-[0.14em] text-butter uppercase">
                <Sparkles aria-hidden="true" size={15} />
                AI review draft
              </p>
              <h2
                className="m-0 text-3xl leading-tight text-paper-light sm:text-4xl"
                id="generated-recipe-title"
              >
                {draft.title}
              </h2>
              {draft.description ? (
                <p className="mt-3 mb-0 max-w-2xl text-sm leading-6 text-paper-light/80">
                  {formatRecipeTextForUsKitchen(draft.description)}
                </p>
              ) : null}
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-butter/60 bg-butter/15 px-3 py-1.5 text-xs font-semibold text-butter">
              <Check aria-hidden="true" size={14} />
              Passed structure checks
            </span>
          </div>
        </header>

        <div className="grid grid-cols-2 divide-y divide-rule bg-paper-light sm:grid-cols-4 sm:divide-y-0">
          <Metric
            icon={<Clock3 size={18} />}
            label="Active"
            value={`${draft.activeTimeMinutes} min`}
          />
          <Metric
            icon={<CookingPot size={18} />}
            label="Total"
            value={`${draft.totalTimeMinutes} min`}
          />
          <Metric
            icon={<UsersRound size={18} />}
            label="Makes"
            value={`${draft.baseServings} servings`}
          />
          <Metric
            icon={<Scale size={18} />}
            label="Ingredients"
            value={String(draft.ingredients.length)}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2" aria-label="Draft recipe tags">
        <span className="rounded-full border border-herb/25 bg-herb/10 px-3 py-1.5 text-xs font-semibold text-herb-dark">
          {effortLabels[draft.effortTier]}
        </span>
        {draft.cuisine ? (
          <span className="rounded-full border border-clay/25 bg-clay/10 px-3 py-1.5 text-xs font-semibold text-clay">
            {draft.cuisine}
          </span>
        ) : null}
        {draft.primaryProtein ? (
          <span className="rounded-full border border-rule bg-paper-light px-3 py-1.5 text-xs font-semibold text-ink">
            {draft.primaryProtein}
          </span>
        ) : null}
        {draft.techniques.map((technique) => (
          <span
            className="rounded-full border border-rule bg-paper-light px-3 py-1.5 text-xs font-semibold text-muted"
            key={technique}
          >
            {technique}
          </span>
        ))}
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(18rem,0.85fr)_minmax(0,1.3fr)]">
        <section className="surface overflow-hidden lg:sticky lg:top-24">
          <header className="border-b border-rule bg-butter/25 px-5 py-4 sm:px-6">
            <p className="m-0 text-[0.66rem] font-bold tracking-[0.14em] text-clay uppercase">
              Canonical catalog
            </p>
            <h3 className="mt-1 mb-0 text-2xl text-ink">Ingredients</h3>
          </header>
          <ul className="m-0 divide-y divide-rule p-0">
            {draft.ingredients.map((ingredient) => (
              <li
                className="grid gap-1 px-5 py-4 sm:px-6"
                key={ingredient.canonicalIngredientId}
              >
                <div className="flex items-start justify-between gap-4">
                  <span className="font-semibold text-ink">
                    {ingredient.name}
                    {ingredient.preparation ? (
                      <span className="font-normal text-muted">
                        {`, ${formatRecipeTextForUsKitchen(ingredient.preparation)}`}
                      </span>
                    ) : null}
                  </span>
                  <strong className="shrink-0 text-sm text-ink">
                    {formatUsRecipeQuantity({
                      baseUnit: ingredient.baseUnit,
                      quantity: ingredient.quantity,
                      quantityInBaseUnit: ingredient.quantityInBaseUnit,
                      unit: ingredient.unit,
                    })}
                  </strong>
                </div>
                {ingredient.isOptional || !ingredient.scalesLinearly ? (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    {ingredient.isOptional ? (
                      <span className="rounded-full bg-butter/25 px-2 py-0.5 font-semibold text-ink">
                        optional
                      </span>
                    ) : null}
                    {!ingredient.scalesLinearly ? (
                      <span className="rounded-full bg-clay/10 px-2 py-0.5 font-semibold text-clay">
                        scale by taste
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>

        <div className="grid gap-5">
          <section className="surface p-5 sm:p-7">
            <div className="mb-6 flex items-center gap-3 border-b border-rule pb-4">
              <span className="grid size-10 place-items-center rounded-full border border-ink bg-butter shadow-[2px_2px_0_#1d2a22]">
                <CookingPot aria-hidden="true" size={19} />
              </span>
              <div>
                <p className="m-0 text-[0.66rem] font-bold tracking-[0.14em] text-clay uppercase">
                  Cook in order
                </p>
                <h3 className="mt-1 mb-0 text-2xl leading-none">Method</h3>
              </div>
            </div>
            <ol className="m-0 grid list-none gap-6 p-0">
              {draft.instructions.map((step) => (
                <li
                  className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-3"
                  key={`${step.position}-${step.instruction}`}
                >
                  <span className="grid size-9 place-items-center rounded-full bg-ink font-mono text-xs font-bold text-paper-light">
                    {String(step.position).padStart(2, "0")}
                  </span>
                  <p className="m-0 pt-1 text-[0.98rem] leading-7 text-ink">
                    {formatRecipeTextForUsKitchen(step.instruction)}
                  </p>
                </li>
              ))}
            </ol>
          </section>

          {draft.minInternalTemperatureF ? (
            <section className="surface flex items-start gap-4 border-clay/35 bg-[#fff7f3] p-5 sm:p-6">
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-clay text-paper-light">
                <Flame aria-hidden="true" size={19} />
              </span>
              <div>
                <p className="m-0 text-[0.66rem] font-bold tracking-[0.14em] text-clay uppercase">
                  Food safety
                </p>
                <h3 className="mt-1 mb-1 text-xl">Check the center</h3>
                <p className="m-0 text-sm leading-6 text-muted">
                  Cook the primary protein to at least{" "}
                  <strong className="text-ink">
                    {draft.minInternalTemperatureF}°F
                  </strong>
                  . Confirm with a food thermometer.
                </p>
              </div>
            </section>
          ) : null}
        </div>
      </div>

      <section className="surface grid gap-5 border-butter bg-butter/10 p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-6">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-clay">
            <AlertTriangle aria-hidden="true" size={20} />
          </span>
          <div>
            <h3 className="m-0 text-lg">Your review is the final check.</h3>
            <p className="mt-1 mb-0 max-w-2xl text-sm leading-6 text-muted">
              AI can make mistakes. Check quantities, method, allergy needs, and
              food safety before adding this recipe to the household library.
            </p>
          </div>
        </div>
        <Form className="flex flex-wrap gap-2" method="post">
          <input name="_intent" type="hidden" value="save" />
          <input name="draftEnvelope" type="hidden" value={envelope} />
          <input name="draftSignature" type="hidden" value={signature} />
          <a className="button button-secondary" href="#recipe-generator">
            Change request
          </a>
          <SubmitButton
            pendingLabel="Saving recipe"
            pendingMatch={{ _intent: "save" }}
          >
            <Save aria-hidden="true" size={17} />
            Save to recipes
          </SubmitButton>
        </Form>
      </section>

      <p className="m-0 flex items-center justify-center gap-2 text-center text-xs leading-5 text-muted">
        <ShieldCheck aria-hidden="true" size={15} />
        The model response is structured and checked, but it is not an allergy
        or food-safety guarantee.
      </p>
    </section>
  );
}
