import {
  Archive,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  ClipboardCheck,
  PackageOpen,
  RefreshCw,
  Scale,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import { data, Form, Link } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/pantry";
import { FormError, SubmitButton } from "~/components/form-controls";
import { PageHeader } from "~/components/page-header";
import {
  formatDateLabel,
  getWeekStartDate,
  parseDateOnly,
  todayInTimezone,
} from "~/domain/dates";
import { PANTRY_QUANTITY_MAX } from "~/domain/pantry";
import { formatUsRecipeQuantity } from "~/domain/us-kitchen-display";
import {
  US_RECIPE_MEASUREMENT_UNITS,
  type UsRecipeMeasurementUnit,
} from "~/domain/units";
import {
  requireIdentity,
  requireScopedDatabase,
} from "~/server/context.server";
import {
  getPantryOverview,
  PantryItemError,
  setPantryItemCount,
  type PantryCatalogItem,
  type PantryInventoryItem,
} from "~/server/data/pantry.server";

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

const pantryCountSchema = z
  .object({
    canonicalIngredientId: z.uuid(),
    intent: z.literal("count"),
    quantity: z
      .string()
      .trim()
      .min(1, "Enter the amount that is on hand.")
      .transform(Number)
      .pipe(
        z
          .number()
          .finite()
          .min(0)
          .max(PANTRY_QUANTITY_MAX),
      ),
    unit: z.enum(US_RECIPE_MEASUREMENT_UNITS),
    weekStart: dateOnlySchema,
  })
  .strict();

type ActionResult =
  | Readonly<{
      error: string;
      ingredientId: string | null;
      ok: false;
    }>
  | Readonly<{
      message: string;
      ok: true;
    }>;

type BaseUnit = PantryCatalogItem["baseUnit"];
type StorageClass = PantryCatalogItem["storageClass"];

const unitsByBaseUnit: Readonly<
  Record<BaseUnit, readonly UsRecipeMeasurementUnit[]>
> = {
  count: ["count"],
  g: ["oz", "lb"],
  ml: ["tsp", "tbsp", "cup", "fl_oz"],
};

const unitLabels: Readonly<Record<UsRecipeMeasurementUnit, string>> = {
  count: "whole items",
  cup: "cups",
  fl_oz: "fluid ounces",
  lb: "pounds",
  oz: "ounces",
  tbsp: "tablespoons",
  tsp: "teaspoons",
};

const categoryLabels: Readonly<Record<PantryCatalogItem["category"], string>> = {
  bakery: "Bakery",
  dairy: "Dairy",
  frozen: "Frozen",
  other: "Other",
  pantry: "Pantry",
  produce: "Produce",
  protein: "Protein",
  spice: "Spices",
};

const storageDetails: Readonly<
  Record<
    StorageClass,
    Readonly<{ description: string; label: string }>
  >
> = {
  counter: {
    description: "Bread, fruit, and other room-temperature items",
    label: "Counter",
  },
  freezer: {
    description: "Frozen ingredients and longer-term extras",
    label: "Freezer",
  },
  fridge: {
    description: "Cold ingredients, opened jars, and fresh food",
    label: "Fridge",
  },
  pantry: {
    description: "Dry goods, cans, bottles, and shelf-stable staples",
    label: "Pantry",
  },
};

const storageOrder: readonly StorageClass[] = [
  "pantry",
  "fridge",
  "freezer",
  "counter",
];

function displayIngredientName(name: string): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

function defaultUnit(baseUnit: BaseUnit): UsRecipeMeasurementUnit {
  if (baseUnit === "ml") return "fl_oz";
  if (baseUnit === "count") return "count";
  return "oz";
}

function formatQuantity(quantity: number, baseUnit: BaseUnit): string {
  if (quantity === 0) return "0";
  return formatUsRecipeQuantity({ quantity, unit: baseUnit });
}

function weekLabel(weekStart: string): string {
  const weekEnd = parseDateOnly(weekStart).add({ days: 6 }).toString();
  return `${formatDateLabel(weekStart, {
    month: "short",
    day: "numeric",
  })} to ${formatDateLabel(weekEnd, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;
}

export const meta: Route.MetaFunction = () => [
  { title: "Pantry inventory | Done For You Kitchen" },
  {
    name: "description",
    content:
      "Count what is on hand, update off-plan use, and check inventory against this week's recipes.",
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
    });
  }

  const today = todayInTimezone(identity.householdTimezone);
  const weekStart = getWeekStartDate(parsedWeek?.data ?? today);
  const overview = await getPantryOverview(
    requireScopedDatabase(context),
    weekStart,
  );
  const start = parseDateOnly(weekStart);
  const updatedAtFormatter = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: identity.householdTimezone,
  });

  return {
    ...overview,
    inventory: overview.inventory.map((item) => ({
      ...item,
      updatedAtLabel: updatedAtFormatter.format(item.updatedAt),
    })),
    nextWeekStart: start.add({ days: 7 }).toString(),
    previousWeekStart: start.subtract({ days: 7 }).toString(),
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  requireIdentity(context);
  const formData = await request.formData();
  const ingredientValue = formData.get("canonicalIngredientId");
  const ingredientId =
    typeof ingredientValue === "string" ? ingredientValue : null;
  const parsed = pantryCountSchema.safeParse(
    Object.fromEntries(formData.entries()),
  );

  if (!parsed.success) {
    return data<ActionResult>(
      {
        error:
          parsed.error.issues[0]?.message ??
          "Check the ingredient, amount, and measurement.",
        ingredientId,
        ok: false,
      },
      { status: 400 },
    );
  }

  try {
    const saved = await setPantryItemCount(requireScopedDatabase(context), {
      canonicalIngredientId: parsed.data.canonicalIngredientId,
      quantity: parsed.data.quantity,
      unit: parsed.data.unit,
    });
    const name = displayIngredientName(saved.ingredientName);

    return {
      message:
        parsed.data.quantity === 0
          ? `${name} is now counted as empty.`
          : `${name} inventory updated.`,
      ok: true as const,
    };
  } catch (error) {
    if (error instanceof PantryItemError) {
      return data<ActionResult>(
        { error: error.userMessage, ingredientId, ok: false },
        { status: 400 },
      );
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
  return (
    <nav
      aria-label="Pantry checklist week"
      className="flex items-center gap-2 rounded-full border border-rule bg-paper-light p-1"
    >
      <Link
        aria-label="Previous week"
        className="icon-button"
        to={`/pantry?week=${previousWeekStart}`}
      >
        <ChevronLeft aria-hidden="true" size={18} />
      </Link>
      <span className="min-w-36 px-2 text-center text-sm font-bold text-ink">
        {weekLabel(weekStart)}
      </span>
      <Link
        aria-label="Next week"
        className="icon-button"
        to={`/pantry?week=${nextWeekStart}`}
      >
        <ChevronRight aria-hidden="true" size={18} />
      </Link>
    </nav>
  );
}

function CountForm({
  defaultQuantity,
  defaultUnit: initialUnit,
  ingredient,
  weekStart,
}: Readonly<{
  defaultQuantity?: number;
  defaultUnit?: string;
  ingredient: PantryCatalogItem;
  weekStart: string;
}>) {
  const units = unitsByBaseUnit[ingredient.baseUnit];
  const selectedUnit = units.includes(
    initialUnit as UsRecipeMeasurementUnit,
  )
    ? (initialUnit as UsRecipeMeasurementUnit)
    : defaultUnit(ingredient.baseUnit);
  const formId = useId();

  return (
    <Form className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(9rem,0.7fr)_auto] sm:items-end" method="post">
      <input
        name="canonicalIngredientId"
        type="hidden"
        value={ingredient.id}
      />
      <input name="intent" type="hidden" value="count" />
      <input name="weekStart" type="hidden" value={weekStart} />
      <label className="field" htmlFor={`${formId}-quantity`}>
        <span className="field-label">Actual amount on hand</span>
        <input
          className="input"
          defaultValue={defaultQuantity}
          id={`${formId}-quantity`}
          inputMode="decimal"
          max={PANTRY_QUANTITY_MAX}
          min="0"
          name="quantity"
          placeholder="0"
          required
          step="0.001"
          type="number"
        />
      </label>
      <label className="field" htmlFor={`${formId}-unit`}>
        <span className="field-label">Measurement</span>
        <select
          className="select"
          defaultValue={selectedUnit}
          id={`${formId}-unit`}
          name="unit"
        >
          {units.map((unit) => (
            <option key={unit} value={unit}>
              {unitLabels[unit]}
            </option>
          ))}
        </select>
      </label>
      <SubmitButton
        pendingLabel="Saving count"
        pendingMatch={{
          canonicalIngredientId: ingredient.id,
          intent: "count",
        }}
      >
        <RefreshCw aria-hidden="true" size={16} />
        Save count
      </SubmitButton>
    </Form>
  );
}

function NewCountForm({
  catalog,
  weekStart,
}: Readonly<{
  catalog: readonly PantryCatalogItem[];
  weekStart: string;
}>) {
  const [ingredientId, setIngredientId] = useState("");
  const selectedIngredient = catalog.find((item) => item.id === ingredientId);
  const [unit, setUnit] = useState<UsRecipeMeasurementUnit>("oz");
  const catalogByCategory = useMemo(
    () =>
      Object.entries(categoryLabels).map(([category, label]) => ({
        category: category as PantryCatalogItem["category"],
        ingredients: catalog
          .filter((item) => item.category === category)
          .sort((left, right) => left.name.localeCompare(right.name)),
        label,
      })),
    [catalog],
  );

  const chooseIngredient = (nextIngredientId: string) => {
    setIngredientId(nextIngredientId);
    const ingredient = catalog.find((item) => item.id === nextIngredientId);
    if (ingredient) setUnit(defaultUnit(ingredient.baseUnit));
  };

  return (
    <Form className="grid gap-4" method="post">
      <input name="intent" type="hidden" value="count" />
      <input name="weekStart" type="hidden" value={weekStart} />
      <label className="field" htmlFor="new-pantry-ingredient">
        <span className="field-label">Ingredient</span>
        <select
          className="select"
          id="new-pantry-ingredient"
          name="canonicalIngredientId"
          onChange={(event) => chooseIngredient(event.currentTarget.value)}
          required
          value={ingredientId}
        >
          <option disabled value="">
            Choose from the kitchen catalog
          </option>
          {catalogByCategory.map(({ category, ingredients, label }) => (
            <optgroup key={category} label={label}>
              {ingredients.map((ingredient) => (
                <option key={ingredient.id} value={ingredient.id}>
                  {displayIngredientName(ingredient.name)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
        <label className="field" htmlFor="new-pantry-quantity">
          <span className="field-label">Actual amount on hand</span>
          <input
            className="input"
            id="new-pantry-quantity"
            inputMode="decimal"
            max={PANTRY_QUANTITY_MAX}
            min="0"
            name="quantity"
            placeholder="0"
            required
            step="0.001"
            type="number"
          />
        </label>
        <label className="field" htmlFor="new-pantry-unit">
          <span className="field-label">Measurement</span>
          <select
            className="select"
            id="new-pantry-unit"
            name="unit"
            onChange={(event) =>
              setUnit(event.currentTarget.value as UsRecipeMeasurementUnit)
            }
            value={unit}
          >
            {(selectedIngredient
              ? unitsByBaseUnit[selectedIngredient.baseUnit]
              : US_RECIPE_MEASUREMENT_UNITS
            ).map((option) => (
              <option key={option} value={option}>
                {unitLabels[option]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {selectedIngredient?.defaultPurchaseDescription ? (
        <p className="m-0 text-xs leading-5 text-muted">
          Package reference: {selectedIngredient.defaultPurchaseDescription}.
          Enter what is left, not what the package held when new.
        </p>
      ) : null}
      <SubmitButton
        pendingLabel="Saving count"
        pendingMatch={{
          canonicalIngredientId: ingredientId,
          intent: "count",
        }}
      >
        <PackageOpen aria-hidden="true" size={17} />
        Add or update item
      </SubmitButton>
    </Form>
  );
}

function RequirementCard({
  ingredient,
  inventoryItem,
  requirement,
  weekStart,
}: Readonly<{
  ingredient: PantryCatalogItem;
  inventoryItem: PantryInventoryItem | undefined;
  requirement: Route.ComponentProps["loaderData"]["requirements"][number];
  weekStart: string;
}>) {
  const status = {
    enough: {
      badge: "border-herb/30 bg-herb/10 text-herb-dark",
      copy: "The recorded amount covers these planned recipes.",
      icon: CheckCircle2,
      label: "Counted and covered",
    },
    short: {
      badge: "border-clay/35 bg-clay/10 text-clay",
      copy: `${formatQuantity(requirement.shortageQuantityInBaseUnit, ingredient.baseUnit)} more is used by the plan than is currently counted.`,
      icon: CircleAlert,
      label: "Counted below plan",
    },
    uncounted: {
      badge: "border-butter/60 bg-butter/20 text-ink",
      copy: "Count this ingredient before relying on pantry coverage.",
      icon: CircleHelp,
      label: "Not counted yet",
    },
  }[requirement.coverage];
  const StatusIcon = status.icon;

  return (
    <article className="rounded-2xl border border-rule bg-white/55 p-4 sm:p-5">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="m-0 text-xl">
              {displayIngredientName(ingredient.name)}
            </h3>
            {requirement.optionalOnly ? (
              <span className="rounded-full border border-rule bg-paper px-2 py-1 text-[0.65rem] font-bold tracking-wide text-muted uppercase">
                Optional only
              </span>
            ) : null}
            {ingredient.isStaple ? (
              <span className="rounded-full border border-herb/20 bg-herb/5 px-2 py-1 text-[0.65rem] font-bold tracking-wide text-herb uppercase">
                Staple
              </span>
            ) : null}
          </div>
          <p className="mt-2 mb-0 text-sm leading-6 text-muted">
            Used by {requirement.recipeTitles.join(", ")}
          </p>
        </div>
        <div className="text-left lg:text-right">
          <p className="m-0 text-[0.68rem] font-bold tracking-[0.12em] text-muted uppercase">
            Plan amount
          </p>
          <p className="mt-1 mb-0 font-display text-2xl text-ink">
            {formatQuantity(
              requirement.requiredQuantityInBaseUnit,
              ingredient.baseUnit,
            )}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-4">
        <div>
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold ${status.badge}`}
          >
            <StatusIcon aria-hidden="true" size={15} />
            {status.label}
          </span>
          <p className="mt-2 mb-0 text-xs leading-5 text-muted">
            {inventoryItem
              ? `${formatQuantity(inventoryItem.quantityInBaseUnit, ingredient.baseUnit)} recorded on hand. ${status.copy}`
              : status.copy}
          </p>
        </div>
        <details className="w-full rounded-xl border border-rule bg-paper-light p-3 lg:max-w-3xl">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-bold text-herb">
            <Scale aria-hidden="true" size={16} />
            {inventoryItem ? "Update actual amount" : "Count what is here"}
          </summary>
          <div className="mt-4">
            <CountForm
              defaultQuantity={inventoryItem?.quantity}
              defaultUnit={inventoryItem?.unit}
              ingredient={ingredient}
              weekStart={weekStart}
            />
          </div>
        </details>
      </div>
    </article>
  );
}

