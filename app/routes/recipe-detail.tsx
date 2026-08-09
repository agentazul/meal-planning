import {
  ArrowLeft,
  Clock3,
  CookingPot,
  Flame,
  Scale,
  ShieldCheck,
  Sparkles,
  UsersRound,
} from "lucide-react";
import { Link } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/recipe-detail";
import { PageHeader } from "~/components/page-header";
import { requireScopedDatabase } from "~/server/context.server";
import { getHouseholdRecipe } from "~/server/data/recipes.server";

const recipeIdSchema = z.uuid();
const recipeStepsSchema = z.array(
  z
    .object({
      instruction: z.string().trim().min(1),
      position: z.number().int().positive(),
    })
    .strict(),
).min(1);

const quantityFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 3,
});

const effortLabels = {
  weeknight: "Weeknight",
  weekend: "Weekend",
  project: "Project",
} as const;

export const meta: Route.MetaFunction = () => [
  { title: "Recipe | Done For You Kitchen" },
  {
    name: "description",
    content: "Review recipe ingredients, instructions, and food safety notes.",
  },
];

export async function loader({ context, params }: Route.LoaderArgs) {
  const parsedId = recipeIdSchema.safeParse(params.recipeId);
  if (!parsedId.success) {
    throw new Response("Recipe not found.", {
      status: 404,
      statusText: "Recipe not found",
    });
  }

  const recipe = await getHouseholdRecipe(
    requireScopedDatabase(context),
    parsedId.data,
  );

  if (!recipe) {
    throw new Response("Recipe not found.", {
      status: 404,
      statusText: "Recipe not found",
    });
  }

  const parsedSteps = recipeStepsSchema.safeParse(recipe.instructions);
  if (!parsedSteps.success) {
    throw new Response("Recipe instructions are malformed.", {
      status: 500,
      statusText: "Invalid recipe instructions",
    });
  }

  return {
    recipe: {
      ...recipe,
      instructions: parsedSteps.data.sort(
        (left, right) => left.position - right.position,
      ),
    },
  };
}

function displayUnit(unit: string): string {
  return unit === "fl_oz" ? "fl oz" : unit;
}

