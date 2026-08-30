import {
  AlertTriangle,
  CalendarCheck2,
  CalendarDays,
  Check,
  ChefHat,
  ChevronDown,
  Clock3,
  ListChecks,
  LoaderCircle,
  RefreshCcw,
  ShoppingBasket,
  SlidersHorizontal,
  Sparkles,
  UsersRound,
  WandSparkles,
} from "lucide-react";
import { Form, Link, useNavigation } from "react-router";

import { FormError, SubmitButton } from "~/components/form-controls";
import { formatDateLabel } from "~/domain/dates";
import type {
  NormalizedWeeklyCandidate,
  WeeklyDraftIngredientSummary,
  WeeklyGenerationSelection,
  WeeklyGenerationSlot,
} from "~/domain/weekly-generation";
import { summarizeWeeklyDraftIngredients } from "~/domain/weekly-generation";
import {
  formatRecipeTextForUsKitchen,
  formatUsRecipeQuantity,
} from "~/domain/us-kitchen-display";

type WeeklyPlanDraftCommonProps = Readonly<{
  activeBuild?: boolean;
  actionError: string | null;
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
        activeSlotDate: string | null;
        allCandidates: readonly NormalizedWeeklyCandidate[];
        activeSave: boolean;
        changedDate: string | null;
        runId: string;
        selectedCandidates: readonly NormalizedWeeklyCandidate[];
        selectionScore: WeeklyGenerationSelection["score"];
        state: "proposal";
        statusNotice: "ready" | "regenerated" | "selected" | null;
      }>);

const effortLabels = {
  project: "Project pace",
  weekend: "Weekend pace",
  weeknight: "Weeknight pace",
} as const;

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

function GenerationProgress({
  mode,
}: Readonly<{ mode: "building" | "saving" }>) {
  const building = mode === "building";
  return (
    <section
      aria-live="polite"
      className="relative overflow-hidden rounded-[2rem_2rem_2rem_0.45rem] border border-herb-dark bg-herb p-6 text-paper-light shadow-[0_1rem_2.5rem_rgba(29,42,34,0.18)] sm:p-9"
      role="status"
    >
      <div
        aria-hidden="true"
        className="absolute -top-24 -right-16 size-72 rounded-full border border-paper-light/10 bg-paper-light/5"
      />
      <div className="relative flex max-w-3xl items-start gap-4">
        <span className="grid size-12 shrink-0 place-items-center rounded-full bg-butter text-ink">
          <LoaderCircle aria-hidden="true" className="animate-spin" size={23} />
        </span>
        <div>
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-butter">
            {building ? "Building your review" : "Finishing your plan"}
          </p>
          <h2 className="m-0 text-3xl text-paper-light sm:text-4xl">
            {building
              ? "Creating 15 dinner ideas"
              : "Writing and saving five complete recipes"}
          </h2>
          <p className="mt-3 mb-0 leading-7 text-paper-light/75">
            {building
              ? "Stay on this page. This can take a few minutes while three options are prepared for each night. The review will appear here automatically."
              : "Stay on this page while instructions are completed, recipes are saved to your library, and dinners are added to the week."}
          </p>
        </div>
      </div>
    </section>
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
          {count} generated{" "}
          {count === 1 ? "date already has" : "dates already have"} dinner.
        </strong>{" "}
        Accepting the draft will replace{" "}
        {count === 1 ? "that dinner" : "those dinners"}.
      </p>
    </div>
  );
}

