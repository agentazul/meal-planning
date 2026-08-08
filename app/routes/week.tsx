import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
  Users,
  Utensils,
} from "lucide-react";
import { Form, Link } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/week";
import { FormError, SubmitButton } from "~/components/form-controls";
import { PageHeader } from "~/components/page-header";
import {
  formatDateLabel,
  getWeekStartDate,
  parseDateOnly,
  todayInTimezone,
} from "~/domain/dates";
import {
  requireIdentity,
  requireScopedDatabase,
} from "~/server/context.server";
import {
  getWeekPlannerData,
  removePlanEntry,
  scheduleRecipeForDate,
  WeekPlannerError,
} from "~/server/data/week.server";

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

const scheduleActionSchema = z
  .object({
    intent: z.literal("schedule"),
    leftoverBufferServings: z.enum(["0", "1", "2", "3", "4"]).transform(Number),
    recipeId: z.uuid(),
    scheduledDate: dateOnlySchema,
    weekStart: dateOnlySchema,
  })
  .strict();

const removeActionSchema = z
  .object({
    entryId: z.uuid(),
    intent: z.literal("remove"),
    weekStart: dateOnlySchema,
  })
  .strict();

const weekActionSchema = z.discriminatedUnion("intent", [
  scheduleActionSchema,
  removeActionSchema,
]);

const servingNumberFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

export const meta: Route.MetaFunction = () => [
  { title: "Week plan | Kitchen Ledger" },
  {
    name: "description",
    content: "Plan dinners around who is home each night.",
  },
];

