import {
  AlertTriangle,
  CalendarDays,
  Check,
  ChefHat,
  Clock3,
  RefreshCcw,
  SlidersHorizontal,
  Sparkles,
  UsersRound,
  WandSparkles,
} from "lucide-react";
import { Form, Link } from "react-router";

import { SubmitButton } from "~/components/form-controls";
import { formatDateLabel } from "~/domain/dates";
import type {
  NormalizedWeeklyCandidate,
  WeeklyGenerationRerollHistory,
  WeeklyGenerationSelection,
  WeeklyGenerationSlot,
} from "~/domain/weekly-generation";

type WeeklyPlanDraftCommonProps = Readonly<{
  existingDinnerCount: number;
  preferencesCustomized: boolean;
  slots: readonly WeeklyGenerationSlot[];
  weekStart: string;
}>;

export type WeeklyPlanDraftProps =
  | (WeeklyPlanDraftCommonProps &
      Readonly<{
        state: "initial";
      }>)
  | (WeeklyPlanDraftCommonProps &
      Readonly<{
        rerollHistory: WeeklyGenerationRerollHistory;
        runId: string;
        selectedCandidates: readonly NormalizedWeeklyCandidate[];
        selectionScore: WeeklyGenerationSelection["score"];
        state: "proposal";
      }>);

const effortLabels = {
  project: "Project pace",
  weekend: "Weekend pace",
  weeknight: "Weeknight pace",
} as const;

const quantityFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

function shortDate(date: string): string {
  return formatDateLabel(date, {
    day: "numeric",
    month: "short",
    weekday: "short",
  });
}

function longDate(date: string): string {
  return formatDateLabel(date, {
    day: "numeric",
    month: "long",
    weekday: "long",
  });
}

function displayUnit(unit: string): string {
  return unit === "fl_oz" ? "fl oz" : unit;
}

function PreferenceNote({ customized }: Readonly<{ customized: boolean }>) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-paper-light/20 bg-paper-light/8 p-4">
      <SlidersHorizontal
        aria-hidden="true"
        className="mt-0.5 shrink-0 text-butter"
        size={19}
      />
      <div>
        <p className="m-0 text-sm font-bold text-paper-light">
          {customized
            ? "Your kitchen preferences are in the mix."
            : "A familiar, family-friendly starter profile is in the mix."}
        </p>
        <p className="mt-1 mb-0 text-xs leading-5 text-paper-light/70">
          {customized
            ? "Saved favorites, limits, and hard no's guide every candidate."
            : "Add favorites, spice limits, allergies, or hard no's whenever you are ready."}
        </p>
        <Link
          className="mt-2 inline-flex text-xs font-bold text-butter underline decoration-butter/40 underline-offset-4"
          to="/preferences"
        >
          Review kitchen preferences
        </Link>
      </div>
    </div>
  );
}

function ReplacementNotice({ count }: Readonly<{ count: number }>) {
  if (count < 1) return null;

  return (
    <div
      className="flex items-start gap-3 rounded-2xl border border-clay/35 bg-[#fff7f3] p-4 text-ink"
      role="note"
    >
      <AlertTriangle
        aria-hidden="true"
        className="mt-0.5 shrink-0 text-clay"
        size={19}
      />
      <p className="m-0 text-sm leading-6">
        <strong>
          {count} generated {count === 1 ? "date already has" : "dates already have"} dinner.
        </strong>{" "}
        Accepting the draft will replace {count === 1 ? "that dinner" : "those dinners"}.
      </p>
    </div>
  );
}