export default function RecipeDetail({ loaderData }: Route.ComponentProps) {
  const { recipe } = loaderData;

  return (
    <article className="mx-auto max-w-6xl">
      <PageHeader
        actions={
          <Link className="button button-secondary" to="/recipes">
            <ArrowLeft aria-hidden="true" size={17} />
            Recipe library
          </Link>
        }
        description={recipe.description ?? undefined}
        eyebrow={
          recipe.source === "generated"
            ? `AI generated • ${effortLabels[recipe.effortTier]} recipe`
            : `${effortLabels[recipe.effortTier]} recipe`
        }
        title={recipe.title}
      />

      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="surface flex min-w-0 items-center gap-3 p-3 sm:p-4">
          <Clock3 aria-hidden="true" className="shrink-0 text-herb" size={19} />
          <span className="min-w-0">
            <span className="block text-[0.67rem] font-bold tracking-[0.12em] text-muted uppercase">
              Active
            </span>
            <strong className="block truncate text-sm text-ink">
              {recipe.activeTimeMinutes} min
            </strong>
          </span>
        </div>
        <div className="surface flex min-w-0 items-center gap-3 p-3 sm:p-4">
          <CookingPot
            aria-hidden="true"
            className="shrink-0 text-herb"
            size={19}
          />
          <span className="min-w-0">
            <span className="block text-[0.67rem] font-bold tracking-[0.12em] text-muted uppercase">
              Total
            </span>
            <strong className="block truncate text-sm text-ink">
              {recipe.totalTimeMinutes} min
            </strong>
          </span>
        </div>
        <div className="surface flex min-w-0 items-center gap-3 p-3 sm:p-4">
          <UsersRound
            aria-hidden="true"
            className="shrink-0 text-herb"
            size={19}
          />
          <span className="min-w-0">
            <span className="block text-[0.67rem] font-bold tracking-[0.12em] text-muted uppercase">
              Makes
            </span>
            <strong className="block truncate text-sm text-ink">
              {recipe.baseServings} servings
            </strong>
          </span>
        </div>
        <div className="surface flex min-w-0 items-center gap-3 p-3 sm:p-4">
          <Scale aria-hidden="true" className="shrink-0 text-herb" size={19} />
          <span className="min-w-0">
            <span className="block text-[0.67rem] font-bold tracking-[0.12em] text-muted uppercase">
              Ingredients
            </span>
            <strong className="block truncate text-sm text-ink">
              {recipe.ingredients.length}
            </strong>
          </span>
        </div>
      </div>

      {recipe.source === "generated" ||
      recipe.cuisine ||
      recipe.primaryProtein ||
      recipe.techniques.length > 0 ? (
        <div className="mb-5 flex flex-wrap gap-2" aria-label="Recipe tags">
          {recipe.source === "generated" ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-butter bg-butter/20 px-3 py-1.5 text-xs font-semibold text-ink">
              <Sparkles aria-hidden="true" size={13} />
              Generated with AI
            </span>
          ) : null}
          {recipe.cuisine ? (
            <span className="rounded-full border border-herb/25 bg-herb/10 px-3 py-1.5 text-xs font-semibold text-herb-dark">
              {recipe.cuisine}
            </span>
          ) : null}
          {recipe.primaryProtein ? (
            <span className="rounded-full border border-clay/25 bg-clay/10 px-3 py-1.5 text-xs font-semibold text-clay">
              {recipe.primaryProtein}
            </span>
          ) : null}
          {recipe.techniques.map((technique) => (
            <span
              className="rounded-full border border-rule bg-paper-light px-3 py-1.5 text-xs font-semibold text-muted"
              key={technique}
            >
              {technique}
            </span>
          ))}
        </div>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(18rem,0.8fr)_minmax(0,1.35fr)]">
        <section className="surface overflow-hidden lg:sticky lg:top-24">
          <header className="border-b border-rule bg-herb px-5 py-5 text-paper-light sm:px-6">
            <p className="m-0 text-[0.68rem] font-bold tracking-[0.14em] text-butter uppercase">
              Mise en place
            </p>
            <h2 className="mt-1 mb-0 text-3xl text-paper-light">Ingredients</h2>
          </header>

          <ul className="m-0 divide-y divide-rule p-0">
            {recipe.ingredients.map((ingredient) => (
              <li className="grid gap-1 px-5 py-4 sm:px-6" key={ingredient.id}>
                <div className="flex items-start justify-between gap-4">
                  <span className="font-semibold text-ink">
                    {ingredient.name}
                    {ingredient.preparation ? (
                      <span className="font-normal text-muted">
                        {`, ${ingredient.preparation}`}
                      </span>
                    ) : null}
                  </span>
                  <strong className="shrink-0 text-sm text-ink">
                    {quantityFormatter.format(ingredient.quantity)}{" "}
                    {displayUnit(ingredient.unit)}
                  </strong>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  <span>
                    {quantityFormatter.format(ingredient.quantityInBaseUnit)}{" "}
                    {ingredient.baseUnit} base
                  </span>
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
              </li>
            ))}
          </ul>
        </section>

        <div className="grid gap-5">
          <section className="surface overflow-hidden p-5 sm:p-7">
            <div className="mb-6 flex items-center gap-3 border-b border-rule pb-4">
              <span className="grid size-10 place-items-center rounded-full border border-ink bg-butter shadow-[2px_2px_0_#1d2a22]">
                <CookingPot aria-hidden="true" size={19} />
              </span>
              <div>
                <p className="m-0 text-[0.68rem] font-bold tracking-[0.14em] text-clay uppercase">
                  Cook in order
                </p>
                <h2 className="mt-1 mb-0 text-3xl leading-none">Method</h2>
              </div>
            </div>

            <ol className="m-0 grid list-none gap-6 p-0">
              {recipe.instructions.map((step) => (
                <li
                  className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-3"
                  key={`${step.position}-${step.instruction}`}
                >
                  <span className="grid size-9 place-items-center rounded-full bg-ink font-mono text-xs font-bold text-paper-light">
                    {String(step.position).padStart(2, "0")}
                  </span>
                  <p className="m-0 pt-1 text-[0.98rem] leading-7 text-ink">
                    {step.instruction}
                  </p>
                </li>
              ))}
            </ol>
          </section>

          {recipe.minInternalTemperatureF !== null ? (
            <aside className="flex items-start gap-4 rounded-2xl border border-clay/35 bg-clay/10 p-5 sm:p-6">
              <span className="grid size-11 shrink-0 place-items-center rounded-full bg-clay text-paper-light">
                <ShieldCheck aria-hidden="true" size={21} />
              </span>
              <div>
                <p className="m-0 text-[0.68rem] font-bold tracking-[0.14em] text-clay uppercase">
                  Food safety
                </p>
                <h2 className="mt-1 mb-1 text-2xl leading-none text-ink">
                  Cook to {recipe.minInternalTemperatureF}°F
                </h2>
                <p className="m-0 flex items-center gap-1.5 text-sm leading-6 text-muted">
                  <Flame aria-hidden="true" size={15} />
                  Check the thickest portion with a clean thermometer.
                </p>
              </div>
            </aside>
          ) : null}
        </div>
      </div>
    </article>
  );
}