export async function loader({ context, request }: Route.LoaderArgs) {
  const identity = requireIdentity(context);
  const scoped = requireScopedDatabase(context);
  const url = new URL(request.url);
  const requestedWeek = url.searchParams.get("week");
  const today = todayInTimezone(identity.householdTimezone);

  const parsedWeek = requestedWeek
    ? dateOnlySchema.safeParse(requestedWeek)
    : null;

  if (parsedWeek && !parsedWeek.success) {
    throw new Response("The week query must be a valid YYYY-MM-DD date.", {
      status: 400,
    });
  }

  const weekStart = getWeekStartDate(parsedWeek?.data ?? today);
  const week = await getWeekPlannerData(scoped, weekStart);
  const start = parseDateOnly(weekStart);

  return {
    ...week,
    nextWeekStart: start.add({ days: 7 }).toString(),
    previousWeekStart: start.subtract({ days: 7 }).toString(),
    today,
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  const parsed = weekActionSchema.safeParse(
    Object.fromEntries(await request.formData()),
  );

  if (!parsed.success) {
    return {
      error: "Check the selected recipe, date, and leftover servings.",
      message: null,
      ok: false as const,
    };
  }

  const scoped = requireScopedDatabase(context);

  try {
    if (parsed.data.intent === "remove") {
      await removePlanEntry(scoped, parsed.data);
      return {
        error: null,
        message: "Dinner removed from the week.",
        ok: true as const,
      };
    }

    const result = await scheduleRecipeForDate(scoped, parsed.data);
    return {
      error: null,
      message: result.replaced
        ? "Dinner replaced and servings refreshed."
        : "Dinner added to the week.",
      ok: true as const,
    };
  } catch (error: unknown) {
    if (error instanceof WeekPlannerError) {
      return {
        error: error.message,
        message: null,
        ok: false as const,
      };
    }

    throw error;
  }
}

function WeekNavigation({
  nextWeekStart,
  previousWeekStart,
  weekStart,
}: Readonly<{
  nextWeekStart: string;
  previousWeekStart: string;
  weekStart: string;
}>) {
  const weekEnd = parseDateOnly(weekStart).add({ days: 6 }).toString();
  const label = `${formatDateLabel(weekStart, {
    month: "short",
    day: "numeric",
  })} to ${formatDateLabel(weekEnd, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;

  return (
    <nav
      aria-label="Week navigation"
      className="flex items-center gap-2 rounded-full border border-rule bg-paper-light p-1"
    >
      <Link
        aria-label="Previous week"
        className="icon-button"
        to={`/?week=${previousWeekStart}`}
      >
        <ChevronLeft aria-hidden="true" size={18} />
      </Link>
      <span className="min-w-36 px-2 text-center text-sm font-bold text-ink">
        {label}
      </span>
      <Link
        aria-label="Next week"
        className="icon-button"
        to={`/?week=${nextWeekStart}`}
      >
        <ChevronRight aria-hidden="true" size={18} />
      </Link>
    </nav>
  );
}

function DinnerProgress({ count }: Readonly<{ count: number }>) {
  const progress = Math.min(count, 5);

  return (
    <section
      aria-labelledby="dinner-progress-title"
      className="surface mb-5 grid gap-4 p-4 sm:grid-cols-[1fr_auto] sm:items-center"
    >
      <div>
        <p className="eyebrow" id="dinner-progress-title">
          Weekly rhythm
        </p>
        <p className="m-0 text-sm leading-6 text-muted">
          Aim for 4 to 5 planned dinners and leave room for leftovers or a night
          out.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <div
          aria-label="Weekly dinner goal"
          aria-valuemax={5}
          aria-valuemin={0}
          aria-valuenow={progress}
          aria-valuetext={`${count} ${count === 1 ? "dinner" : "dinners"} planned; goal is 5`}
          className="flex gap-1"
          role="progressbar"
        >
          {Array.from({ length: 5 }, (_, index) => (
            <span
              className={`h-2.5 w-8 rounded-full ${
                index < progress ? "bg-herb" : "bg-rule"
              }`}
              key={index}
            />
          ))}
        </div>
        <strong className="whitespace-nowrap text-sm">{count} planned</strong>
      </div>
    </section>
  );
}

export default function WeekPlanner({
  actionData,
  loaderData,
}: Route.ComponentProps) {
  return (
    <>
      <PageHeader
        actions={
          <WeekNavigation
            nextWeekStart={loaderData.nextWeekStart}
            previousWeekStart={loaderData.previousWeekStart}
            weekStart={loaderData.weekStart}
          />
        }
        description="Serving counts update from household presence every time this week loads."
        eyebrow="Sunday to Saturday"
        title="Dinner, day by day"
      />

      {actionData?.ok === false ? (
        <div className="mb-4">
          <FormError>{actionData.error}</FormError>
        </div>
      ) : null}
      {actionData?.ok ? (
        <div className="success-note mb-4" role="status">
          <CalendarDays aria-hidden="true" size={18} />
          <span>{actionData.message}</span>
        </div>
      ) : null}

      <DinnerProgress count={loaderData.scheduledDinnerCount} />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 text-sm text-muted">
          Presence is recalculated before the serving target is shown.
        </p>
        <div className="flex gap-2">
          <Link className="button button-quiet" to="/presence">
            <Users aria-hidden="true" size={16} />
            Update presence
          </Link>
          <Link className="button button-quiet" to="/recipes">
            <Utensils aria-hidden="true" size={16} />
            Browse recipes
          </Link>
        </div>
      </div>

      <section aria-label="Seven day dinner plan" className="grid gap-4">
        {loaderData.days.map((day) => {
          const home = day.members.filter((member) => member.isPresent);
          const away = day.members.filter((member) => !member.isPresent);
          const isToday = day.date === loaderData.today;
          const dayName = formatDateLabel(day.date, { weekday: "long" });
          const dateLabel = formatDateLabel(day.date, {
            month: "long",
            day: "numeric",
          });
          const formId = `schedule-${day.date}`;

          return (
            <article className="surface overflow-hidden" key={day.date}>
              <div className="grid gap-5 p-4 md:grid-cols-[minmax(9rem,0.7fr)_minmax(0,1.3fr)_minmax(0,1.2fr)] md:p-5">
                <header>
                  <div className="flex items-center gap-2">
                    <h2 className="m-0 text-2xl leading-none">{dayName}</h2>
                    {isToday ? (
                      <span className="rounded-full bg-butter px-2 py-1 text-xs font-bold uppercase tracking-wide text-ink">
                        Today
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 mb-0 text-sm text-muted">{dateLabel}</p>
                  <div className="mt-4 rounded-xl border border-rule bg-paper p-3">
                    <p className="m-0 text-xs font-bold uppercase tracking-wider text-muted">
                      Dinner target
                    </p>
                    <p className="mt-1 mb-0 flex items-baseline gap-2">
                      <strong className="display-type text-3xl text-herb">
                        {day.servingsTarget}
                      </strong>
                      <span className="text-sm text-muted">servings</span>
                    </p>
                    <p className="mt-1 mb-0 text-xs text-muted">
                      {servingNumberFormat.format(day.demand)} serving
                      equivalents
                      {day.entry?.leftoverBufferServings
                        ? ` plus ${day.entry.leftoverBufferServings} leftover`
                        : ""}
                    </p>
                  </div>
                </header>

                <section aria-label={`Presence for ${dayName}`}>
                  <p className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted">
                    <Users aria-hidden="true" size={15} />
                    Who is home
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {home.length > 0 ? (
                      home.map((member) => (
                        <span
                          className="rounded-full border border-herb/25 bg-herb/10 px-3 py-1.5 text-sm font-semibold text-herb-dark"
                          key={member.id}
                        >
                          {member.displayName}
                          <span className="ml-1 text-xs font-normal text-muted">
                            <span className="sr-only">
                              , appetite multiplier{" "}
                            </span>
                            {servingNumberFormat.format(
                              member.appetiteMultiplier,
                            )}
                          </span>
                        </span>
                      ))
                    ) : (
                      <span className="text-sm font-semibold text-clay">
                        No one is home
                      </span>
                    )}
                  </div>
                  {away.length > 0 ? (
                    <p className="mt-3 mb-0 text-sm text-muted">
                      Away:{" "}
                      {away.map((member) => member.displayName).join(", ")}
                    </p>
                  ) : (
                    <p className="mt-3 mb-0 text-sm text-muted">
                      Everyone is home
                    </p>
                  )}
                  <Link
                    className="mt-3 inline-flex text-sm font-bold text-herb underline decoration-herb/40 underline-offset-4"
                    to={`/presence?week=${loaderData.weekStart}`}
                  >
                    Change who is home
                  </Link>
                </section>

                <section aria-label={`Dinner for ${dayName}`}>
                  <p className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted">
                    <Utensils aria-hidden="true" size={15} />
                    Planned dinner
                  </p>
                  {day.entry ? (
                    <div>
                      <Link
                        className="display-type text-xl text-ink underline decoration-clay/40 underline-offset-4"
                        to={`/recipes/${day.entry.recipeId}`}
                      >
                        {day.entry.recipeTitle}
                      </Link>
                      <p className="mt-1 mb-0 text-sm text-muted">
                        {day.entry.leftoverBufferServings > 0
                          ? `${day.entry.leftoverBufferServings} deliberate leftover ${
                              day.entry.leftoverBufferServings === 1
                                ? "serving"
                                : "servings"
                            }`
                          : "No deliberate leftovers"}
                      </p>
                    </div>
                  ) : (
                    <p className="m-0 text-sm text-muted">
                      Keep this night open or add a recipe.
                    </p>
                  )}

                  {loaderData.recipes.length > 0 ? (
                    <details className="mt-4 rounded-xl border border-rule bg-paper-light p-3">
                      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-bold text-herb">
                        <Plus aria-hidden="true" size={16} />
                        {day.entry ? "Replace dinner" : "Add dinner"}
                      </summary>
                      <Form
                        className="mt-4 grid gap-3"
                        id={formId}
                        method="post"
                      >
                        <input name="intent" type="hidden" value="schedule" />
                        <input
                          name="scheduledDate"
                          type="hidden"
                          value={day.date}
                        />
                        <input
                          name="weekStart"
                          type="hidden"
                          value={loaderData.weekStart}
                        />
                        <label className="field" htmlFor={`${formId}-recipe`}>
                          <span className="field-label">Recipe</span>
                          <select
                            className="select"
                            defaultValue={day.entry?.recipeId ?? ""}
                            id={`${formId}-recipe`}
                            name="recipeId"
                            required
                          >
                            <option disabled value="">
                              Choose a recipe
                            </option>
                            {loaderData.recipes.map((recipe) => (
                              <option key={recipe.id} value={recipe.id}>
                                {recipe.title}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label
                          className="field"
                          htmlFor={`${formId}-leftovers`}
                        >
                          <span className="field-label">
                            Deliberate leftover servings
                          </span>
                          <select
                            className="select"
                            defaultValue={
                              day.entry?.leftoverBufferServings ?? 0
                            }
                            id={`${formId}-leftovers`}
                            name="leftoverBufferServings"
                          >
                            {[0, 1, 2, 3, 4].map((value) => (
                              <option key={value} value={value}>
                                {value}
                              </option>
                            ))}
                          </select>
                        </label>
                        <SubmitButton
                          pendingLabel="Saving dinner"
                          pendingMatch={{
                            intent: "schedule",
                            scheduledDate: day.date,
                          }}
                        >
                          {day.entry ? "Save replacement" : "Add to week"}
                        </SubmitButton>
                      </Form>
                    </details>
                  ) : (
                    <Link
                      className="button button-secondary mt-4"
                      to="/recipes/new"
                    >
                      <Plus aria-hidden="true" size={16} />
                      Create a recipe
                    </Link>
                  )}

                  {day.entry ? (
                    <Form className="mt-3" method="post">
                      <input name="intent" type="hidden" value="remove" />
                      <input
                        name="entryId"
                        type="hidden"
                        value={day.entry.id}
                      />
                      <input
                        name="weekStart"
                        type="hidden"
                        value={loaderData.weekStart}
                      />
                      <SubmitButton
                        className="button button-danger"
                        pendingLabel="Removing dinner"
                        pendingMatch={{
                          entryId: day.entry.id,
                          intent: "remove",
                        }}
                      >
                        <Trash2 aria-hidden="true" size={15} />
                        Remove dinner
                      </SubmitButton>
                    </Form>
                  ) : null}
                </section>
              </div>
            </article>
          );
        })}
      </section>
    </>
  );
}