function SlotStrip({ slots }: Readonly<{ slots: readonly WeeklyGenerationSlot[] }>) {
  return (
    <ol
      aria-label="Dinner dates selected for generation"
      className="m-0 grid list-none grid-cols-2 gap-px overflow-hidden rounded-2xl border border-paper-light/20 bg-paper-light/20 p-0 sm:grid-cols-5"
    >
      {slots.map((slot, index) => (
        <li
          className="min-w-0 bg-herb-dark/90 px-3 py-4 text-paper-light last:col-span-2 sm:last:col-span-1"
          key={slot.date}
        >
          <span className="font-mono text-[0.62rem] font-bold tracking-[0.15em] text-butter">
            NIGHT {String(index + 1).padStart(2, "0")}
          </span>
          <strong className="mt-1 block truncate text-sm">
            {shortDate(slot.date)}
          </strong>
          <span className="mt-1 block text-xs text-paper-light/65">
            {slot.servingsTarget} servings
          </span>
        </li>
      ))}
    </ol>
  );
}

function InitialDraft(props: Extract<WeeklyPlanDraftProps, { state: "initial" }>) {
  return (
    <section
      aria-labelledby="weekly-draft-intro-title"
      className="grid gap-5"
    >
      <div className="relative overflow-hidden rounded-[2rem_2rem_2rem_0.45rem] border border-herb-dark bg-herb p-5 text-paper-light shadow-[0_1rem_2.5rem_rgba(29,42,34,0.18)] sm:p-8">
        <div
          aria-hidden="true"
          className="absolute -top-28 -right-16 size-72 rounded-full border border-paper-light/10 bg-paper-light/5"
        />
        <div
          aria-hidden="true"
          className="absolute right-28 -bottom-24 size-44 rounded-full border border-butter/20"
        />

        <div className="relative grid gap-7 lg:grid-cols-[minmax(0,1.35fr)_minmax(17rem,0.65fr)] lg:items-start">
          <div>
            <p className="mb-3 flex items-center gap-2 text-[0.68rem] font-bold tracking-[0.16em] text-butter uppercase">
              <WandSparkles aria-hidden="true" size={16} />
              AI weekly draft
            </p>
            <h2
              className="m-0 max-w-[13ch] text-4xl leading-[0.98] text-paper-light sm:text-5xl"
              id="weekly-draft-intro-title"
            >
              One thoughtful pass. Five dinners handled.
            </h2>
            <p className="mt-5 mb-0 max-w-2xl text-sm leading-7 text-paper-light/78 sm:text-base">
              No dinner-by-dinner prompts. AI creates 15 practical ideas for
              these dates, then the planner chooses five for variety and useful
              ingredient overlap.
            </p>
          </div>

          <PreferenceNote customized={props.preferencesCustomized} />
        </div>

        <div className="relative mt-7">
          <SlotStrip slots={props.slots} />
        </div>
      </div>

      <ReplacementNotice count={props.existingDinnerCount} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.42fr)]">
        <section className="surface grid gap-px overflow-hidden sm:grid-cols-3">
          <div className="border-b border-rule p-5 sm:border-r sm:border-b-0">
            <span className="grid size-9 place-items-center rounded-full bg-butter font-mono text-xs font-bold text-ink">
              01
            </span>
            <h3 className="mt-4 mb-1 text-xl text-ink">A broader first look</h3>
            <p className="m-0 text-sm leading-6 text-muted">
              Fifteen complete meal ideas are built against the ingredient
              catalog and serving targets.
            </p>
          </div>
          <div className="border-b border-rule p-5 sm:border-r sm:border-b-0">
            <span className="grid size-9 place-items-center rounded-full bg-herb text-xs font-bold text-paper-light">
              02
            </span>
            <h3 className="mt-4 mb-1 text-xl text-ink">A balanced five</h3>
            <p className="m-0 text-sm leading-6 text-muted">
              Protein, cuisine, technique, and shared ingredients shape the
              first draft you see.
            </p>
          </div>
          <div className="p-5">
            <span className="grid size-9 place-items-center rounded-full bg-clay text-xs font-bold text-paper-light">
              03
            </span>
            <h3 className="mt-4 mb-1 text-xl text-ink">You keep the last word</h3>
            <p className="m-0 text-sm leading-6 text-muted">
              Review every dinner and try alternatives before anything is
              added to the week.
            </p>
          </div>
        </section>

        <section className="surface flex flex-col justify-between gap-5 border-butter bg-butter/12 p-5 sm:p-6">
          <div>
            <p className="eyebrow">Ready when you are</p>
            <h3 className="m-0 text-2xl text-ink">Build the first draft</h3>
            <p className="mt-2 mb-0 text-sm leading-6 text-muted">
              This can take about a minute. Instructions are written only after
              you accept the five dinners.
            </p>
          </div>
          <Form method="post">
            <input name="_intent" type="hidden" value="start" />
            <input name="weekStart" type="hidden" value={props.weekStart} />
            <SubmitButton
              className="button button-primary w-full"
              pendingLabel="Creating 15 dinner ideas"
              pendingMatch={{ _intent: "start" }}
            >
              <Sparkles aria-hidden="true" size={18} />
              Build my week
            </SubmitButton>
          </Form>
          <p className="m-0 text-xs leading-5 text-muted">
            Uses your kitchen preferences and canonical catalog. Pantry and cost
            optimization are not active in this draft yet.
          </p>
        </section>
      </div>
    </section>
  );
}

