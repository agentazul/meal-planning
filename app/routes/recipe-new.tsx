import { ArrowLeft } from "lucide-react";
import { Link, redirect } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/recipe-new";
import { RecipeForm } from "~/components/recipe-form";
import { PageHeader } from "~/components/page-header";
import {
  convertToCanonical,
  US_RECIPE_MEASUREMENT_UNITS,
  UnitConversionError,
} from "~/domain/units";
import {
  createHouseholdRecipe,
  listIngredientReferences,
  type RecipeIngredientInput,
} from "~/server/data/recipes.server";
import { requireScopedDatabase } from "~/server/context.server";

const positiveIntegerField = z
  .string()
  .trim()
  .regex(/^\d+$/, "Enter a whole number.")
  .transform(Number)
  .pipe(z.number().int().min(1).max(10_000));

const nonnegativeIntegerField = z
  .string()
  .trim()
  .regex(/^\d+$/, "Enter a whole number.")
  .transform(Number)
  .pipe(z.number().int().min(0).max(10_080));

const optionalTemperatureField = z
  .string()
  .trim()
  .refine(
    (value) => value === "" || /^\d+$/.test(value),
    "Enter a whole temperature.",
  )
  .transform((value) => (value === "" ? null : Number(value)))
  .pipe(z.number().int().min(32).max(500).nullable());

const recipeFormSchema = z
  .object({
    activeTimeMinutes: nonnegativeIntegerField,
    baseServings: positiveIntegerField,
    cuisine: z.string().trim().max(100),
    description: z.string().trim().max(5_000),
    effortTier: z.enum(["weeknight", "weekend", "project"]),
    ingredientsJson: z.string().min(1).max(200_000),
    instructions: z.string().trim().min(1, "Add at least one instruction.").max(100_000),
    minInternalTemperatureF: optionalTemperatureField,
    primaryProtein: z.string().trim().max(100),
    techniques: z.string().trim().max(1_000),
    title: z.string().trim().min(1, "Add a recipe title.").max(160),
    totalTimeMinutes: nonnegativeIntegerField,
  })
  .strict();

const positiveQuantityField = z
  .string()
  .trim()
  .refine(
    (value) => {
      const quantity = Number(value);
      return value !== "" && Number.isFinite(quantity) && quantity > 0;
    },
    "Quantity must be a positive number.",
  )
  .transform(Number)
  .pipe(z.number().min(0.001).max(99_999_999_999));

const ingredientRowSchema = z
  .object({
    canonicalIngredientId: z.uuid(),
    isOptional: z.boolean(),
    preparation: z.string().trim().max(120),
    quantity: positiveQuantityField,
    scalesLinearly: z.boolean(),
    unit: z.enum(US_RECIPE_MEASUREMENT_UNITS),
  })
  .strict();

const ingredientRowsSchema = z.array(ingredientRowSchema).min(1).max(100);

export const meta: Route.MetaFunction = () => [
  { title: "New recipe | Done For You Kitchen" },
  {
    name: "description",
    content: "Add a household recipe with familiar US ingredient quantities.",
  },
];

export async function loader({ context }: Route.LoaderArgs) {
  const scoped = requireScopedDatabase(context);
  return { ingredients: await listIngredientReferences(scoped) };
}

function firstIssue(
  result: Readonly<{ issues: readonly Readonly<{ message: string }>[] }>,
): string {
  return result.issues[0]?.message ?? "Check the recipe fields and try again.";
}

function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function conversionMessage(error: UnitConversionError): string {
  switch (error.code) {
    case "MISSING_DENSITY":
      return "that unit needs density data which is not recorded";
    case "MISSING_GRAMS_PER_COUNT":
      return "that unit needs a per-item weight which is not recorded";
    case "UNSUPPORTED_CONVERSION":
    case "UNSUPPORTED_UNIT":
      return "that measurement unit is not supported for this ingredient";
    default:
      return "the quantity could not be converted safely";
  }
}