export default function PantryPage({
  actionData,
  loaderData,
}: Route.ComponentProps) {
  const catalogById = new Map(
    loaderData.catalog.map((ingredient) => [ingredient.id, ingredient]),
  );
  const inventoryById = new Map(
    loaderData.inventory.map((item) => [item.id, item]),
  );
  const requirements = loaderData.requirements
    .flatMap((requirement) => {
      const ingredient = catalogById.get(requirement.canonicalIngredientId);
      return ingredient ? [{ ingredient, requirement }] : [];
    })
    .sort((left, right) => {
      const coverageOrder = { uncounted: 0, short: 1, enough: 2 } as const;
      return (
        coverageOrder[left.requirement.coverage] -
          coverageOrder[right.requirement.coverage] ||
        left.ingredient.name.localeCompare(right.ingredient.name)
      );
    });
  const positiveInventory = loaderData.inventory.filter(
    (item) => item.quantityInBaseUnit > 0,
  );
  const uncountedCount = loaderData.requirements.filter(
    (requirement) => requirement.coverage === "uncounted",
  ).length;
  const shortCount = loaderData.requirements.filter(
    (requirement) => requirement.coverage === "short",
  ).length;
  const coveredCount = loaderData.requirements.filter(
    (requirement) => requirement.coverage === "enough",
  ).length;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        actions={
          <WeekNavigation
            nextWeekStart={loaderData.nextWeekStart}
            previousWeekStart={loaderData.previousWeekStart}
            weekStart={loaderData.weekStart}
          />
        }
        description="Count the food that is actually available, then update it whenever the household uses something outside the plan. This week's recipes narrow the first inventory to what matters now."
        eyebrow="Kitchen inventory"
        title="Know what is really on hand."
      />

      {actionData?.ok ? (
        <div className="success-note mb-5" role="status">
          <CheckCircle2 aria-hidden="true" size={18} />
          <span>{actionData.message}</span>
        </div>
      ) : actionData ? (
        <div className="mb-5">
          <FormError>{actionData.error}</FormError>
        </div>
      ) : null}

      <section className="relative mb-6 overflow-hidden rounded-[1.8rem_1.8rem_1.8rem_0.45rem] border border-herb-dark bg-herb p-5 text-paper-light shadow-[0_0.9rem_2.4rem_rgba(29,42,34,0.16)] sm:p-7">
        <div
          aria-hidden="true"
          className="absolute inset-y-0 right-0 hidden w-1/3 opacity-20 sm:block"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, transparent 0 44px, rgba(251,248,240,.35) 44px 46px)",
          }}
        />
        <div className="relative grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(24rem,0.8fr)] lg:items-end">
          <div>
            <p className="mb-2 flex items-center gap-2 text-[0.68rem] font-bold tracking-[0.15em] text-butter uppercase">
              <ClipboardCheck aria-hidden="true" size={15} />
              A living count
            </p>
            <h2 className="m-0 max-w-xl text-3xl leading-tight text-paper-light sm:text-4xl">
              Plans suggest what to check. People keep the count honest.
            </h2>
            <p className="mt-3 mb-0 max-w-2xl text-sm leading-6 text-paper-light/75">
              Scheduling a recipe never subtracts food automatically. If mayo
              goes into sandwiches or an ingredient spills, enter the amount
              that remains and the next plan check will use that count.
            </p>
          </div>
          <dl className="m-0 grid grid-cols-3 gap-2">
            {[
              [String(positiveInventory.length), "on hand"],
              [String(uncountedCount), "to count"],
              [String(coveredCount), "covered"],
            ].map(([value, label]) => (
              <div
                className="rounded-2xl border border-paper-light/20 bg-paper-light/10 p-3 text-center backdrop-blur-sm"
                key={label}
              >
                <dt className="mt-1 text-[0.65rem] font-bold tracking-[0.1em] text-paper-light/65 uppercase">
                  {label}
                </dt>
                <dd className="m-0 font-display text-3xl text-butter">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(20rem,0.45fr)]">
        <section className="surface overflow-hidden" aria-labelledby="week-check-title">
          <header className="border-b border-rule bg-butter/20 p-5 sm:p-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="eyebrow">First inventory shortcut</p>
                <h2 className="m-0 text-3xl" id="week-check-title">
                  Check this week's ingredients
                </h2>
                <p className="mt-2 mb-0 max-w-2xl text-sm leading-6 text-muted">
                  Start with the ingredients used by planned recipes. Anything
                  not counted stays unknown rather than being treated as empty.
                </p>
              </div>
              {shortCount > 0 ? (
                <span className="rounded-full border border-clay/35 bg-clay/10 px-3 py-1.5 text-xs font-bold text-clay">
                  {shortCount} counted below plan
                </span>
              ) : null}
            </div>
          </header>

          {requirements.length > 0 ? (
            <div className="grid gap-3 p-4 sm:p-6">
              {requirements.map(({ ingredient, requirement }) => (
                <RequirementCard
                  ingredient={ingredient}
                  inventoryItem={inventoryById.get(ingredient.id)}
                  key={ingredient.id}
                  requirement={requirement}
                  weekStart={loaderData.weekStart}
                />
              ))}
            </div>
          ) : (
            <div className="empty-state m-4 sm:m-6">
              <div>
                <Archive
                  aria-hidden="true"
                  className="mx-auto mb-3 text-herb"
                  size={34}
                />
                <h2>No recipe ingredients to check yet</h2>
                <p>
                  Plan at least one dinner for this week. Its ingredients will
                  appear here as a focused inventory checklist.
                </p>
                <Link
                  className="button button-primary"
                  to={`/?week=${loaderData.weekStart}`}
                >
                  View this week
                </Link>
              </div>
            </div>
          )}
        </section>

        <aside className="surface overflow-hidden xl:sticky xl:top-24">
          <header className="border-b border-rule bg-ink p-5 text-paper-light">
            <p className="mb-2 flex items-center gap-2 text-[0.68rem] font-bold tracking-[0.13em] text-butter uppercase">
              <PackageOpen aria-hidden="true" size={15} />
              Whole kitchen
            </p>
            <h2 className="m-0 text-2xl text-paper-light">
              Count another ingredient
            </h2>
            <p className="mt-2 mb-0 text-xs leading-5 text-paper-light/65">
              Add food that is not part of this week's recipes, or correct an
              existing count directly.
            </p>
          </header>
          <div className="p-5">
            <NewCountForm
              catalog={loaderData.catalog}
              weekStart={loaderData.weekStart}
            />
          </div>
        </aside>
      </div>

      <section className="mt-7" aria-labelledby="inventory-title">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="eyebrow">Current count</p>
            <h2 className="m-0 text-3xl" id="inventory-title">
              What is on hand now
            </h2>
          </div>
          <p className="m-0 max-w-lg text-right text-xs leading-5 text-muted">
            Zero counts remain recorded for future recipe checks but stay out
            of this on-hand list.
          </p>
        </div>

        {positiveInventory.length > 0 ? (
          <div className="grid gap-5 lg:grid-cols-2">
            {storageOrder.map((storageClass) => {
              const items = positiveInventory.filter(
                (item) => item.storageClass === storageClass,
              );
              if (items.length === 0) return null;
              const details = storageDetails[storageClass];

              return (
                <section className="surface overflow-hidden" key={storageClass}>
                  <header className="flex items-center justify-between gap-3 border-b border-rule bg-paper-light p-5">
                    <div>
                      <h3 className="m-0 text-2xl">{details.label}</h3>
                      <p className="mt-1 mb-0 text-xs text-muted">
                        {details.description}
                      </p>
                    </div>
                    <span className="grid size-11 place-items-center rounded-full border border-ink bg-butter font-display text-xl text-ink shadow-[2px_2px_0_#1d2a22]">
                      {items.length}
                    </span>
                  </header>
                  <ul className="m-0 grid list-none p-0">
                    {items.map((item) => (
                      <li
                        className="border-b border-rule p-4 last:border-b-0 sm:p-5"
                        key={item.id}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <strong className="text-sm text-ink">
                              {displayIngredientName(item.name)}
                            </strong>
                            <span className="mt-1 block text-xs text-muted">
                              Updated {item.updatedAtLabel}
                            </span>
                          </div>
                          <span className="shrink-0 rounded-full bg-herb px-3 py-1.5 text-xs font-bold text-paper-light">
                            {formatQuantity(
                              item.quantityInBaseUnit,
                              item.baseUnit,
                            )}
                          </span>
                        </div>
                        <details className="mt-3 rounded-xl border border-rule bg-white/55 p-3">
                          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-bold text-herb">
                            <RefreshCw aria-hidden="true" size={15} />
                            Update after use or restocking
                          </summary>
                          <div className="mt-4 grid gap-3">
                            <CountForm
                              defaultQuantity={item.quantity}
                              defaultUnit={item.unit}
                              ingredient={item}
                              weekStart={loaderData.weekStart}
                            />
                            <Form method="post">
                              <input
                                name="canonicalIngredientId"
                                type="hidden"
                                value={item.id}
                              />
                              <input name="intent" type="hidden" value="count" />
                              <input name="quantity" type="hidden" value="0" />
                              <input name="unit" type="hidden" value={item.unit} />
                              <input
                                name="weekStart"
                                type="hidden"
                                value={loaderData.weekStart}
                              />
                              <SubmitButton
                                className="button button-danger"
                                pendingLabel="Marking empty"
                                pendingMatch={{
                                  canonicalIngredientId: item.id,
                                  intent: "count",
                                  quantity: "0",
                                }}
                              >
                                Mark as empty
                              </SubmitButton>
                            </Form>
                          </div>
                        </details>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        ) : (
          <div className="empty-state">
            <div>
              <PackageOpen
                aria-hidden="true"
                className="mx-auto mb-3 text-herb"
                size={34}
              />
              <h2>No on-hand amounts recorded</h2>
              <p>
                Use the weekly checklist or the catalog form above to start the
                household's first kitchen count.
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