function CandidateCard({
  candidate,
  index,
  remainingAlternatives,
  runId,
  weekStart,
}: Readonly<{
  candidate: NormalizedWeeklyCandidate;
  index: number;
  remainingAlternatives: number;
  runId: string;
  weekStart: string;
}>) {
  return (
    <li className="min-w-0">
      <article className="surface flex h-full flex-col overflow-hidden">
        <header className="relative overflow-hidden border-b border-rule bg-paper-light px-5 py-5 sm:px-6">
          <div
            aria-hidden="true"
            className="absolute -top-12 -right-10 size-32 rounded-full border border-herb/10 bg-herb/5"
          />
          <div className="relative flex items-start justify-between gap-4">
            <div>
              <p className="mb-2 font-mono text-[0.65rem] font-bold tracking-[0.15em] text-clay uppercase">
                Night {String(index + 1).padStart(2, "0")} · {longDate(candidate.slotDate)}
              </p>
              <h3 className="m-0 text-2xl leading-tight text-ink">
                {candidate.title}
              </h3>
            </div>
            <span className="grid size-10 shrink-0 place-items-center rounded-full border border-ink bg-butter text-sm font-bold text-ink shadow-[2px_2px_0_#1d2a22]">
              {candidate.baseServings}
              <span className="sr-only"> servings</span>
            </span>
          </div>
        </header>

        <div className="flex flex-1 flex-col p-5 sm:p-6">
          <div className="mb-5 flex flex-wrap gap-2 text-xs font-semibold">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-rule bg-white px-2.5 py-1.5 text-ink">
              <Clock3 aria-hidden="true" size={14} />
              {candidate.activeTimeMinutes} active · {candidate.totalTimeMinutes} total
            </span>
            <span className="rounded-full border border-herb/25 bg-herb/10 px-2.5 py-1.5 text-herb-dark">
              {effortLabels[candidate.effortTier]}
            </span>
            {candidate.cuisine ? (
              <span className="rounded-full border border-clay/25 bg-clay/10 px-2.5 py-1.5 text-clay">
                {candidate.cuisine}
              </span>
            ) : null}
          </div>

          <div className="grid flex-1 gap-5 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div>
              <p className="mb-2 flex items-center gap-2 text-[0.66rem] font-bold tracking-[0.14em] text-muted uppercase">
                <ChefHat aria-hidden="true" size={14} />
                What is in it
              </p>
              <ul className="m-0 grid list-none gap-1.5 p-0 text-sm text-ink">
                {candidate.ingredients.map((ingredient) => (
                  <li
                    className="flex items-baseline justify-between gap-3 border-b border-rule/65 pb-1.5 last:border-b-0"
                    key={ingredient.canonicalIngredientId}
                  >
                    <span className="min-w-0 truncate">
                      {ingredient.name}
                      {ingredient.isOptional ? (
                        <span className="ml-1 text-xs text-muted">optional</span>
                      ) : null}
                    </span>
                    <strong className="shrink-0 text-xs font-semibold text-muted">
                      {quantityFormatter.format(ingredient.quantity)}{" "}
                      {displayUnit(ingredient.unit)}
                    </strong>
                  </li>
                ))}
              </ul>
            </div>

            <div className="sm:w-36">
              <p className="mb-2 text-[0.66rem] font-bold tracking-[0.14em] text-muted uppercase">
                Technique
              </p>
              <div className="flex flex-wrap gap-1.5 sm:grid">
                {candidate.techniques.map((technique) => (
                  <span
                    className="rounded-lg border border-rule bg-paper px-2.5 py-1.5 text-xs font-semibold text-muted"
                    key={technique}
                  >
                    {technique}
                  </span>
                ))}
              </div>
              {candidate.primaryProtein ? (
                <p className="mt-3 mb-0 text-xs leading-5 text-muted">
                  <strong className="text-ink">Main:</strong>{" "}
                  {candidate.primaryProtein}
                </p>
              ) : null}
            </div>
          </div>

          <div className="mt-5 border-t border-rule pt-4">
            {remainingAlternatives > 0 ? (
              <Form method="post">
                <input name="_intent" type="hidden" value="reroll" />
                <input name="runId" type="hidden" value={runId} />
                <input
                  name="slotDate"
                  type="hidden"
                  value={candidate.slotDate}
                />
                <input name="weekStart" type="hidden" value={weekStart} />
                <SubmitButton
                  className="button button-secondary w-full"
                  pendingLabel="Trying the next dinner"
                  pendingMatch={{
                    _intent: "reroll",
                    slotDate: candidate.slotDate,
                  }}
                >
                  <RefreshCcw aria-hidden="true" size={16} />
                  Try another
                  <span className="font-normal text-muted">
                    ({remainingAlternatives} left)
                  </span>
                </SubmitButton>
              </Form>
            ) : (
              <p className="m-0 flex min-h-11 items-center justify-center gap-2 rounded-full border border-herb/25 bg-herb/10 px-4 text-sm font-bold text-herb-dark">
                <Check aria-hidden="true" size={16} />
                All three ideas reviewed
              </p>
            )}
          </div>
        </div>
      </article>
    </li>
  );
}