export async function action({ context, request }: Route.ActionArgs) {
  const formData = await request.formData();
  const parsedForm = recipeFormSchema.safeParse({
    activeTimeMinutes: formData.get("activeTimeMinutes"),
    baseServings: formData.get("baseServings"),
    cuisine: formData.get("cuisine"),
    description: formData.get("description"),
    effortTier: formData.get("effortTier"),
    ingredientsJson: formData.get("ingredientsJson"),
    instructions: formData.get("instructions"),
    minInternalTemperatureF: formData.get("minInternalTemperatureF"),
    primaryProtein: formData.get("primaryProtein"),
    techniques: formData.get("techniques"),
    title: formData.get("title"),
    totalTimeMinutes: formData.get("totalTimeMinutes"),
  });

  if (!parsedForm.success) {
    return { error: firstIssue(parsedForm.error) };
  }

  if (parsedForm.data.activeTimeMinutes > parsedForm.data.totalTimeMinutes) {
    return { error: "Active time cannot be longer than total time." };
  }

  let ingredientPayload: unknown;
  try {
    ingredientPayload = JSON.parse(parsedForm.data.ingredientsJson) as unknown;
  } catch {
    return { error: "Ingredient rows could not be read. Refresh and try again." };
  }

  const parsedIngredients = ingredientRowsSchema.safeParse(ingredientPayload);
  if (!parsedIngredients.success) {
    return { error: firstIssue(parsedIngredients.error) };
  }

  const instructions = parsedForm.data.instructions
    .split(/\r?\n/)
    .map((instruction) => instruction.trim())
    .filter((instruction) => instruction.length > 0)
    .map((instruction, index) => ({
      instruction,
      position: index + 1,
    }));

  if (instructions.length === 0) {
    return { error: "Add at least one instruction on its own line." };
  }

  const scoped = requireScopedDatabase(context);
  const ingredientReferences = await listIngredientReferences(scoped);
  const ingredientById = new Map(
    ingredientReferences.map((ingredient) => [ingredient.id, ingredient]),
  );
  const convertedIngredients: RecipeIngredientInput[] = [];

  for (const [index, ingredientInput] of parsedIngredients.data.entries()) {
    const ingredient = ingredientById.get(
      ingredientInput.canonicalIngredientId,
    );

    if (!ingredient) {
      return {
        error: `Ingredient ${index + 1} is not in the canonical ingredient list.`,
      };
    }

    try {
      const converted = convertToCanonical({
        canonicalUnit: ingredient.baseUnit,
        densityGPerMl: ingredient.densityGramsPerMl,
        gramsPerCount: ingredient.gramsPerCount,
        quantity: ingredientInput.quantity,
        unit: ingredientInput.unit,
      });
      const roundedCanonicalQuantity = Number(converted.quantity.toFixed(3));

      if (
        !Number.isFinite(roundedCanonicalQuantity) ||
        roundedCanonicalQuantity <= 0 ||
        roundedCanonicalQuantity > 99_999_999_999
      ) {
        return {
          error: `${ingredient.name} converts to a quantity outside the supported range.`,
        };
      }

      convertedIngredients.push({
        canonicalIngredientId: ingredient.id,
        isOptional: ingredientInput.isOptional,
        preparation: optionalText(ingredientInput.preparation),
        quantity: ingredientInput.quantity,
        quantityInBaseUnit: roundedCanonicalQuantity,
        scalesLinearly: ingredientInput.scalesLinearly,
        unit: ingredientInput.unit,
      });
    } catch (error) {
      const detail =
        error instanceof UnitConversionError
          ? conversionMessage(error)
          : "the quantity could not be converted";

      return {
        error: `${ingredient.name}: ${detail}. Choose a compatible US unit or update the quantity.`,
      };
    }
  }

  const techniques = [
    ...new Set(
      parsedForm.data.techniques
        .split(",")
        .map((technique) => technique.trim())
        .filter((technique) => technique.length > 0),
    ),
  ];

  const recipeId = await createHouseholdRecipe(scoped, {
    activeTimeMinutes: parsedForm.data.activeTimeMinutes,
    baseServings: parsedForm.data.baseServings,
    cuisine: optionalText(parsedForm.data.cuisine),
    description: optionalText(parsedForm.data.description),
    effortTier: parsedForm.data.effortTier,
    ingredients: convertedIngredients,
    instructions,
    minInternalTemperatureF: parsedForm.data.minInternalTemperatureF,
    primaryProtein: optionalText(parsedForm.data.primaryProtein),
    source: "manual",
    techniques,
    title: parsedForm.data.title,
    totalTimeMinutes: parsedForm.data.totalTimeMinutes,
  });

  throw redirect(`/recipes/${recipeId}`);
}

export default function NewRecipe({
  actionData,
  loaderData,
}: Route.ComponentProps) {
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        actions={
          <Link className="button button-secondary" to="/recipes">
            <ArrowLeft aria-hidden="true" size={17} />
            Recipe library
          </Link>
        }
        description={`Build from ${loaderData.ingredients.length} pantry ingredients so every amount can carry into planning and shopping later.`}
        eyebrow="Manual entry"
        title="Write the recipe once."
      />

      <RecipeForm
        error={actionData?.error}
        ingredients={loaderData.ingredients}
      />
    </div>
  );
}
