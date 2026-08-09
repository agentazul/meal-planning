import {
  ArrowDown,
  ArrowUp,
  CirclePlus,
  Scale,
  Trash2,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Form, Link } from "react-router";

import { Field, FormError, SubmitButton } from "~/components/form-controls";
import {
  convertToCanonical,
  US_RECIPE_MEASUREMENT_UNITS,
  UnitConversionError,
  type UsRecipeMeasurementUnit,
} from "~/domain/units";

export type RecipeFormIngredient = Readonly<{
  baseUnit: "g" | "ml" | "count";
  category:
    | "produce"
    | "protein"
    | "dairy"
    | "pantry"
    | "spice"
    | "frozen"
    | "bakery"
    | "other";
  densityGramsPerMl: number | null;
  gramsPerCount: number | null;
  id: string;
  name: string;
}>;

type IngredientRow = Readonly<{
  canonicalIngredientId: string;
  isOptional: boolean;
  key: number;
  preparation: string;
  quantity: string;
  scalesLinearly: boolean;
  unit: UsRecipeMeasurementUnit;
}>;

type RecipeFormProps = Readonly<{
  error?: string | null;
  ingredients: readonly RecipeFormIngredient[];
}>;

const unitLabels: Readonly<Record<UsRecipeMeasurementUnit, string>> = {
  oz: "ounces (oz)",
  lb: "pounds (lb)",
  tsp: "teaspoons (tsp)",
  tbsp: "tablespoons (tbsp)",
  cup: "cups",
  fl_oz: "fluid ounces",
  count: "whole items",
};

function defaultUnitFor(
  ingredient: RecipeFormIngredient | undefined,
): UsRecipeMeasurementUnit {
  if (ingredient?.baseUnit === "ml") return "fl_oz";
  if (ingredient?.baseUnit === "count") return "count";
  return "oz";
}

function compatibleUnitHelp(ingredient: RecipeFormIngredient): string {
  if (ingredient.baseUnit === "ml") {
    return "Choose teaspoons, tablespoons, cups, or fluid ounces.";
  }
  if (ingredient.baseUnit === "count") return "Choose whole items.";
  return "Choose ounces or pounds.";
}

function createIngredientRow(
  key: number,
  ingredient?: RecipeFormIngredient,
): IngredientRow {
  return {
    canonicalIngredientId: ingredient?.id ?? "",
    isOptional: false,
    key,
    preparation: "",
    quantity: "1",
    scalesLinearly: true,
    unit: defaultUnitFor(ingredient),
  };
}

function SectionHeading({
  description,
  number,
  title,
}: Readonly<{ description: string; number: string; title: string }>) {
  return (
    <div className="mb-6 flex items-start gap-3 border-b border-rule pb-4">
      <span
        className="grid size-9 shrink-0 place-items-center rounded-full border border-ink bg-butter font-display text-lg leading-none text-ink shadow-[2px_2px_0_#1d2a22]"
        aria-hidden="true"
      >
        {number}
      </span>
      <div>
        <h2 className="m-0 text-2xl leading-none text-ink">{title}</h2>
        <p className="mt-2 mb-0 max-w-2xl text-sm leading-6 text-muted">
          {description}
        </p>
      </div>
    </div>
  );
}

function getConversionPreview(
  row: IngredientRow,
  ingredient: RecipeFormIngredient | undefined,
): Readonly<{ error: boolean; text: string }> {
  const quantity = Number(row.quantity);

  if (!ingredient || !Number.isFinite(quantity) || quantity <= 0) {
    return {
      error: true,
      text: "Choose an ingredient and enter a positive quantity.",
    };
  }

  try {
    convertToCanonical({
      canonicalUnit: ingredient.baseUnit,
      densityGPerMl: ingredient.densityGramsPerMl,
      gramsPerCount: ingredient.gramsPerCount,
      quantity,
      unit: row.unit,
    });

    return {
      error: false,
      text: "US amount is ready for planning and shopping.",
    };
  } catch (error) {
    if (error instanceof UnitConversionError) {
      if (error.code === "MISSING_DENSITY") {
        return {
          error: true,
          text: `Density is not recorded for ${ingredient.name}. ${compatibleUnitHelp(ingredient)}`,
        };
      }

      if (error.code === "MISSING_GRAMS_PER_COUNT") {
        return {
          error: true,
          text: `Per-item weight is not recorded for ${ingredient.name}. ${compatibleUnitHelp(ingredient)}`,
        };
      }
    }

    return {
      error: true,
      text: `That unit does not fit ${ingredient.name}. ${compatibleUnitHelp(ingredient)}`,
    };
  }
}

