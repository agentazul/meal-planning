import {
  ArrowUpRight,
  CalendarDays,
  Clock3,
  PenLine,
  Plus,
  Scale,
  Sparkles,
  UsersRound,
  WandSparkles,
} from "lucide-react";
import { Link } from "react-router";

import type { Route } from "./+types/recipes";
import { PageHeader } from "~/components/page-header";
import { getWeekStartDate, todayInTimezone } from "~/domain/dates";
import {
  requireIdentity,
  requireScopedDatabase,
} from "~/server/context.server";
import { listHouseholdRecipes } from "~/server/data/recipes.server";

const effortLabels = {
  weeknight: "Weeknight",
  weekend: "Weekend",
  project: "Project",
} as const;

export const meta: Route.MetaFunction = () => [
  { title: "Recipes | Done For You Kitchen" },
  {
    name: "description",
    content: "Browse the household recipe library.",
  },
];

export async function loader({ context }: Route.LoaderArgs) {
  const identity = requireIdentity(context);
  return {
    recipes: await listHouseholdRecipes(requireScopedDatabase(context)),
    weekStart: getWeekStartDate(todayInTimezone(identity.householdTimezone)),
  };
}

export default function Recipes({ loaderData }: Route.ComponentProps) {
  const { recipes, weekStart } = loaderData;

  return (
    <div>
      <PageHeader
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              className="button button-primary"
              to={`/plans/${weekStart}/generate`}
            >
              <Sparkles aria-hidden="true" size={18} />
              Plan a week with AI
            </Link>
            <Link className="button button-secondary" to="/recipes/generate">
              <WandSparkles aria-hidden="true" size={17} />
              Custom AI recipe
            </Link>
            <Link className="button button-quiet" to="/recipes/new">
              <PenLine aria-hidden="true" size={17} />
              Enter manually
            </Link>
          </div>
        }
        description="A working shelf of dinners your household can actually cook, portion, and reuse in future plans."
        eyebrow={`${recipes.length} ${recipes.length === 1 ? "recipe" : "recipes"}`}
        title="Recipes that earn their place."
      />

      {recipes.length === 0 ? (
        <section className="empty-state">
          <div>
            <span
              className="mx-auto grid size-14 place-items-center rounded-full border border-ink bg-butter shadow-[4px_4px_0_#1d2a22]"
              aria-hidden="true"
            >
              <CalendarDays size={25} />
            </span>
            <h2 className="mt-5">Start with the whole week.</h2>
            <p>
              Let AI propose five dinners using this household's serving needs
              and kitchen preferences. You can review and swap ideas before
              anything is added to the plan.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Link
                className="button button-primary"
                to={`/plans/${weekStart}/generate`}
              >
                <Sparkles aria-hidden="true" size={18} />
                Generate five dinners
              </Link>
              <Link className="button button-secondary" to="/recipes/generate">
                <WandSparkles aria-hidden="true" size={17} />
                Create one custom recipe
              </Link>
              <Link className="button button-quiet" to="/recipes/new">
                <Plus aria-hidden="true" size={18} />
                Enter manually
              </Link>
            </div>
          </div>
        </section>
      ) : (
        <ul className="m-0 grid list-none gap-4 p-0 sm:grid-cols-2 xl:grid-cols-3">
          {recipes.map((recipe, index) => (
            <li className="min-w-0" key={recipe.id}>
              <Link
                className="group relative flex h-full min-h-64 flex-col overflow-hidden rounded-[1.4rem_1.4rem_1.4rem_0.3rem] border border-rule bg-paper-light p-5 no-underline shadow-[0_0.7rem_2rem_rgba(29,42,34,0.07)] transition duration-200 hover:-translate-y-1 hover:border-herb hover:shadow-[0_1rem_2.5rem_rgba(29,42,34,0.13)] sm:p-6"
                to={`/recipes/${recipe.id}`}
              >
                <div className="mb-8 flex items-start justify-between gap-3">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-semibold tracking-[0.16em] text-clay">
                      RECIPE {String(index + 1).padStart(2, "0")}
                    </span>
                    {recipe.source === "generated" ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-butter bg-butter/20 px-2 py-1 text-[0.62rem] font-bold tracking-[0.08em] text-ink uppercase">
                        <Sparkles aria-hidden="true" size={11} />
                        AI generated
                      </span>
                    ) : null}
                  </span>
                  <span className="grid size-9 shrink-0 place-items-center rounded-full border border-rule bg-white text-herb transition group-hover:border-herb group-hover:bg-herb group-hover:text-paper-light">
                    <ArrowUpRight aria-hidden="true" size={17} />
                  </span>
                </div>

                <div className="flex-1">
                  <p className="mb-2 text-[0.68rem] font-bold tracking-[0.14em] text-herb uppercase">
                    {effortLabels[recipe.effortTier]}
                    {recipe.cuisine ? ` · ${recipe.cuisine}` : ""}
                  </p>
                  <h2 className="m-0 text-[1.65rem] leading-[1.08] text-ink transition group-hover:text-herb-dark">
                    {recipe.title}
                  </h2>
                </div>

                <div className="mt-7 grid grid-cols-3 divide-x divide-rule border-t border-rule pt-4 text-xs text-muted">
                  <span className="flex min-w-0 flex-col gap-1 pr-2">
                    <Clock3 aria-hidden="true" size={15} />
                    <strong className="truncate font-semibold text-ink">
                      {recipe.totalTimeMinutes} min
                    </strong>
                    <span className="truncate">total</span>
                  </span>
                  <span className="flex min-w-0 flex-col gap-1 px-3">
                    <UsersRound aria-hidden="true" size={15} />
                    <strong className="truncate font-semibold text-ink">
                      {recipe.baseServings}
                    </strong>
                    <span className="truncate">servings</span>
                  </span>
                  <span className="flex min-w-0 flex-col gap-1 pl-3">
                    <Scale aria-hidden="true" size={15} />
                    <strong className="truncate font-semibold text-ink">
                      {recipe.ingredientCount}
                    </strong>
                    <span className="truncate">ingredients</span>
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