function SlotStrip({
  slots,
}: Readonly<{ slots: readonly WeeklyGenerationSlot[] }>) {
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

function InitialDraft(
  props: Extract<WeeklyPlanDraftProps, { state: "initial" }>,
) {
  const navigation = useNavigation();
  const building =
    navigation.state !== "idle" &&
    navigation.formData?.get("_intent") === "start";
  if (building || props.activeBuild)
    return <GenerationProgress mode="building" />;

  return (
    <section aria-labelledby="weekly-draft-intro-title" className="grid gap-5">
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
              See the meals before you save them.
            </h2>
            <p className="mt-5 mb-0 max-w-2xl text-sm leading-7 text-paper-light/78 sm:text-base">
              AI creates three choices for each dinner date, then shows you a
              balanced five that favors what likely remains after earlier
              scheduled recipes. Nothing is added to your plan or Recipe Library
              at this step.
            </p>
          </div>

          <PreferenceNote customized={props.preferencesCustomized} />
        </div>

        <div className="relative mt-7">
          <SlotStrip slots={props.slots} />
        </div>
      </div>

      <ReplacementNotice count={props.existingDinnerCount} />

      <section className="surface grid gap-5 border-butter bg-butter/12 p-5 sm:grid-cols-[minmax(0,1fr)_minmax(18rem,0.7fr)] sm:items-center sm:p-6">
        <div>
          <p className="eyebrow">Ready when you are</p>
          <h3 className="m-0 text-2xl text-ink">
            Create the review on this page
          </h3>
          <p className="mt-2 mb-0 max-w-2xl text-sm leading-6 text-muted">
            You will get five dinner cards here, with two already-generated
            alternatives for each night. Saved counts, grocery amounts, and
            estimated use by earlier recipes guide the next week without
            limiting you to only what is likely on hand.
          </p>
        </div>
        <div className="grid gap-4">
          <FormError>{props.actionError}</FormError>
          <Form method="post">
            <input name="_intent" type="hidden" value="start" />
            <input name="weekStart" type="hidden" value={props.weekStart} />
            <SubmitButton
              className="button button-primary w-full"
              pendingLabel="Creating 15 dinner ideas"
              pendingMatch={{ _intent: "start" }}
            >
              <Sparkles aria-hidden="true" size={18} />
              Create and show my options
            </SubmitButton>
          </Form>
        </div>
      </section>

      <section
        aria-labelledby="draft-output-placeholder-title"
        className="surface flex scroll-mt-24 items-start gap-4 border-dashed p-5 sm:p-6"
        id="draft-review"
      >
        <span className="grid size-11 shrink-0 place-items-center rounded-full border border-rule bg-paper-light text-herb">
          <ListChecks aria-hidden="true" size={20} />
        </span>
        <div>
          <h3 className="m-0 text-xl" id="draft-output-placeholder-title">
            Your five-dinner review will appear right here.
          </h3>
          <p className="mt-1 mb-0 text-sm leading-6 text-muted">
            This page will replace this note with the dinner cards and a live
            ingredient summary. You will not need to hunt through the Recipe
            Library.
          </p>
        </div>
      </section>
    </section>
  );
}

function CandidateCard({
  activeSlotDate,
  candidateOptions,
  candidate,
  changeStatus,
  disableMutations,
  index,
  runId,
  weekStart,
}: Readonly<{
  activeSlotDate: string | null;
  candidateOptions: readonly NormalizedWeeklyCandidate[];
  candidate: NormalizedWeeklyCandidate;
  changeStatus: "regenerated" | "selected" | null;
  disableMutations: boolean;
  index: number;
  runId: string;
  weekStart: string;
}>) {
  const navigation = useNavigation();
  const locallyRegenerating =
    navigation.state !== "idle" &&
    navigation.formData?.get("_intent") === "regenerate-slot" &&
    navigation.formData.get("slotDate") === candidate.slotDate;
  const regenerating =
    locallyRegenerating || activeSlotDate === candidate.slotDate;
  const dayLabel = longDate(candidate.slotDate).split(",")[0];

  return (
    <li
      className="min-w-0 scroll-mt-24 outline-none"
      id={`dinner-${candidate.slotDate}`}
      tabIndex={-1}
    >
      <article
        aria-busy={regenerating || undefined}
        className={`surface flex h-full flex-col overflow-hidden ${
          changeStatus ? "border-herb ring-2 ring-herb/20" : ""
        }`}
      >
        {changeStatus ? (
          <div
            className="flex items-center gap-2 border-b border-herb/25 bg-herb/10 px-5 py-3 text-sm font-bold text-herb-dark sm:px-6"
            role="status"
          >
            <Check aria-hidden="true" size={16} />
            {changeStatus === "regenerated"
              ? `Three fresh ideas are ready for ${dayLabel}. No other dinner changed.`
              : "Dinner changed. Your combined ingredients have updated."}
          </div>
        ) : null}
        {regenerating ? (
          <div
            className="flex items-start gap-3 border-b border-butter/45 bg-butter/15 px-5 py-4 text-sm text-ink sm:px-6"
            role="status"
          >
            <LoaderCircle
              aria-hidden="true"
              className="mt-0.5 shrink-0 animate-spin text-herb"
              size={17}
            />
            <span>
              <strong>Creating 3 fresh ideas for {dayLabel}.</strong> Your other
              dinners will stay put. This can take a few minutes.
            </span>
          </div>
        ) : null}
        <header className="relative overflow-hidden border-b border-rule bg-paper-light px-5 py-5 sm:px-6">
          <div
            aria-hidden="true"
            className="absolute -top-12 -right-10 size-32 rounded-full border border-herb/10 bg-herb/5"
          />
          <div className="relative flex items-start justify-between gap-4">
            <div>
              <p className="mb-2 font-mono text-[0.65rem] font-bold tracking-[0.15em] text-clay uppercase">
                Night {String(index + 1).padStart(2, "0")} ·{" "}
                {longDate(candidate.slotDate)}
              </p>
              <h3 className="m-0 text-2xl leading-tight text-ink">
                {candidate.title}
              </h3>
            </div>
            <span className="flex min-w-16 shrink-0 flex-col items-center rounded-2xl border border-ink bg-butter px-2 py-1.5 text-ink shadow-[2px_2px_0_#1d2a22]">
              <strong className="text-base leading-none">
                {candidate.baseServings}
              </strong>
              <span className="mt-1 text-[0.58rem] font-bold tracking-wide uppercase">
                servings
              </span>
            </span>
          </div>
        </header>

        <div className="flex flex-1 flex-col p-5 sm:p-6">
          <div className="mb-5 flex flex-wrap gap-2 text-xs font-semibold">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-rule bg-white px-2.5 py-1.5 text-ink">
              <Clock3 aria-hidden="true" size={14} />
              {candidate.activeTimeMinutes} active ·{" "}
              {candidate.totalTimeMinutes} total
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
                    <span className="min-w-0">
                      {ingredient.name}
                      {ingredient.preparation ? (
                        <span className="font-normal text-muted">
                          {`, ${formatRecipeTextForUsKitchen(ingredient.preparation)}`}
                        </span>
                      ) : null}
                      {ingredient.isOptional ? (
                        <span className="ml-1 text-xs text-muted">
                          optional
                        </span>
                      ) : null}
                    </span>
                    <strong className="shrink-0 text-xs font-semibold text-muted">
                      {formatUsRecipeQuantity({
                        baseUnit: ingredient.baseUnit,
                        quantity: ingredient.quantity,
                        quantityInBaseUnit: ingredient.quantityInBaseUnit,
                        unit: ingredient.unit,
                      })}
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

          <div className="mt-6 border-t border-rule pt-5">
            <fieldset className="m-0 min-w-0 border-0 p-0">
              <legend className="text-base font-bold text-ink">
                {candidateOptions.length} ideas for {dayLabel}
              </legend>
              <p className="mt-1 mb-3 text-xs leading-5 text-muted">
                Choose any idea again. The selected recipe details and combined
                ingredients update immediately.
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                {candidateOptions.map((option, optionIndex) => {
                  const selected =
                    option.candidateKey === candidate.candidateKey;
                  const label = (
                    <>
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[0.61rem] font-bold tracking-[0.12em] uppercase">
                          Idea {optionIndex + 1}
                        </span>
                        {selected ? (
                          <span className="rounded-full bg-herb px-2 py-0.5 text-[0.58rem] font-bold tracking-wide text-paper-light uppercase">
                            Selected
                          </span>
                        ) : null}
                      </span>
                      <strong className="mt-1 block text-left text-sm leading-5">
                        {option.title}
                      </strong>
                      <span className="mt-1 block text-left text-[0.68rem] font-normal text-muted">
                        {option.activeTimeMinutes} min active
                        {option.cuisine ? ` · ${option.cuisine}` : ""}
                      </span>
                    </>
                  );

                  if (selected) {
                    return (
                      <button
                        aria-label={`${option.title}, selected idea`}
                        aria-pressed="true"
                        className="min-h-24 rounded-xl border-2 border-herb bg-herb/10 p-3 text-herb-dark"
                        key={option.candidateKey}
                        type="button"
                      >
                        {label}
                      </button>
                    );
                  }

                  if (disableMutations) {
                    return (
                      <button
                        aria-label={`${option.title}, unavailable while fresh ideas are being created`}
                        aria-pressed="false"
                        className="min-h-24 rounded-xl border border-rule bg-white p-3 text-ink opacity-55"
                        disabled
                        key={option.candidateKey}
                        type="button"
                      >
                        {label}
                      </button>
                    );
                  }

                  return (
                    <Form key={option.candidateKey} method="post">
                      <input
                        name="_intent"
                        type="hidden"
                        value="select-candidate"
                      />
                      <input name="runId" type="hidden" value={runId} />
                      <input
                        name="slotDate"
                        type="hidden"
                        value={candidate.slotDate}
                      />
                      <input
                        name="candidateKey"
                        type="hidden"
                        value={option.candidateKey}
                      />
                      <input name="weekStart" type="hidden" value={weekStart} />
                      <SubmitButton
                        className="min-h-24 w-full rounded-xl border border-rule bg-white p-3 text-ink transition hover:border-herb hover:bg-herb/5 disabled:cursor-not-allowed disabled:opacity-55"
                        pendingLabel="Switching dinner"
                        pendingMatch={{
                          _intent: "select-candidate",
                          candidateKey: option.candidateKey,
                        }}
                      >
                        {label}
                      </SubmitButton>
                    </Form>
                  );
                })}
              </div>
            </fieldset>

            <details className="mt-4 rounded-xl border border-rule bg-paper">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-bold text-ink marker:hidden">
                None of these work?
                <ChevronDown aria-hidden="true" size={17} />
              </summary>
              <div className="border-t border-rule p-4">
                {candidateOptions.length < 12 ? (
                  <>
                    <p className="mt-0 mb-3 text-sm leading-6 text-muted">
                      Create three completely new ideas for {dayLabel}. Your
                      other four dinners will stay exactly as selected, and
                      every idea already shown here will remain available.
                    </p>
                    {disableMutations ? (
                      <button
                        className="button button-secondary w-full"
                        disabled
                        type="button"
                      >
                        <LoaderCircle
                          aria-hidden="true"
                          className="animate-spin"
                          size={16}
                        />
                        Finish the current update first
                      </button>
                    ) : (
                      <Form method="post">
                        <input
                          name="_intent"
                          type="hidden"
                          value="regenerate-slot"
                        />
                        <input name="runId" type="hidden" value={runId} />
                        <input
                          name="slotDate"
                          type="hidden"
                          value={candidate.slotDate}
                        />
                        <input
                          name="weekStart"
                          type="hidden"
                          value={weekStart}
                        />
                        <SubmitButton
                          className="button button-secondary w-full"
                          pendingLabel="Creating 3 fresh ideas"
                          pendingMatch={{
                            _intent: "regenerate-slot",
                            slotDate: candidate.slotDate,
                          }}
                        >
                          <RefreshCcw aria-hidden="true" size={16} />
                          Generate 3 fresh ideas
                        </SubmitButton>
                      </Form>
                    )}
                  </>
                ) : (
                  <p className="m-0 text-sm leading-6 text-muted">
                    You have all 12 available ideas for this night. Choose any
                    one above, or create a new weekly draft to start over.
                  </p>
                )}
              </div>
            </details>
          </div>
        </div>
      </article>
    </li>
  );
}

function DraftIngredientList({
  ingredients,
}: Readonly<{ ingredients: readonly WeeklyDraftIngredientSummary[] }>) {
  return (
    <ul className="m-0 grid list-none gap-0 p-0">
      {ingredients.map((ingredient) => (
        <li
          className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-rule px-5 py-3 last:border-b-0"
          key={ingredient.canonicalIngredientId}
        >
          <span className="min-w-0 text-sm font-semibold text-ink">
            {ingredient.name}
            <span className="mt-1 flex flex-wrap gap-1.5">
              {ingredient.isStaple ? (
                <span className="rounded-full bg-butter/25 px-2 py-0.5 text-[0.6rem] font-bold tracking-wide text-ink uppercase">
                  staple
                </span>
              ) : null}
              {ingredient.optionalOnly ? (
                <span className="rounded-full bg-paper px-2 py-0.5 text-[0.6rem] font-bold tracking-wide text-muted uppercase">
                  optional
                </span>
              ) : null}
              {ingredient.dinnerTitles.length > 1 ? (
                <span className="text-[0.66rem] font-normal text-muted">
                  shared by {ingredient.dinnerTitles.length} dinners
                </span>
              ) : null}
            </span>
          </span>
          <strong className="text-right text-xs text-herb-dark">
            {formatUsRecipeQuantity({
              baseUnit: ingredient.baseUnit,
              quantity: ingredient.requiredQuantityInBaseUnit,
              unit: ingredient.baseUnit,
            })}
          </strong>
        </li>
      ))}
    </ul>
  );
}

function DraftIngredientSummary({
  ingredients,
}: Readonly<{ ingredients: readonly WeeklyDraftIngredientSummary[] }>) {
  return (
    <>
      <header className="border-b border-herb-dark bg-herb p-5 text-paper-light">
        <p className="mb-2 flex items-center gap-2 text-[0.66rem] font-bold tracking-[0.14em] text-butter uppercase">
          <ShoppingBasket aria-hidden="true" size={15} />
          Live draft ingredients
        </p>
        <h3 className="m-0 text-2xl text-paper-light">
          {ingredients.length} combined ingredients
        </h3>
        <p className="mt-2 mb-0 text-xs leading-5 text-paper-light/70">
          Recipe amounts update whenever you choose a different dinner.
        </p>
      </header>
      <div className="max-h-[min(38rem,calc(100vh-15rem))] overflow-y-auto bg-paper-light">
        <DraftIngredientList ingredients={ingredients} />
      </div>
      <footer className="border-t border-rule bg-paper p-4 text-xs leading-5 text-muted">
        This summary does not check or change your pantry counts.
      </footer>
    </>
  );
}

function ProposalDraft(
  props: Extract<WeeklyPlanDraftProps, { state: "proposal" }>,
) {
  const navigation = useNavigation();
  const saving =
    navigation.state !== "idle" &&
    navigation.formData?.get("_intent") === "accept";
  const pendingRegenerationDate =
    navigation.state !== "idle" &&
    navigation.formData?.get("_intent") === "regenerate-slot"
      ? String(navigation.formData.get("slotDate"))
      : null;
  const activeSlotDate = props.activeSlotDate ?? pendingRegenerationDate;
  const slotMutationBusy = activeSlotDate !== null;
  if (saving || props.activeSave) return <GenerationProgress mode="saving" />;
  const ingredientSummary = summarizeWeeklyDraftIngredients(
    props.selectedCandidates,
  );

  return (
    <section
      aria-labelledby="weekly-proposal-title"
      className="grid scroll-mt-24 gap-5 outline-none"
      id="draft-review"
    >
      <FormError>{props.actionError}</FormError>
      {props.statusNotice === "ready" ? (
        <div className="success-note" role="status">
          <CalendarCheck2 aria-hidden="true" size={18} />
          <span>
            Your draft is ready. All five dinners and their combined ingredients
            are on this page. Nothing has been saved yet.
          </span>
        </div>
      ) : null}
      <div className="relative overflow-hidden rounded-[2rem_2rem_2rem_0.45rem] border border-ink bg-ink p-5 text-paper-light shadow-[0_1rem_2.5rem_rgba(29,42,34,0.2)] sm:p-8">
        <div
          aria-hidden="true"
          className="absolute -top-24 right-0 size-72 rounded-full border border-paper-light/10 bg-herb/30"
        />
        <div className="relative grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.55fr)] lg:items-end">
          <div>
            <p className="mb-3 flex items-center gap-2 text-[0.68rem] font-bold tracking-[0.16em] text-butter uppercase">
              <Sparkles aria-hidden="true" size={16} />
              {props.allCandidates.length} considered · 5 selected
            </p>
            <h2
              className="m-0 max-w-[15ch] text-4xl leading-[0.98] text-paper-light sm:text-5xl"
              id="weekly-proposal-title"
            >
              Your week, before it becomes the plan.
            </h2>
            <p className="mt-4 mb-0 max-w-2xl text-sm leading-7 text-paper-light/72">
              Review the ingredients and pace. Revisit any idea or create fresh
              choices for one night, then accept all five when the mix feels
              right.
            </p>
          </div>
          <PreferenceNote customized={props.preferencesCustomized} />
        </div>
      </div>

      <ReplacementNotice count={props.existingDinnerCount} />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start">
        <div className="grid gap-5">
          <section
            aria-label="Why these dinners were selected"
            className="surface grid gap-4 p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-6"
          >
            <div>
              <p className="eyebrow">The shape of this week</p>
              <p className="m-0 text-sm leading-6 text-muted">
                The planner favored variety without throwing five unrelated
                grocery lists at you.
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

          <details className="surface overflow-hidden xl:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-5 marker:hidden">
              <span className="flex items-center gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-herb text-paper-light">
                  <ShoppingBasket aria-hidden="true" size={18} />
                </span>
                <span>
                  <strong className="block text-base text-ink">
                    Ingredients for this draft
                  </strong>
                  <span className="mt-0.5 block text-xs text-muted">
                    {ingredientSummary.length} combined items, updated after
                    every choice
                  </span>
                </span>
              </span>
              <ChevronDown aria-hidden="true" className="shrink-0" size={19} />
            </summary>
            <div className="border-t border-rule">
              <DraftIngredientList ingredients={ingredientSummary} />
              <p className="m-0 border-t border-rule bg-paper p-4 text-xs leading-5 text-muted">
                This summary does not check or change your pantry counts.
              </p>
            </div>
          </details>

          <ol
            aria-label="Five proposed dinners"
            className="m-0 grid list-none gap-5 p-0"
          >
            {props.selectedCandidates.map((candidate, index) => {
              const candidateOptions = props.allCandidates.filter(
                (option) => option.slotDate === candidate.slotDate,
              );
              return (
                <CandidateCard
                  activeSlotDate={activeSlotDate}
                  candidateOptions={candidateOptions}
                  candidate={candidate}
                  changeStatus={
                    props.changedDate === candidate.slotDate &&
                    (props.statusNotice === "selected" ||
                      props.statusNotice === "regenerated")
                      ? props.statusNotice
                      : null
                  }
                  disableMutations={slotMutationBusy}
                  index={index}
                  key={candidate.candidateKey}
                  runId={props.runId}
                  weekStart={props.weekStart}
                />
              );
            })}
          </ol>
        </div>

        <aside
          aria-label="Ingredients for the selected dinner draft"
          className="surface sticky top-24 hidden overflow-hidden xl:block"
        >
          <DraftIngredientSummary ingredients={ingredientSummary} />
        </aside>
      </div>

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
          {slotMutationBusy ? (
            <button
              className="button min-w-56 border border-butter bg-butter/65 text-ink"
              disabled
              type="button"
            >
              <LoaderCircle
                aria-hidden="true"
                className="animate-spin"
                size={18}
              />
              Fresh ideas in progress
            </button>
          ) : (
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
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-herb-dark bg-herb-dark px-5 py-3 text-xs text-paper-light/65 sm:px-7">
          <span className="inline-flex items-center gap-2">
            <UsersRound aria-hidden="true" size={14} />
            Serving targets come from who is home.
          </span>
          <span>Recipe amounts do not check or change pantry counts.</span>
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