export function RecipeForm({ error, ingredients }: RecipeFormProps) {
  const nextKey = useRef(2);
  const [rows, setRows] = useState<readonly IngredientRow[]>([
    createIngredientRow(1, ingredients[0]),
  ]);

  const ingredientById = useMemo(
    () => new Map(ingredients.map((ingredient) => [ingredient.id, ingredient])),
    [ingredients],
  );

  const ingredientGroups = useMemo(() => {
    const grouped = new Map<
      RecipeFormIngredient["category"],
      RecipeFormIngredient[]
    >();

    for (const ingredient of ingredients) {
      const group = grouped.get(ingredient.category) ?? [];
      group.push(ingredient);
      grouped.set(ingredient.category, group);
    }

    return [...grouped.entries()];
  }, [ingredients]);

  function updateRow(key: number, update: Partial<IngredientRow>) {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...update } : row)),
    );
  }

  function addRow() {
    const key = nextKey.current;
    nextKey.current += 1;
    setRows((current) => [
      ...current,
      createIngredientRow(key, ingredients[0]),
    ]);
  }

  function removeRow(key: number) {
    setRows((current) =>
      current.length === 1 ? current : current.filter((row) => row.key !== key),
    );
  }

  function moveRow(index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= rows.length) {
      return;
    }

    setRows((current) => {
      const next = [...current];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
  }

  const serializedRows = JSON.stringify(
    rows.map((row) => ({
      canonicalIngredientId: row.canonicalIngredientId,
      isOptional: row.isOptional,
      preparation: row.preparation,
      quantity: row.quantity,
      scalesLinearly: row.scalesLinearly,
      unit: row.unit,
    })),
  );

  return (
    <Form className="grid gap-5" method="post">
      <input
        name="ingredientsJson"
        readOnly
        type="hidden"
        value={serializedRows}
      />

      <section className="surface overflow-hidden p-4 sm:p-6">
        <SectionHeading
          description="Name the dish and record the effort it asks of a real weeknight."
          number="1"
          title="Basics"
        />

        <div className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <Field htmlFor="title" label="Recipe title">
              <input
                autoFocus
                className="input"
                id="title"
                maxLength={160}
                name="title"
                placeholder="Lemony chicken with crispy potatoes"
                required
              />
            </Field>
          </div>

          <div className="md:col-span-2">
            <Field htmlFor="description" label="Short description">
              <textarea
                className="textarea min-h-24"
                id="description"
                maxLength={5_000}
                name="description"
                placeholder="What makes this dinner worth repeating?"
              />
            </Field>
          </div>

          <Field htmlFor="baseServings" label="Base servings">
            <input
              className="input"
              id="baseServings"
              inputMode="numeric"
              min="1"
              name="baseServings"
              required
              step="1"
              type="number"
              defaultValue="4"
            />
          </Field>

          <Field htmlFor="effortTier" label="Effort">
            <select
              className="select"
              defaultValue="weeknight"
              id="effortTier"
              name="effortTier"
            >
              <option value="weeknight">Weeknight</option>
              <option value="weekend">Weekend</option>
              <option value="project">Project</option>
            </select>
          </Field>

          <Field htmlFor="activeTimeMinutes" label="Active minutes">
            <input
              className="input"
              defaultValue="20"
              id="activeTimeMinutes"
              inputMode="numeric"
              min="0"
              name="activeTimeMinutes"
              required
              step="1"
              type="number"
            />
          </Field>

          <Field htmlFor="totalTimeMinutes" label="Total minutes">
            <input
              className="input"
              defaultValue="40"
              id="totalTimeMinutes"
              inputMode="numeric"
              min="0"
              name="totalTimeMinutes"
              required
              step="1"
              type="number"
            />
          </Field>

          <Field htmlFor="cuisine" label="Cuisine">
            <input
              className="input"
              id="cuisine"
              maxLength={100}
              name="cuisine"
              placeholder="Mediterranean"
            />
          </Field>

          <Field htmlFor="primaryProtein" label="Primary protein">
            <input
              className="input"
              id="primaryProtein"
              maxLength={100}
              name="primaryProtein"
              placeholder="Chicken thighs"
            />
          </Field>

          <div className="md:col-span-2">
            <Field
              help="Separate techniques with commas."
              htmlFor="techniques"
              label="Techniques"
            >
              <input
                className="input"
                id="techniques"
                maxLength={1_000}
                name="techniques"
                placeholder="sheet pan, pan sauce, roasting"
              />
            </Field>
          </div>
        </div>
      </section>

      <section className="surface overflow-hidden p-4 sm:p-6">
        <SectionHeading
          description="Use familiar US recipe units. Planning and shopping calculations happen behind the scenes."
          number="2"
          title="Ingredients"
        />

        <div className="grid gap-4">
          {rows.map((row, index) => {
            const ingredient = ingredientById.get(row.canonicalIngredientId);
            const preview = getConversionPreview(row, ingredient);
            const rowName = ingredient?.name ?? `ingredient ${index + 1}`;
            const fieldPrefix = `ingredient-${row.key}`;

            return (
              <fieldset
                className="relative m-0 grid gap-4 rounded-2xl border border-rule bg-white/55 p-4 pt-11 sm:grid-cols-12 sm:pt-4"
                key={row.key}
              >
                <legend className="sr-only">Ingredient {index + 1}</legend>

                <span className="absolute top-3 left-4 rounded-full bg-ink px-2.5 py-1 text-[0.68rem] font-bold tracking-[0.12em] text-paper-light uppercase sm:top-4">
                  {String(index + 1).padStart(2, "0")}
                </span>

                <div className="absolute top-2 right-2 flex items-center gap-0.5 sm:top-3 sm:right-3">
                  <button
                    aria-label={`Move ${rowName} up`}
                    className="button button-quiet !size-9 !min-h-0 !p-0"
                    disabled={index === 0}
                    onClick={() => moveRow(index, -1)}
                    title="Move up"
                    type="button"
                  >
                    <ArrowUp aria-hidden="true" size={16} />
                  </button>
                  <button
                    aria-label={`Move ${rowName} down`}
                    className="button button-quiet !size-9 !min-h-0 !p-0"
                    disabled={index === rows.length - 1}
                    onClick={() => moveRow(index, 1)}
                    title="Move down"
                    type="button"
                  >
                    <ArrowDown aria-hidden="true" size={16} />
                  </button>
                  <button
                    aria-label={`Remove ${rowName}`}
                    className="button button-danger !size-9 !min-h-0 !p-0"
                    disabled={rows.length === 1}
                    onClick={() => removeRow(row.key)}
                    title="Remove ingredient"
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={16} />
                  </button>
                </div>

                <div className="sm:col-span-6 sm:mt-11 lg:mt-0">
                  <Field
                    htmlFor={`${fieldPrefix}-canonical`}
                    label="Canonical ingredient"
                  >
                    <select
                      className="select"
                      id={`${fieldPrefix}-canonical`}
                      name={`${fieldPrefix}-canonicalIngredientId`}
                      onChange={(event) => {
                        const selected = ingredientById.get(event.target.value);
                        updateRow(row.key, {
                          canonicalIngredientId: event.target.value,
                          unit: defaultUnitFor(selected),
                        });
                      }}
                      required
                      value={row.canonicalIngredientId}
                    >
                      {ingredients.length === 0 ? (
                        <option value="">No ingredients available</option>
                      ) : null}
                      {ingredientGroups.map(([category, options]) => (
                        <optgroup
                          key={category}
                          label={category.charAt(0).toUpperCase() + category.slice(1)}
                        >
                          {options.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </Field>
                </div>

                <div className="grid grid-cols-2 gap-3 sm:col-span-6 sm:mt-11 lg:mt-0">
                  <Field htmlFor={`${fieldPrefix}-quantity`} label="Quantity">
                    <input
                      aria-describedby={`${fieldPrefix}-conversion`}
                      className="input"
                      id={`${fieldPrefix}-quantity`}
                      inputMode="decimal"
                      min="0.001"
                      name={`${fieldPrefix}-quantity`}
                      onChange={(event) =>
                        updateRow(row.key, { quantity: event.target.value })
                      }
                      required
                      step="0.001"
                      type="number"
                      value={row.quantity}
                    />
                  </Field>

                  <Field htmlFor={`${fieldPrefix}-unit`} label="Unit">
                    <select
                      aria-describedby={`${fieldPrefix}-conversion`}
                      className="select"
                      id={`${fieldPrefix}-unit`}
                      name={`${fieldPrefix}-unit`}
                      onChange={(event) =>
                        updateRow(row.key, {
                          unit: event.target.value as UsRecipeMeasurementUnit,
                        })
                      }
                      value={row.unit}
                    >
                      {US_RECIPE_MEASUREMENT_UNITS.map((unit) => (
                        <option key={unit} value={unit}>
                          {unitLabels[unit]}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                <div className="sm:col-span-7">
                  <Field
                    htmlFor={`${fieldPrefix}-preparation`}
                    label="Preparation"
                  >
                    <input
                      className="input"
                      id={`${fieldPrefix}-preparation`}
                      maxLength={120}
                      name={`${fieldPrefix}-preparation`}
                      onChange={(event) =>
                        updateRow(row.key, { preparation: event.target.value })
                      }
                      placeholder="diced, divided, zested"
                      value={row.preparation}
                    />
                  </Field>
                </div>

                <div className="grid content-end gap-2 sm:col-span-5">
                  <label className="flex min-h-8 items-center gap-2 text-sm text-ink">
                    <input
                      checked={row.isOptional}
                      className="size-4 accent-herb"
                      name={`${fieldPrefix}-isOptional`}
                      onChange={(event) =>
                        updateRow(row.key, { isOptional: event.target.checked })
                      }
                      type="checkbox"
                    />
                    Optional garnish or extra
                  </label>
                  <label className="flex min-h-8 items-center gap-2 text-sm text-ink">
                    <input
                      checked={row.scalesLinearly}
                      className="size-4 accent-herb"
                      name={`${fieldPrefix}-scalesLinearly`}
                      onChange={(event) =>
                        updateRow(row.key, {
                          scalesLinearly: event.target.checked,
                        })
                      }
                      type="checkbox"
                    />
                    Scale with serving count
                  </label>
                </div>

                <div
                  className={`flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs leading-5 sm:col-span-12 ${
                    preview.error
                      ? "bg-clay/10 text-clay"
                      : "bg-herb/10 text-herb-dark"
                  }`}
                  id={`${fieldPrefix}-conversion`}
                  role="status"
                >
                  <Scale aria-hidden="true" className="mt-0.5 shrink-0" size={15} />
                  <span>
                    <strong className="font-semibold">Planning check:</strong>{" "}
                    {preview.text}
                  </span>
                </div>
              </fieldset>
            );
          })}
        </div>

        <button
          className="button button-secondary mt-4 w-full border-dashed sm:w-auto"
          onClick={addRow}
          type="button"
        >
          <CirclePlus aria-hidden="true" size={18} />
          Add ingredient
        </button>
      </section>

      <section className="surface overflow-hidden p-4 sm:p-6">
        <SectionHeading
          description="Write one instruction per line. We will preserve this order as numbered steps."
          number="3"
          title="Instructions"
        />
        <Field
          help="Blank lines are ignored. Start each line with the action, not a number."
          htmlFor="instructions"
          label="Method"
        >
          <textarea
            className="textarea min-h-64 font-mono text-sm"
            id="instructions"
            maxLength={100_000}
            name="instructions"
            placeholder={"Heat the oven to 425°F.\nSeason the chicken on both sides.\nRoast until browned and cooked through."}
            required
          />
        </Field>
      </section>

      <section className="surface overflow-hidden p-4 sm:p-6">
        <SectionHeading
          description="Record a target only when the dish needs a measured internal temperature."
          number="4"
          title="Food safety"
        />
        <div className="max-w-sm">
          <Field
            help="Optional. Enter a value from 32°F to 500°F."
            htmlFor="minInternalTemperatureF"
            label="Minimum internal temperature"
          >
            <div className="relative">
              <input
                className="input pr-12"
                id="minInternalTemperatureF"
                inputMode="numeric"
                max="500"
                min="32"
                name="minInternalTemperatureF"
                placeholder="165"
                step="1"
                type="number"
              />
              <span className="pointer-events-none absolute inset-y-0 right-4 grid place-items-center text-sm font-semibold text-muted">
                °F
              </span>
            </div>
          </Field>
        </div>
      </section>

      <FormError>{error}</FormError>

      <div className="sticky bottom-[5.8rem] z-20 flex flex-col-reverse gap-2 rounded-2xl border border-rule bg-paper-light/95 p-3 shadow-[0_1rem_2.5rem_rgba(29,42,34,0.18)] backdrop-blur sm:static sm:flex-row sm:justify-end sm:bg-transparent sm:p-0 sm:shadow-none">
        <Link className="button button-secondary" to="/recipes">
          Cancel
        </Link>
        <SubmitButton pendingLabel="Saving recipe">Save recipe</SubmitButton>
      </div>
    </Form>
  );
}