function ProposalDraft(
  props: Extract<WeeklyPlanDraftProps, { state: "proposal" }>,
) {
  return (
    <section aria-labelledby="weekly-proposal-title" className="grid gap-5">
      <div className="relative overflow-hidden rounded-[2rem_2rem_2rem_0.45rem] border border-ink bg-ink p-5 text-paper-light shadow-[0_1rem_2.5rem_rgba(29,42,34,0.2)] sm:p-8">
        <div
          aria-hidden="true"
          className="absolute -top-24 right-0 size-72 rounded-full border border-paper-light/10 bg-herb/30"
        />
        <div className="relative grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.55fr)] lg:items-end">
          <div>
            <p className="mb-3 flex items-center gap-2 text-[0.68rem] font-bold tracking-[0.16em] text-butter uppercase">
              <Sparkles aria-hidden="true" size={16} />
              15 considered · 5 selected
            </p>
            <h2
              className="m-0 max-w-[15ch] text-4xl leading-[0.98] text-paper-light sm:text-5xl"
              id="weekly-proposal-title"
            >
              Your week, before it becomes the plan.
            </h2>
            <p className="mt-4 mb-0 max-w-2xl text-sm leading-7 text-paper-light/72">
              Review the ingredients and pace. Try another dinner on any date,
              then accept all five when the mix feels right.
            </p>
          </div>
          <PreferenceNote customized={props.preferencesCustomized} />
        </div>
      </div>

      <ReplacementNotice count={props.existingDinnerCount} />

      <section
        aria-label="Why these dinners were selected"
        className="surface grid gap-4 p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-6"
      >
        <div>
          <p className="eyebrow">The shape of this week</p>
          <p className="m-0 text-sm leading-6 text-muted">
            The planner favored variety without throwing five unrelated grocery
            lists at you.
          </p>
          {props.selectionScore.sharedIngredientNames.length > 0 ? (
            <p className="mt-2 mb-0 text-sm leading-6 text-ink">
              <strong>Useful overlap:</strong>{" "}
              {props.selectionScore.sharedIngredientNames.join(", ")}
            </p>
          ) : null}
        </div>
        <dl className="m-0 grid grid-cols-3 gap-2">
          <div className="rounded-xl border border-rule bg-paper px-3 py-2 text-center">
            <dt className="text-[0.62rem] font-bold tracking-wider text-muted uppercase">
              Proteins
            </dt>
            <dd className="mt-1 mb-0 font-display text-2xl text-herb">
              {props.selectionScore.proteinVariety}
            </dd>
          </div>
          <div className="rounded-xl border border-rule bg-paper px-3 py-2 text-center">
            <dt className="text-[0.62rem] font-bold tracking-wider text-muted uppercase">
              Cuisines
            </dt>
            <dd className="mt-1 mb-0 font-display text-2xl text-herb">
              {props.selectionScore.cuisineVariety}
            </dd>
          </div>
          <div className="rounded-xl border border-rule bg-paper px-3 py-2 text-center">
            <dt className="text-[0.62rem] font-bold tracking-wider text-muted uppercase">
              Methods
            </dt>
            <dd className="mt-1 mb-0 font-display text-2xl text-herb">
              {props.selectionScore.techniqueVariety}
            </dd>
          </div>
        </dl>
      </section>

      <ol
        aria-label="Five proposed dinners"
        className="m-0 grid list-none gap-5 p-0 xl:grid-cols-2"
      >
        {props.selectedCandidates.map((candidate, index) => {
          const reviewedCount = props.rerollHistory[candidate.slotDate]?.length ?? 1;
          return (
            <CandidateCard
              candidate={candidate}
              index={index}
              key={candidate.candidateKey}
              remainingAlternatives={Math.max(0, 3 - reviewedCount)}
              runId={props.runId}
              weekStart={props.weekStart}
            />
          );
        })}
      </ol>

      <section className="surface overflow-hidden border-herb/40">
        <div className="grid gap-5 bg-herb p-5 text-paper-light sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-7">
          <div>
            <p className="mb-2 flex items-center gap-2 text-[0.68rem] font-bold tracking-[0.14em] text-butter uppercase">
              <CalendarDays aria-hidden="true" size={15} />
              Make it the plan
            </p>
            <h3 className="m-0 text-3xl text-paper-light">
              Ready to cook this week?
            </h3>
            <p className="mt-2 mb-0 max-w-2xl text-sm leading-6 text-paper-light/72">
              Accepting writes complete instructions for these five recipes,
              saves them to your library, and schedules them on these dates.
            </p>
          </div>
          <Form method="post">
            <input name="_intent" type="hidden" value="accept" />
            <input name="runId" type="hidden" value={props.runId} />
            <input name="weekStart" type="hidden" value={props.weekStart} />
            <SubmitButton
              className="button min-w-56 border border-butter bg-butter text-ink shadow-[0_4px_0_#c69a2f] hover:bg-[#f0c85c]"
              pendingLabel="Writing five recipes"
              pendingMatch={{ _intent: "accept" }}
            >
              <Check aria-hidden="true" size={18} />
              Accept all five
            </SubmitButton>
          </Form>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-herb-dark bg-herb-dark px-5 py-3 text-xs text-paper-light/65 sm:px-7">
          <span className="inline-flex items-center gap-2">
            <UsersRound aria-hidden="true" size={14} />
            Serving targets come from who is home.
          </span>
          <span>
            Pantry and cost optimization are not active in this draft yet.
          </span>
        </div>
      </section>
    </section>
  );
}

export function WeeklyPlanDraft(props: WeeklyPlanDraftProps) {
  return props.state === "initial" ? (
    <InitialDraft {...props} />
  ) : (
    <ProposalDraft {...props} />
  );
}
