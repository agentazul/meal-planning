import { z } from "zod";

export const INGREDIENT_CATEGORIES = [
  "produce",
  "protein",
  "dairy",
  "pantry",
  "spice",
  "frozen",
  "bakery",
  "other",
] as const;

export const BASE_UNITS = ["g", "ml", "count"] as const;
export const STORAGE_CLASSES = ["pantry", "fridge", "freezer", "counter"] as const;

export type IngredientCategory = (typeof INGREDIENT_CATEGORIES)[number];
export type BaseUnit = (typeof BASE_UNITS)[number];
export type StorageClass = (typeof STORAGE_CLASSES)[number];

export const INGREDIENT_CATEGORY_QUOTAS = {
  produce: 70,
  protein: 45,
  dairy: 35,
  pantry: 80,
  spice: 35,
  frozen: 15,
  bakery: 12,
  other: 8,
} as const satisfies Record<IngredientCategory, number>;

export const INGREDIENT_MANIFEST_SIZE = 300;

const decimalStringSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, "Expected a nonnegative decimal string")
  .refine((value) => Number.isFinite(Number(value)), "Expected a finite decimal string");

const positiveDecimalStringSchema = decimalStringSchema.refine(
  (value) => Number(value) > 0,
  "Expected a positive decimal string",
);

const probabilityDecimalStringSchema = decimalStringSchema.refine(
  (value) => Number(value) >= 0 && Number(value) <= 1,
  "Expected a decimal string from 0 through 1",
);

export const purchaseFormatSchema = z.strictObject({
  key: z.string().trim().min(1).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().min(1),
  quantityInBaseUnit: positiveDecimalStringSchema,
  typicalPriceCents: z.number().int().nonnegative(),
  isDefault: z.boolean(),
});

export const canonicalIngredientSchema = z
  .strictObject({
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().trim().min(1),
    pluralName: z.string().trim().min(1),
    category: z.enum(INGREDIENT_CATEGORIES),
    baseUnit: z.enum(BASE_UNITS),
    densityGPerMl: positiveDecimalStringSchema.nullable(),
    gramsPerCount: positiveDecimalStringSchema.nullable(),
    storageClass: z.enum(STORAGE_CLASSES),
    sealedShelfDays: z.number().int().positive(),
    openedShelfDays: z.number().int().positive(),
    survivalProbability: probabilityDecimalStringSchema,
    isStaple: z.boolean(),
    aliases: z.array(z.string().trim().min(1)),
    formats: z.array(purchaseFormatSchema).min(1),
  })
  .superRefine((ingredient, context) => {
    const defaultCount = ingredient.formats.filter((format) => format.isDefault).length;
    if (defaultCount !== 1) {
      context.addIssue({
        code: "custom",
        path: ["formats"],
        message: "Expected exactly one default purchase format",
      });
    }

    const formatKeys = new Set<string>();
    for (const [index, format] of ingredient.formats.entries()) {
      if (formatKeys.has(format.key)) {
        context.addIssue({
          code: "custom",
          path: ["formats", index, "key"],
          message: `Duplicate purchase format key: ${format.key}`,
        });
      }
      formatKeys.add(format.key);
    }
  });

export type PurchaseFormat = z.infer<typeof purchaseFormatSchema>;
export type CanonicalIngredient = z.infer<typeof canonicalIngredientSchema>;

export function normalizeIngredientLookup(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export const canonicalIngredientManifestSchema = z
  .array(canonicalIngredientSchema)
  .length(INGREDIENT_MANIFEST_SIZE)
  .superRefine((ingredients, context) => {
    const categoryCounts = Object.fromEntries(
      INGREDIENT_CATEGORIES.map((category) => [category, 0]),
    ) as Record<IngredientCategory, number>;
    const slugs = new Map<string, number>();
    const lookupValues = new Map<string, { index: number; field: string }>();

    const addLookupValue = (value: string, index: number, field: string) => {
      const normalized = normalizeIngredientLookup(value);
      const existing = lookupValues.get(normalized);
      if (existing) {
        context.addIssue({
          code: "custom",
          path: [index, field],
          message: `Lookup value collides with ${existing.field} on ingredient ${existing.index}: ${value}`,
        });
        return;
      }
      lookupValues.set(normalized, { index, field });
    };

    for (const [index, ingredient] of ingredients.entries()) {
      categoryCounts[ingredient.category] += 1;

      const existingSlugIndex = slugs.get(ingredient.slug);
      if (existingSlugIndex !== undefined) {
        context.addIssue({
          code: "custom",
          path: [index, "slug"],
          message: `Slug collides with ingredient ${existingSlugIndex}: ${ingredient.slug}`,
        });
      } else {
        slugs.set(ingredient.slug, index);
      }

      addLookupValue(ingredient.name, index, "name");
      for (const [aliasIndex, alias] of ingredient.aliases.entries()) {
        addLookupValue(alias, index, `aliases.${aliasIndex}`);
      }
    }

    for (const category of INGREDIENT_CATEGORIES) {
      const expected = INGREDIENT_CATEGORY_QUOTAS[category];
      if (categoryCounts[category] !== expected) {
        context.addIssue({
          code: "custom",
          path: [],
          message: `Expected ${expected} ${category} ingredients, received ${categoryCounts[category]}`,
        });
      }
    }
  });

export function validateIngredientManifest(input: unknown): CanonicalIngredient[] {
  return canonicalIngredientManifestSchema.parse(input);
}

type ApproximateFormat = {
  key?: string;
  description: string;
  quantityInBaseUnit: number | string;
  typicalPriceCents: number;
  isDefault?: boolean;
};

type IngredientOptions = {
  slug?: string;
  pluralName?: string;
  baseUnit?: BaseUnit;
  densityGPerMl?: number | string | null;
  gramsPerCount?: number | string | null;
  storageClass?: StorageClass;
  sealedShelfDays?: number;
  openedShelfDays?: number;
  survivalProbability?: string;
  isStaple?: boolean;
  aliases?: readonly string[];
  additionalFormats?: readonly ApproximateFormat[];
};

type CategoryDefaults = Required<
  Pick<
    IngredientOptions,
    | "baseUnit"
    | "storageClass"
    | "sealedShelfDays"
    | "openedShelfDays"
    | "survivalProbability"
    | "isStaple"
  >
> & {
  pluralize: boolean;
};

const categoryDefaults: Record<IngredientCategory, CategoryDefaults> = {
  produce: {
    baseUnit: "g",
    storageClass: "fridge",
    sealedShelfDays: 10,
    openedShelfDays: 5,
    survivalProbability: "0.35",
    isStaple: false,
    pluralize: true,
  },
  protein: {
    baseUnit: "g",
    storageClass: "fridge",
    sealedShelfDays: 3,
    openedShelfDays: 1,
    survivalProbability: "0.35",
    isStaple: false,
    pluralize: true,
  },
  dairy: {
    baseUnit: "g",
    storageClass: "fridge",
    sealedShelfDays: 30,
    openedShelfDays: 7,
    survivalProbability: "0.35",
    isStaple: false,
    pluralize: false,
  },
  pantry: {
    baseUnit: "g",
    storageClass: "pantry",
    sealedShelfDays: 365,
    openedShelfDays: 180,
    survivalProbability: "0.95",
    isStaple: false,
    pluralize: false,
  },
  spice: {
    baseUnit: "g",
    storageClass: "pantry",
    sealedShelfDays: 730,
    openedShelfDays: 365,
    survivalProbability: "0.95",
    isStaple: false,
    pluralize: false,
  },
  frozen: {
    baseUnit: "g",
    storageClass: "freezer",
    sealedShelfDays: 240,
    openedShelfDays: 90,
    survivalProbability: "0.95",
    isStaple: false,
    pluralize: true,
  },
  bakery: {
    baseUnit: "count",
    storageClass: "counter",
    sealedShelfDays: 7,
    openedShelfDays: 5,
    survivalProbability: "0.35",
    isStaple: false,
    pluralize: true,
  },
  other: {
    baseUnit: "g",
    storageClass: "pantry",
    sealedShelfDays: 365,
    openedShelfDays: 180,
    survivalProbability: "0.95",
    isStaple: false,
    pluralize: false,
  },
};

function slugify(value: string): string {
  return normalizeIngredientLookup(value).replace(/ /g, "-");
}

function pluralizeLastWord(value: string): string {
  const words = value.split(" ");
  const lastWord = words.at(-1);
  if (!lastWord) {
    return value;
  }

  let plural: string;
  if (/[^aeiou]y$/i.test(lastWord)) {
    plural = `${lastWord.slice(0, -1)}ies`;
  } else if (/(?:s|x|z|ch|sh)$/i.test(lastWord)) {
    plural = `${lastWord}es`;
  } else {
    plural = `${lastWord}s`;
  }
  return [...words.slice(0, -1), plural].join(" ");
}

function toDecimalString(value: number | string): string {
  return typeof value === "number" ? String(value) : value;
}

function makeIngredient(
  category: IngredientCategory,
  name: string,
  defaultFormat: ApproximateFormat,
  options: IngredientOptions = {},
): CanonicalIngredient {
  const defaults = categoryDefaults[category];
  const formats = [defaultFormat, ...(options.additionalFormats ?? [])].map((format, index) => ({
    key: format.key ?? (index === 0 ? "standard" : `option-${index + 1}`),
    description: format.description,
    quantityInBaseUnit: toDecimalString(format.quantityInBaseUnit),
    typicalPriceCents: format.typicalPriceCents,
    isDefault: format.isDefault ?? index === 0,
  }));

  return {
    slug: options.slug ?? slugify(name),
    name,
    pluralName:
      options.pluralName ?? (defaults.pluralize ? pluralizeLastWord(name) : name),
    category,
    baseUnit: options.baseUnit ?? defaults.baseUnit,
    densityGPerMl:
      options.densityGPerMl == null ? null : toDecimalString(options.densityGPerMl),
    gramsPerCount:
      options.gramsPerCount == null ? null : toDecimalString(options.gramsPerCount),
    storageClass: options.storageClass ?? defaults.storageClass,
    sealedShelfDays: options.sealedShelfDays ?? defaults.sealedShelfDays,
    openedShelfDays: options.openedShelfDays ?? defaults.openedShelfDays,
    survivalProbability: options.survivalProbability ?? defaults.survivalProbability,
    isStaple: options.isStaple ?? defaults.isStaple,
    aliases: [...(options.aliases ?? [])],
    formats,
  };
}

function format(
  description: string,
  quantityInBaseUnit: number | string,
  typicalPriceCents: number,
): ApproximateFormat {
  return { description, quantityInBaseUnit, typicalPriceCents };
}

const produceIngredients = [
  makeIngredient("produce", "apple", format("3 lb bag", 1361, 499), {
    storageClass: "counter",
    sealedShelfDays: 30,
    openedShelfDays: 7,
    survivalProbability: "0.60",
    gramsPerCount: 182,
  }),
  makeIngredient("produce", "banana", format("2 lb bunch", 907, 179), {
    storageClass: "counter",
    sealedShelfDays: 7,
    openedShelfDays: 3,
    gramsPerCount: 118,
  }),
  makeIngredient("produce", "orange", format("4 lb bag", 1814, 599), {
    storageClass: "counter",
    sealedShelfDays: 21,
    openedShelfDays: 5,
    gramsPerCount: 131,
  }),
  makeIngredient("produce", "lemon", format("2 lb bag", 907, 449), {
    storageClass: "counter",
    sealedShelfDays: 21,
    openedShelfDays: 5,
    gramsPerCount: 58,
  }),
  makeIngredient("produce", "lime", format("1 lb bag", 454, 349), {
    storageClass: "counter",
    sealedShelfDays: 21,
    openedShelfDays: 5,
    gramsPerCount: 67,
  }),
  makeIngredient("produce", "grapefruit", format("3 count bag", 738, 499), {
    storageClass: "counter",
    sealedShelfDays: 21,
    openedShelfDays: 5,
    gramsPerCount: 246,
    pluralName: "grapefruit",
  }),
  makeIngredient("produce", "pear", format("2 lb bag", 907, 499), {
    storageClass: "counter",
    sealedShelfDays: 10,
    gramsPerCount: 178,
  }),
  makeIngredient("produce", "peach", format("2 lb bag", 907, 599), {
    storageClass: "counter",
    sealedShelfDays: 7,
    gramsPerCount: 150,
  }),
  makeIngredient("produce", "nectarine", format("2 lb bag", 907, 599), {
    storageClass: "counter",
    sealedShelfDays: 7,
    gramsPerCount: 142,
  }),
  makeIngredient("produce", "plum", format("2 lb bag", 907, 499), {
    storageClass: "counter",
    sealedShelfDays: 7,
    gramsPerCount: 66,
  }),
  makeIngredient("produce", "pineapple", format("1 whole pineapple", 905, 299), {
    storageClass: "counter",
    sealedShelfDays: 5,
    gramsPerCount: 905,
  }),
  makeIngredient("produce", "mango", format("2 count package", 672, 399), {
    storageClass: "counter",
    sealedShelfDays: 7,
    gramsPerCount: 336,
    pluralName: "mangoes",
  }),
  makeIngredient("produce", "avocado", format("4 count bag", 804, 499), {
    storageClass: "counter",
    sealedShelfDays: 7,
    gramsPerCount: 201,
    pluralName: "avocados",
  }),
  makeIngredient("produce", "strawberry", format("1 lb clamshell", 454, 399), {
    sealedShelfDays: 5,
  }),
  makeIngredient("produce", "blueberry", format("6 oz clamshell", 170, 349), {
    sealedShelfDays: 7,
  }),
  makeIngredient("produce", "raspberry", format("6 oz clamshell", 170, 399), {
    sealedShelfDays: 4,
  }),
  makeIngredient("produce", "blackberry", format("6 oz clamshell", 170, 399), {
    sealedShelfDays: 4,
  }),
  makeIngredient("produce", "grape", format("2 lb bag", 907, 499), {
    sealedShelfDays: 10,
  }),
  makeIngredient("produce", "watermelon", format("1 seedless watermelon", 4500, 699), {
    storageClass: "counter",
    sealedShelfDays: 10,
    gramsPerCount: 4500,
  }),
  makeIngredient("produce", "cantaloupe", format("1 cantaloupe", 552, 299), {
    storageClass: "counter",
    sealedShelfDays: 7,
    gramsPerCount: 552,
  }),
  makeIngredient("produce", "kiwi", format("1 lb package", 454, 399), {
    sealedShelfDays: 14,
    gramsPerCount: 69,
    pluralName: "kiwis",
  }),
  makeIngredient("produce", "cherry", format("1 lb bag", 454, 499), {
    sealedShelfDays: 7,
    gramsPerCount: 8,
  }),
  makeIngredient("produce", "tomato", format("1.5 lb package", 680, 399), {
    storageClass: "counter",
    sealedShelfDays: 7,
    gramsPerCount: 123,
    pluralName: "tomatoes",
  }),
  makeIngredient("produce", "cherry tomato", format("10 oz container", 283, 349), {
    storageClass: "counter",
    sealedShelfDays: 7,
    pluralName: "cherry tomatoes",
    aliases: ["grape tomato"],
  }),
  makeIngredient("produce", "cucumber", format("3 count package", 903, 299), {
    gramsPerCount: 301,
  }),
  makeIngredient("produce", "zucchini", format("1.5 lb package", 680, 299), {
    gramsPerCount: 196,
    pluralName: "zucchini",
    aliases: ["courgette"],
  }),
  makeIngredient("produce", "yellow squash", format("1.5 lb package", 680, 299), {
    gramsPerCount: 196,
    pluralName: "yellow squash",
  }),
  makeIngredient("produce", "eggplant", format("1 eggplant", 458, 249), {
    gramsPerCount: 458,
  }),
  makeIngredient("produce", "bell pepper", format("3 count package", 492, 399), {
    gramsPerCount: 164,
    aliases: ["sweet pepper"],
  }),
  makeIngredient("produce", "jalapeno", format("8 oz package", 227, 199), {
    gramsPerCount: 14,
    pluralName: "jalapenos",
    aliases: ["jalapeno pepper"],
  }),
  makeIngredient("produce", "poblano pepper", format("2 count package", 240, 249), {
    gramsPerCount: 120,
  }),
  makeIngredient("produce", "serrano pepper", format("4 oz package", 113, 199), {
    gramsPerCount: 6,
  }),
  makeIngredient("produce", "carrot", format("2 lb bag", 907, 199), {
    sealedShelfDays: 28,
    openedShelfDays: 14,
    survivalProbability: "0.60",
    gramsPerCount: 61,
  }),
  makeIngredient("produce", "celery", format("1 bunch", 454, 249), {
    sealedShelfDays: 14,
  }),
  makeIngredient("produce", "yellow onion", format("3 lb bag", 1361, 299), {
    storageClass: "counter",
    sealedShelfDays: 30,
    openedShelfDays: 7,
    survivalProbability: "0.60",
    gramsPerCount: 150,
  }),
  makeIngredient("produce", "red onion", format("2 lb bag", 907, 299), {
    storageClass: "counter",
    sealedShelfDays: 30,
    openedShelfDays: 7,
    survivalProbability: "0.60",
    gramsPerCount: 150,
  }),
  makeIngredient("produce", "white onion", format("2 lb bag", 907, 299), {
    storageClass: "counter",
    sealedShelfDays: 30,
    openedShelfDays: 7,
    survivalProbability: "0.60",
    gramsPerCount: 150,
  }),
  makeIngredient("produce", "green onion", format("1 bunch", 100, 129), {
    sealedShelfDays: 7,
    openedShelfDays: 4,
    aliases: ["scallion"],
  }),
  makeIngredient("produce", "shallot", format("8 oz bag", 227, 299), {
    storageClass: "counter",
    sealedShelfDays: 30,
    openedShelfDays: 7,
    survivalProbability: "0.60",
    gramsPerCount: 42,
  }),
  makeIngredient("produce", "garlic", format("3 bulb package", 150, 199), {
    storageClass: "counter",
    sealedShelfDays: 60,
    openedShelfDays: 14,
    survivalProbability: "0.60",
    gramsPerCount: 50,
    pluralName: "garlic",
  }),
  makeIngredient("produce", "ginger", format("4 oz piece", 113, 199), {
    sealedShelfDays: 21,
    openedShelfDays: 10,
    survivalProbability: "0.60",
    pluralName: "ginger",
    aliases: ["ginger root"],
  }),
  makeIngredient("produce", "russet potato", format("5 lb bag", 2268, 449), {
    storageClass: "counter",
    sealedShelfDays: 35,
    openedShelfDays: 7,
    survivalProbability: "0.60",
    gramsPerCount: 213,
  }),
  makeIngredient("produce", "Yukon Gold potato", format("3 lb bag", 1361, 449), {
    storageClass: "counter",
    sealedShelfDays: 35,
    openedShelfDays: 7,
    survivalProbability: "0.60",
    gramsPerCount: 148,
    pluralName: "Yukon Gold potatoes",
  }),
  makeIngredient("produce", "sweet potato", format("3 lb bag", 1361, 399), {
    storageClass: "counter",
    sealedShelfDays: 30,
    openedShelfDays: 7,
    survivalProbability: "0.60",
    gramsPerCount: 130,
    pluralName: "sweet potatoes",
  }),
  makeIngredient("produce", "broccoli", format("2 crown package", 680, 349), {
    sealedShelfDays: 7,
    pluralName: "broccoli",
  }),
  makeIngredient("produce", "cauliflower", format("1 head", 575, 349), {
    sealedShelfDays: 10,
    gramsPerCount: 575,
    pluralName: "cauliflower",
  }),
  makeIngredient("produce", "green bean", format("12 oz bag", 340, 299), {
    sealedShelfDays: 7,
  }),
  makeIngredient("produce", "asparagus", format("1 lb bunch", 454, 399), {
    sealedShelfDays: 5,
    pluralName: "asparagus",
  }),
  makeIngredient("produce", "brussels sprout", format("1 lb bag", 454, 349), {
    sealedShelfDays: 10,
  }),
  makeIngredient("produce", "corn", format("4 ear package", 360, 299), {
    sealedShelfDays: 5,
    gramsPerCount: 90,
    pluralName: "corn",
    aliases: ["corn on the cob"],
  }),
  makeIngredient("produce", "green cabbage", format("1 head", 900, 249), {
    sealedShelfDays: 21,
    openedShelfDays: 10,
    survivalProbability: "0.60",
    gramsPerCount: 900,
    pluralName: "green cabbage",
  }),
  makeIngredient("produce", "red cabbage", format("1 head", 900, 299), {
    sealedShelfDays: 21,
    openedShelfDays: 10,
    survivalProbability: "0.60",
    gramsPerCount: 900,
    pluralName: "red cabbage",
  }),
  makeIngredient("produce", "kale", format("1 bunch", 225, 249), {
    sealedShelfDays: 7,
    pluralName: "kale",
  }),
  makeIngredient("produce", "spinach", format("10 oz bag", 283, 349), {
    sealedShelfDays: 7,
    pluralName: "spinach",
  }),
  makeIngredient("produce", "romaine lettuce", format("3 heart package", 510, 399), {
    sealedShelfDays: 10,
    pluralName: "romaine lettuce",
  }),
  makeIngredient("produce", "iceberg lettuce", format("1 head", 539, 249), {
    sealedShelfDays: 14,
    gramsPerCount: 539,
    pluralName: "iceberg lettuce",
  }),
  makeIngredient("produce", "arugula", format("5 oz box", 142, 349), {
    sealedShelfDays: 5,
    pluralName: "arugula",
  }),
  makeIngredient("produce", "collard green", format("1 bunch", 450, 249), {
    sealedShelfDays: 7,
  }),
  makeIngredient("produce", "mushroom", format("8 oz package", 227, 249), {
    sealedShelfDays: 7,
  }),
  makeIngredient("produce", "snap pea", format("8 oz bag", 227, 349), {
    sealedShelfDays: 7,
    aliases: ["sugar snap pea"],
  }),
  makeIngredient("produce", "snow pea", format("8 oz bag", 227, 349), {
    sealedShelfDays: 7,
  }),
  makeIngredient("produce", "radish", format("1 bunch", 225, 199), {
    sealedShelfDays: 14,
    survivalProbability: "0.60",
    pluralName: "radishes",
  }),
  makeIngredient("produce", "beet", format("1 lb bunch", 454, 299), {
    sealedShelfDays: 21,
    survivalProbability: "0.60",
    gramsPerCount: 82,
  }),
  makeIngredient("produce", "turnip", format("1 lb bag", 454, 249), {
    sealedShelfDays: 21,
    survivalProbability: "0.60",
    gramsPerCount: 122,
  }),
  makeIngredient("produce", "parsnip", format("1 lb bag", 454, 299), {
    sealedShelfDays: 21,
    survivalProbability: "0.60",
    gramsPerCount: 133,
  }),
  makeIngredient("produce", "cilantro", format("1 bunch", 56, 99), {
    sealedShelfDays: 7,
    openedShelfDays: 4,
    survivalProbability: "0.15",
    pluralName: "cilantro",
    aliases: ["fresh coriander"],
  }),
  makeIngredient("produce", "parsley", format("1 bunch", 60, 99), {
    sealedShelfDays: 7,
    openedShelfDays: 4,
    survivalProbability: "0.15",
    pluralName: "parsley",
  }),
  makeIngredient("produce", "basil", format("2 oz package", 57, 249), {
    sealedShelfDays: 5,
    openedShelfDays: 3,
    survivalProbability: "0.15",
    pluralName: "basil",
  }),
  makeIngredient("produce", "rosemary", format("0.75 oz package", 21, 249), {
    sealedShelfDays: 10,
    openedShelfDays: 5,
    survivalProbability: "0.15",
    pluralName: "rosemary",
  }),
  makeIngredient("produce", "thyme", format("0.75 oz package", 21, 249), {
    sealedShelfDays: 10,
    openedShelfDays: 5,
    survivalProbability: "0.15",
    pluralName: "thyme",
  }),
] satisfies CanonicalIngredient[];

const proteinIngredients = [
  makeIngredient("protein", "chicken breast", format("2 lb package", 907, 799), {
    pluralName: "chicken breasts",
  }),
  makeIngredient("protein", "chicken thigh", format("2 lb package", 907, 599), {
    pluralName: "chicken thighs",
  }),
  makeIngredient("protein", "chicken drumstick", format("2.5 lb package", 1134, 499), {
    pluralName: "chicken drumsticks",
  }),
  makeIngredient("protein", "whole chicken", format("4 lb chicken", 1814, 899), {
    sealedShelfDays: 2,
    gramsPerCount: 1814,
  }),
  makeIngredient("protein", "ground chicken", format("1 lb package", 454, 549), {
    sealedShelfDays: 2,
    pluralName: "ground chicken",
  }),
  makeIngredient("protein", "chicken tender", format("1.5 lb package", 680, 699), {
    aliases: ["chicken tenderloin"],
  }),
  makeIngredient("protein", "turkey breast", format("2 lb package", 907, 999), {
    pluralName: "turkey breasts",
  }),
  makeIngredient("protein", "ground turkey", format("1 lb package", 454, 499), {
    sealedShelfDays: 2,
    pluralName: "ground turkey",
  }),
  makeIngredient("protein", "turkey sausage", format("12 oz package", 340, 449), {
    pluralName: "turkey sausage",
  }),
  makeIngredient("protein", "beef chuck roast", format("3 lb roast", 1361, 1799), {
    pluralName: "beef chuck roasts",
  }),
  makeIngredient("protein", "ground beef", format("1 lb package", 454, 599), {
    sealedShelfDays: 2,
    pluralName: "ground beef",
  }),
  makeIngredient("protein", "beef sirloin steak", format("1 lb package", 454, 1099), {
    pluralName: "beef sirloin steaks",
  }),
  makeIngredient("protein", "beef flank steak", format("1.5 lb package", 680, 1499), {
    pluralName: "beef flank steaks",
  }),
  makeIngredient("protein", "beef skirt steak", format("1.25 lb package", 567, 1299), {
    pluralName: "beef skirt steaks",
  }),
  makeIngredient("protein", "beef short rib", format("2 lb package", 907, 1599), {
    pluralName: "beef short ribs",
  }),
  makeIngredient("protein", "beef brisket", format("4 lb brisket", 1814, 2399), {
    pluralName: "beef briskets",
  }),
  makeIngredient("protein", "pork chop", format("1.5 lb package", 680, 699), {
    pluralName: "pork chops",
  }),
  makeIngredient("protein", "pork tenderloin", format("1.25 lb package", 567, 799), {
    pluralName: "pork tenderloins",
  }),
  makeIngredient("protein", "pork shoulder", format("3 lb roast", 1361, 1099), {
    pluralName: "pork shoulders",
    aliases: ["Boston butt"],
  }),
  makeIngredient("protein", "ground pork", format("1 lb package", 454, 499), {
    sealedShelfDays: 2,
    pluralName: "ground pork",
  }),
  makeIngredient("protein", "bacon", format("12 oz package", 340, 599), {
    sealedShelfDays: 14,
    openedShelfDays: 7,
    pluralName: "bacon",
  }),
  makeIngredient("protein", "breakfast sausage", format("12 oz package", 340, 449), {
    pluralName: "breakfast sausage",
  }),
  makeIngredient("protein", "Italian sausage", format("19 oz package", 539, 599), {
    pluralName: "Italian sausage",
  }),
  makeIngredient("protein", "ham steak", format("1 lb package", 454, 699), {
    sealedShelfDays: 7,
    openedShelfDays: 4,
    pluralName: "ham steaks",
  }),
  makeIngredient("protein", "salmon fillet", format("1 lb package", 454, 1199), {
    sealedShelfDays: 2,
    pluralName: "salmon fillets",
  }),
  makeIngredient("protein", "cod fillet", format("1 lb package", 454, 999), {
    sealedShelfDays: 2,
    pluralName: "cod fillets",
  }),
  makeIngredient("protein", "tilapia fillet", format("1 lb package", 454, 699), {
    sealedShelfDays: 2,
    pluralName: "tilapia fillets",
  }),
  makeIngredient("protein", "shrimp", format("1 lb bag", 454, 999), {
    storageClass: "freezer",
    sealedShelfDays: 180,
    openedShelfDays: 60,
    survivalProbability: "0.95",
    pluralName: "shrimp",
  }),
  makeIngredient("protein", "tuna steak", format("12 oz package", 340, 999), {
    sealedShelfDays: 2,
    pluralName: "tuna steaks",
  }),
  makeIngredient("protein", "canned tuna", format("5 oz can", 142, 149), {
    storageClass: "pantry",
    sealedShelfDays: 1095,
    openedShelfDays: 3,
    survivalProbability: "0.95",
    pluralName: "canned tuna",
  }),
  makeIngredient("protein", "canned salmon", format("14.75 oz can", 418, 449), {
    storageClass: "pantry",
    sealedShelfDays: 1095,
    openedShelfDays: 3,
    survivalProbability: "0.95",
    pluralName: "canned salmon",
  }),
  makeIngredient("protein", "crab meat", format("8 oz container", 227, 899), {
    sealedShelfDays: 3,
    openedShelfDays: 2,
    pluralName: "crab meat",
  }),
  makeIngredient("protein", "scallop", format("12 oz package", 340, 1299), {
    sealedShelfDays: 2,
  }),
  makeIngredient("protein", "egg", format("12 count carton", 12, 399), {
    baseUnit: "count",
    sealedShelfDays: 35,
    openedShelfDays: 21,
    survivalProbability: "0.60",
    gramsPerCount: 50,
  }),
  makeIngredient("protein", "tofu", format("14 oz package", 397, 299), {
    sealedShelfDays: 30,
    openedShelfDays: 4,
    pluralName: "tofu",
  }),
  makeIngredient("protein", "tempeh", format("8 oz package", 227, 399), {
    sealedShelfDays: 30,
    openedShelfDays: 5,
    pluralName: "tempeh",
  }),
  makeIngredient("protein", "lamb chop", format("1 lb package", 454, 1399), {
    pluralName: "lamb chops",
  }),
  makeIngredient("protein", "ground lamb", format("1 lb package", 454, 899), {
    sealedShelfDays: 2,
    pluralName: "ground lamb",
  }),
  makeIngredient("protein", "duck breast", format("12 oz package", 340, 1499), {
    sealedShelfDays: 2,
    pluralName: "duck breasts",
  }),
  makeIngredient("protein", "rotisserie chicken", format("1 whole chicken", 900, 799), {
    sealedShelfDays: 4,
    openedShelfDays: 3,
    gramsPerCount: 900,
    pluralName: "rotisserie chickens",
  }),
  makeIngredient("protein", "deli turkey", format("9 oz package", 255, 599), {
    sealedShelfDays: 14,
    openedShelfDays: 5,
    pluralName: "deli turkey",
  }),
  makeIngredient("protein", "deli ham", format("9 oz package", 255, 599), {
    sealedShelfDays: 14,
    openedShelfDays: 5,
    pluralName: "deli ham",
  }),
  makeIngredient("protein", "frozen meatball", format("24 oz bag", 680, 799), {
    storageClass: "freezer",
    sealedShelfDays: 240,
    openedShelfDays: 90,
    survivalProbability: "0.95",
    pluralName: "frozen meatballs",
  }),
  makeIngredient("protein", "hot dog", format("8 count package", 454, 499), {
    sealedShelfDays: 14,
    openedShelfDays: 7,
    gramsPerCount: 57,
    pluralName: "hot dogs",
  }),
  makeIngredient("protein", "kielbasa", format("14 oz package", 397, 499), {
    sealedShelfDays: 21,
    openedShelfDays: 7,
    pluralName: "kielbasa",
    aliases: ["Polish sausage"],
  }),
] satisfies CanonicalIngredient[];

const dairyIngredients = [
  makeIngredient("dairy", "whole milk", format("1 gallon jug", 3785, 429), {
    baseUnit: "ml",
    densityGPerMl: 1.03,
    openedShelfDays: 7,
  }),
  makeIngredient("dairy", "reduced fat milk", format("1 gallon jug", 3785, 429), {
    baseUnit: "ml",
    densityGPerMl: 1.03,
    openedShelfDays: 7,
    aliases: ["2 percent milk"],
  }),
  makeIngredient("dairy", "skim milk", format("1 gallon jug", 3785, 429), {
    baseUnit: "ml",
    densityGPerMl: 1.03,
    openedShelfDays: 7,
    aliases: ["nonfat milk"],
  }),
  makeIngredient("dairy", "half and half", format("1 pint carton", 473, 349), {
    baseUnit: "ml",
    densityGPerMl: 1.02,
    sealedShelfDays: 21,
    openedShelfDays: 7,
  }),
  makeIngredient("dairy", "heavy cream", format("1 pint carton", 473, 499), {
    baseUnit: "ml",
    densityGPerMl: 0.99,
    sealedShelfDays: 21,
    openedShelfDays: 7,
    aliases: ["heavy whipping cream"],
  }),
  makeIngredient("dairy", "buttermilk", format("1 quart carton", 946, 399), {
    baseUnit: "ml",
    densityGPerMl: 1.03,
    sealedShelfDays: 21,
    openedShelfDays: 14,
  }),
  makeIngredient("dairy", "sour cream", format("16 oz tub", 454, 299), {
    sealedShelfDays: 21,
    openedShelfDays: 14,
  }),
  makeIngredient("dairy", "Greek yogurt", format("32 oz tub", 907, 599), {
    sealedShelfDays: 30,
    openedShelfDays: 7,
    aliases: ["plain Greek yogurt"],
  }),
  makeIngredient("dairy", "plain yogurt", format("32 oz tub", 907, 499), {
    sealedShelfDays: 30,
    openedShelfDays: 7,
  }),
  makeIngredient("dairy", "butter", format("1 lb box", 454, 499), {
    sealedShelfDays: 120,
    openedShelfDays: 30,
    survivalProbability: "0.60",
  }),
  makeIngredient("dairy", "unsalted butter", format("1 lb box", 454, 499), {
    sealedShelfDays: 120,
    openedShelfDays: 30,
    survivalProbability: "0.60",
  }),
  makeIngredient("dairy", "cream cheese", format("8 oz package", 227, 299), {
    sealedShelfDays: 60,
    openedShelfDays: 10,
  }),
  makeIngredient("dairy", "cheddar cheese", format("8 oz block", 227, 349), {
    sealedShelfDays: 120,
    openedShelfDays: 21,
    survivalProbability: "0.60",
  }),
  makeIngredient("dairy", "mozzarella cheese", format("8 oz package", 227, 349), {
    sealedShelfDays: 60,
    openedShelfDays: 14,
  }),
  makeIngredient("dairy", "parmesan cheese", format("6 oz wedge", 170, 599), {
    sealedShelfDays: 180,
    openedShelfDays: 42,
    survivalProbability: "0.60",
    aliases: ["Parmigiano Reggiano"],
  }),
  makeIngredient("dairy", "Monterey Jack cheese", format("8 oz block", 227, 399), {
    sealedShelfDays: 90,
    openedShelfDays: 21,
    survivalProbability: "0.60",
  }),
  makeIngredient("dairy", "pepper jack cheese", format("8 oz block", 227, 399), {
    sealedShelfDays: 90,
    openedShelfDays: 21,
    survivalProbability: "0.60",
  }),
  makeIngredient("dairy", "Swiss cheese", format("8 oz package", 227, 449), {
    sealedShelfDays: 90,
    openedShelfDays: 21,
    survivalProbability: "0.60",
  }),
  makeIngredient("dairy", "provolone cheese", format("8 oz package", 227, 449), {
    sealedShelfDays: 90,
    openedShelfDays: 21,
    survivalProbability: "0.60",
  }),
  makeIngredient("dairy", "feta cheese", format("6 oz package", 170, 449), {
    sealedShelfDays: 90,
    openedShelfDays: 14,
    survivalProbability: "0.60",
  }),
  makeIngredient("dairy", "goat cheese", format("4 oz log", 113, 499), {
    sealedShelfDays: 60,
    openedShelfDays: 14,
  }),
  makeIngredient("dairy", "ricotta cheese", format("15 oz tub", 425, 449), {
    sealedShelfDays: 30,
    openedShelfDays: 7,
  }),
  makeIngredient("dairy", "cottage cheese", format("16 oz tub", 454, 349), {
    sealedShelfDays: 30,
    openedShelfDays: 7,
  }),
  makeIngredient("dairy", "blue cheese", format("5 oz package", 142, 499), {
    sealedShelfDays: 90,
    openedShelfDays: 21,
    survivalProbability: "0.60",
  }),
  makeIngredient("dairy", "queso fresco", format("10 oz package", 283, 449), {
    sealedShelfDays: 45,
    openedShelfDays: 10,
  }),
  makeIngredient("dairy", "mascarpone", format("8 oz tub", 227, 549), {
    sealedShelfDays: 45,
    openedShelfDays: 7,
  }),
  makeIngredient("dairy", "evaporated milk", format("12 fl oz can", 354, 199), {
    baseUnit: "ml",
    densityGPerMl: 1.07,
    storageClass: "pantry",
    sealedShelfDays: 730,
    openedShelfDays: 4,
    survivalProbability: "0.95",
  }),
  makeIngredient("dairy", "sweetened condensed milk", format("14 oz can", 396, 249), {
    baseUnit: "ml",
    densityGPerMl: 1.30,
    storageClass: "pantry",
    sealedShelfDays: 730,
    openedShelfDays: 7,
    survivalProbability: "0.95",
  }),
  makeIngredient("dairy", "almond milk", format("64 fl oz carton", 1893, 399), {
    baseUnit: "ml",
    densityGPerMl: 1.01,
    storageClass: "pantry",
    sealedShelfDays: 180,
    openedShelfDays: 7,
    survivalProbability: "0.60",
  }),
  makeIngredient("dairy", "oat milk", format("64 fl oz carton", 1893, 449), {
    baseUnit: "ml",
    densityGPerMl: 1.02,
    storageClass: "pantry",
    sealedShelfDays: 180,
    openedShelfDays: 7,
    survivalProbability: "0.60",
  }),
  makeIngredient("dairy", "soy milk", format("64 fl oz carton", 1893, 399), {
    baseUnit: "ml",
    densityGPerMl: 1.02,
    storageClass: "pantry",
    sealedShelfDays: 180,
    openedShelfDays: 7,
    survivalProbability: "0.60",
  }),
  makeIngredient("dairy", "whipped cream", format("6.5 oz can", 184, 399), {
    sealedShelfDays: 60,
    openedShelfDays: 14,
  }),
  makeIngredient("dairy", "creme fraiche", format("8 oz tub", 227, 599), {
    sealedShelfDays: 30,
    openedShelfDays: 10,
  }),
  makeIngredient("dairy", "American cheese", format("12 oz package", 340, 399), {
    sealedShelfDays: 120,
    openedShelfDays: 21,
    survivalProbability: "0.60",
  }),
  makeIngredient("dairy", "ghee", format("13 oz jar", 369, 899), {
    storageClass: "pantry",
    sealedShelfDays: 365,
    openedShelfDays: 180,
    survivalProbability: "0.95",
  }),
] satisfies CanonicalIngredient[];

const pantryIngredients = [
  makeIngredient("pantry", "all purpose flour", format("5 lb bag", 2268, 499), {
    isStaple: true,
    aliases: ["plain flour"],
  }),
  makeIngredient("pantry", "bread flour", format("5 lb bag", 2268, 599), {
    isStaple: true,
  }),
  makeIngredient("pantry", "whole wheat flour", format("5 lb bag", 2268, 599)),
  makeIngredient("pantry", "cornmeal", format("24 oz bag", 680, 299)),
  makeIngredient("pantry", "cornstarch", format("16 oz box", 454, 249), {
    isStaple: true,
    aliases: ["corn flour starch"],
  }),
  makeIngredient("pantry", "granulated sugar", format("4 lb bag", 1814, 399), {
    isStaple: true,
    aliases: ["white sugar"],
  }),
  makeIngredient("pantry", "brown sugar", format("2 lb bag", 907, 299)),
  makeIngredient("pantry", "powdered sugar", format("2 lb bag", 907, 299), {
    aliases: ["confectioners sugar"],
  }),
  makeIngredient("pantry", "honey", format("12 oz bottle", 355, 429), {
    baseUnit: "ml",
    densityGPerMl: 1.42,
  }),
  makeIngredient("pantry", "maple syrup", format("12.5 fl oz bottle", 370, 899), {
    baseUnit: "ml",
    densityGPerMl: 1.33,
  }),
  makeIngredient("pantry", "molasses", format("12 fl oz bottle", 355, 499), {
    baseUnit: "ml",
    densityGPerMl: 1.40,
  }),
  makeIngredient("pantry", "olive oil", format("25.5 fl oz bottle", 754, 1099), {
    baseUnit: "ml",
    densityGPerMl: 0.91,
    isStaple: true,
    aliases: ["extra virgin olive oil"],
  }),
  makeIngredient("pantry", "vegetable oil", format("48 fl oz bottle", 1420, 499), {
    baseUnit: "ml",
    densityGPerMl: 0.92,
    isStaple: true,
  }),
  makeIngredient("pantry", "canola oil", format("48 fl oz bottle", 1420, 499), {
    baseUnit: "ml",
    densityGPerMl: 0.92,
    isStaple: true,
  }),
  makeIngredient("pantry", "sesame oil", format("5 fl oz bottle", 148, 499), {
    baseUnit: "ml",
    densityGPerMl: 0.92,
  }),
  makeIngredient("pantry", "white vinegar", format("32 fl oz bottle", 946, 249), {
    baseUnit: "ml",
    densityGPerMl: 1.01,
    isStaple: true,
  }),
  makeIngredient("pantry", "apple cider vinegar", format("32 fl oz bottle", 946, 399), {
    baseUnit: "ml",
    densityGPerMl: 1.01,
  }),
  makeIngredient("pantry", "red wine vinegar", format("16.9 fl oz bottle", 500, 399), {
    baseUnit: "ml",
    densityGPerMl: 1.01,
  }),
  makeIngredient("pantry", "balsamic vinegar", format("16.9 fl oz bottle", 500, 599), {
    baseUnit: "ml",
    densityGPerMl: 1.02,
  }),
  makeIngredient("pantry", "soy sauce", format("15 fl oz bottle", 444, 399), {
    baseUnit: "ml",
    densityGPerMl: 1.20,
    isStaple: true,
  }),
  makeIngredient("pantry", "Worcestershire sauce", format("10 fl oz bottle", 296, 449), {
    baseUnit: "ml",
    densityGPerMl: 1.12,
  }),
  makeIngredient("pantry", "hot sauce", format("5 fl oz bottle", 148, 249), {
    baseUnit: "ml",
    densityGPerMl: 1.02,
    storageClass: "fridge",
    sealedShelfDays: 365,
    openedShelfDays: 180,
  }),
  makeIngredient("pantry", "ketchup", format("20 oz bottle", 591, 299), {
    baseUnit: "ml",
    storageClass: "fridge",
    sealedShelfDays: 365,
    openedShelfDays: 180,
  }),
  makeIngredient("pantry", "yellow mustard", format("14 oz bottle", 414, 199), {
    baseUnit: "ml",
    storageClass: "fridge",
    sealedShelfDays: 365,
    openedShelfDays: 365,
  }),
  makeIngredient("pantry", "Dijon mustard", format("12 oz jar", 355, 399), {
    baseUnit: "ml",
    storageClass: "fridge",
    sealedShelfDays: 365,
    openedShelfDays: 180,
  }),
  makeIngredient("pantry", "mayonnaise", format("30 fl oz jar", 887, 549), {
    baseUnit: "ml",
    storageClass: "fridge",
    sealedShelfDays: 180,
    openedShelfDays: 60,
    aliases: ["mayo"],
  }),
  makeIngredient("pantry", "peanut butter", format("16 oz jar", 454, 349), {
    openedShelfDays: 120,
  }),
  makeIngredient("pantry", "almond butter", format("12 oz jar", 340, 699), {
    openedShelfDays: 120,
  }),
  makeIngredient("pantry", "rolled oats", format("42 oz canister", 1191, 499), {
    aliases: ["old fashioned oats"],
  }),
  makeIngredient("pantry", "white rice", format("5 lb bag", 2268, 599), {
    isStaple: true,
  }),
  makeIngredient("pantry", "brown rice", format("2 lb bag", 907, 399)),
  makeIngredient("pantry", "jasmine rice", format("5 lb bag", 2268, 799)),
  makeIngredient("pantry", "basmati rice", format("5 lb bag", 2268, 899)),
  makeIngredient("pantry", "quinoa", format("16 oz bag", 454, 599)),
  makeIngredient("pantry", "couscous", format("10 oz box", 283, 299)),
  makeIngredient("pantry", "pasta", format("16 oz box", 454, 179), {
    pluralName: "pasta",
    aliases: ["dried pasta"],
  }),
  makeIngredient("pantry", "egg noodle", format("12 oz bag", 340, 249), {
    pluralName: "egg noodles",
  }),
  makeIngredient("pantry", "rice noodle", format("14 oz package", 397, 349), {
    pluralName: "rice noodles",
  }),
  makeIngredient("pantry", "flour tortilla", format("10 count package", 10, 299), {
    baseUnit: "count",
    gramsPerCount: 49,
    pluralName: "flour tortillas",
  }),
  makeIngredient("pantry", "panko breadcrumb", format("8 oz box", 227, 249), {
    pluralName: "panko breadcrumbs",
    aliases: ["Japanese breadcrumb"],
  }),
  makeIngredient("pantry", "plain breadcrumb", format("15 oz canister", 425, 249), {
    pluralName: "plain breadcrumbs",
  }),
  makeIngredient("pantry", "canned tomato", format("14.5 oz can", 411, 149), {
    pluralName: "canned tomatoes",
  }),
  makeIngredient("pantry", "tomato paste", format("6 oz can", 170, 129)),
  makeIngredient("pantry", "tomato sauce", format("15 oz can", 425, 149), {
    baseUnit: "ml",
  }),
  makeIngredient("pantry", "chicken broth", format("32 fl oz carton", 946, 249), {
    baseUnit: "ml",
    storageClass: "fridge",
    sealedShelfDays: 365,
    openedShelfDays: 4,
    aliases: ["chicken stock"],
  }),
  makeIngredient("pantry", "beef broth", format("32 fl oz carton", 946, 299), {
    baseUnit: "ml",
    storageClass: "fridge",
    sealedShelfDays: 365,
    openedShelfDays: 4,
    aliases: ["beef stock"],
  }),
  makeIngredient("pantry", "vegetable broth", format("32 fl oz carton", 946, 249), {
    baseUnit: "ml",
    storageClass: "fridge",
    sealedShelfDays: 365,
    openedShelfDays: 4,
    aliases: ["vegetable stock"],
  }),
  makeIngredient("pantry", "coconut milk", format("13.5 fl oz can", 400, 249), {
    baseUnit: "ml",
    densityGPerMl: 1.01,
    openedShelfDays: 4,
  }),
  makeIngredient("pantry", "black bean", format("15 oz can", 425, 129), {
    openedShelfDays: 4,
    pluralName: "black beans",
  }),
  makeIngredient("pantry", "kidney bean", format("15 oz can", 425, 129), {
    openedShelfDays: 4,
    pluralName: "kidney beans",
  }),
  makeIngredient("pantry", "pinto bean", format("15 oz can", 425, 129), {
    openedShelfDays: 4,
    pluralName: "pinto beans",
  }),
  makeIngredient("pantry", "chickpea", format("15 oz can", 425, 129), {
    openedShelfDays: 4,
    pluralName: "chickpeas",
    aliases: ["garbanzo bean"],
  }),
  makeIngredient("pantry", "cannellini bean", format("15 oz can", 425, 149), {
    openedShelfDays: 4,
    pluralName: "cannellini beans",
    aliases: ["white kidney bean"],
  }),
  makeIngredient("pantry", "lentil", format("1 lb bag", 454, 199), {
    pluralName: "lentils",
  }),
  makeIngredient("pantry", "split pea", format("1 lb bag", 454, 199), {
    pluralName: "split peas",
  }),
  makeIngredient("pantry", "canned corn", format("15.25 oz can", 432, 129), {
    openedShelfDays: 4,
  }),
  makeIngredient("pantry", "canned green chile", format("4 oz can", 113, 129), {
    openedShelfDays: 4,
    pluralName: "canned green chiles",
  }),
  makeIngredient("pantry", "roasted red pepper", format("12 oz jar", 340, 349), {
    storageClass: "fridge",
    sealedShelfDays: 365,
    openedShelfDays: 14,
    pluralName: "roasted red peppers",
  }),
  makeIngredient("pantry", "artichoke heart", format("14 oz can", 397, 299), {
    openedShelfDays: 4,
    pluralName: "artichoke hearts",
  }),
  makeIngredient("pantry", "olive", format("6 oz jar", 170, 249), {
    storageClass: "fridge",
    sealedShelfDays: 365,
    openedShelfDays: 30,
    pluralName: "olives",
  }),
  makeIngredient("pantry", "caper", format("3.5 oz jar", 99, 299), {
    storageClass: "fridge",
    sealedShelfDays: 365,
    openedShelfDays: 180,
    pluralName: "capers",
  }),
  makeIngredient("pantry", "pickle", format("24 fl oz jar", 680, 349), {
    storageClass: "fridge",
    sealedShelfDays: 365,
    openedShelfDays: 90,
    pluralName: "pickles",
  }),
  makeIngredient("pantry", "sun dried tomato", format("7 oz jar", 198, 449), {
    storageClass: "fridge",
    sealedShelfDays: 365,
    openedShelfDays: 30,
    pluralName: "sun dried tomatoes",
  }),
  makeIngredient("pantry", "tahini", format("16 oz jar", 454, 599), {
    openedShelfDays: 180,
  }),
  makeIngredient("pantry", "coconut flake", format("7 oz bag", 198, 249), {
    pluralName: "coconut flakes",
  }),
  makeIngredient("pantry", "chocolate chip", format("12 oz bag", 340, 399), {
    pluralName: "chocolate chips",
  }),
  makeIngredient("pantry", "cocoa powder", format("8 oz container", 227, 449)),
  makeIngredient("pantry", "vanilla extract", format("2 fl oz bottle", 59, 599), {
    baseUnit: "ml",
    densityGPerMl: 0.88,
    isStaple: true,
  }),
  makeIngredient("pantry", "baking powder", format("8.1 oz can", 230, 249), {
    isStaple: true,
  }),
  makeIngredient("pantry", "baking soda", format("1 lb box", 454, 149), {
    isStaple: true,
  }),
  makeIngredient("pantry", "active dry yeast", format("4 oz jar", 113, 599), {
    storageClass: "fridge",
    sealedShelfDays: 730,
    openedShelfDays: 120,
  }),
  makeIngredient("pantry", "gelatin", format("4 count box", 28, 249), {
    aliases: ["unflavored gelatin"],
  }),
  makeIngredient("pantry", "ramen noodle", format("6 count package", 510, 249), {
    pluralName: "ramen noodles",
  }),
  makeIngredient("pantry", "cracker", format("13.7 oz box", 388, 399), {
    pluralName: "crackers",
  }),
  makeIngredient("pantry", "canned pumpkin", format("15 oz can", 425, 249), {
    openedShelfDays: 4,
  }),
  makeIngredient("pantry", "applesauce", format("24 oz jar", 680, 299), {
    storageClass: "fridge",
    sealedShelfDays: 365,
    openedShelfDays: 14,
  }),
  makeIngredient("pantry", "jam", format("18 oz jar", 510, 399), {
    storageClass: "fridge",
    sealedShelfDays: 365,
    openedShelfDays: 180,
  }),
  makeIngredient("pantry", "salsa", format("16 oz jar", 454, 349), {
    storageClass: "fridge",
    sealedShelfDays: 365,
    openedShelfDays: 14,
  }),
  makeIngredient("pantry", "enchilada sauce", format("10 oz can", 283, 199), {
    baseUnit: "ml",
    openedShelfDays: 4,
  }),
  makeIngredient("pantry", "barbecue sauce", format("18 oz bottle", 532, 349), {
    baseUnit: "ml",
    storageClass: "fridge",
    sealedShelfDays: 365,
    openedShelfDays: 120,
    aliases: ["BBQ sauce"],
  }),
] satisfies CanonicalIngredient[];

const spiceIngredients = [
  makeIngredient("spice", "kosher salt", format("48 oz box", 1361, 399), {
    isStaple: true,
  }),
  makeIngredient("spice", "table salt", format("26 oz canister", 737, 149), {
    isStaple: true,
  }),
  makeIngredient("spice", "black pepper", format("3 oz jar", 85, 399), {
    isStaple: true,
    aliases: ["ground black pepper"],
  }),
  makeIngredient("spice", "white pepper", format("2 oz jar", 57, 499)),
  makeIngredient("spice", "paprika", format("2.5 oz jar", 71, 299)),
  makeIngredient("spice", "smoked paprika", format("2 oz jar", 57, 399)),
  makeIngredient("spice", "cayenne pepper", format("1.75 oz jar", 50, 299), {
    aliases: ["cayenne"],
  }),
  makeIngredient("spice", "red pepper flake", format("1.5 oz jar", 43, 299), {
    pluralName: "red pepper flakes",
    aliases: ["crushed red pepper"],
  }),
  makeIngredient("spice", "chili powder", format("2.5 oz jar", 71, 299)),
  makeIngredient("spice", "ground cumin", format("2 oz jar", 57, 299)),
  makeIngredient("spice", "cumin seed", format("1.5 oz jar", 43, 349), {
    pluralName: "cumin seeds",
  }),
  makeIngredient("spice", "ground coriander", format("1.5 oz jar", 43, 299)),
  makeIngredient("spice", "coriander seed", format("1.5 oz jar", 43, 349), {
    pluralName: "coriander seeds",
  }),
  makeIngredient("spice", "ground turmeric", format("2 oz jar", 57, 349)),
  makeIngredient("spice", "curry powder", format("2 oz jar", 57, 349)),
  makeIngredient("spice", "garam masala", format("2 oz jar", 57, 449)),
  makeIngredient("spice", "ground cinnamon", format("2.4 oz jar", 68, 299)),
  makeIngredient("spice", "cinnamon stick", format("1.2 oz jar", 34, 399), {
    pluralName: "cinnamon sticks",
  }),
  makeIngredient("spice", "ground nutmeg", format("1.5 oz jar", 43, 399)),
  makeIngredient("spice", "ground ginger", format("1.5 oz jar", 43, 299)),
  makeIngredient("spice", "garlic powder", format("3.4 oz jar", 96, 299)),
  makeIngredient("spice", "onion powder", format("2.6 oz jar", 74, 299)),
  makeIngredient("spice", "dried oregano", format("0.75 oz jar", 21, 249)),
  makeIngredient("spice", "dried basil", format("0.75 oz jar", 21, 249)),
  makeIngredient("spice", "dried thyme", format("0.75 oz jar", 21, 249)),
  makeIngredient("spice", "dried rosemary", format("0.75 oz jar", 21, 249)),
  makeIngredient("spice", "bay leaf", format("0.14 oz jar", 4, 299), {
    pluralName: "bay leaves",
  }),
  makeIngredient("spice", "Italian seasoning", format("0.75 oz jar", 21, 299)),
  makeIngredient("spice", "taco seasoning", format("1 oz packet", 28, 99)),
  makeIngredient("spice", "poultry seasoning", format("0.65 oz jar", 18, 299)),
  makeIngredient("spice", "mustard powder", format("2 oz jar", 57, 349), {
    aliases: ["dry mustard"],
  }),
  makeIngredient("spice", "fennel seed", format("1.5 oz jar", 43, 349), {
    pluralName: "fennel seeds",
  }),
  makeIngredient("spice", "celery seed", format("1.5 oz jar", 43, 349), {
    pluralName: "celery seeds",
  }),
  makeIngredient("spice", "allspice", format("1.5 oz jar", 43, 399)),
  makeIngredient("spice", "ground clove", format("1.4 oz jar", 40, 399), {
    pluralName: "ground cloves",
  }),
] satisfies CanonicalIngredient[];

const frozenIngredients = [
  makeIngredient("frozen", "frozen broccoli", format("12 oz bag", 340, 249), {
    pluralName: "frozen broccoli",
  }),
  makeIngredient("frozen", "frozen mixed vegetable", format("12 oz bag", 340, 199), {
    pluralName: "frozen mixed vegetables",
  }),
  makeIngredient("frozen", "frozen green pea", format("12 oz bag", 340, 199), {
    pluralName: "frozen green peas",
  }),
  makeIngredient("frozen", "frozen corn", format("12 oz bag", 340, 199), {
    pluralName: "frozen corn",
  }),
  makeIngredient("frozen", "frozen spinach", format("10 oz box", 283, 199), {
    pluralName: "frozen spinach",
  }),
  makeIngredient("frozen", "frozen berry blend", format("16 oz bag", 454, 499), {
    pluralName: "frozen berry blend",
  }),
  makeIngredient("frozen", "frozen strawberry", format("16 oz bag", 454, 399), {
    pluralName: "frozen strawberries",
  }),
  makeIngredient("frozen", "frozen french fry", format("32 oz bag", 907, 449), {
    pluralName: "frozen french fries",
  }),
  makeIngredient("frozen", "frozen hash brown", format("30 oz bag", 850, 449), {
    pluralName: "frozen hash browns",
  }),
  makeIngredient("frozen", "frozen pizza dough", format("16 oz dough ball", 454, 399), {
    pluralName: "frozen pizza dough",
  }),
  makeIngredient("frozen", "frozen pie crust", format("2 count package", 2, 449), {
    baseUnit: "count",
    gramsPerCount: 198,
    pluralName: "frozen pie crusts",
  }),
  makeIngredient("frozen", "frozen puff pastry", format("17.3 oz package", 490, 599), {
    pluralName: "frozen puff pastry",
  }),
  makeIngredient("frozen", "frozen ravioli", format("20 oz bag", 567, 599), {
    pluralName: "frozen ravioli",
  }),
  makeIngredient("frozen", "frozen waffle", format("10 count box", 10, 399), {
    baseUnit: "count",
    gramsPerCount: 35,
    pluralName: "frozen waffles",
  }),
  makeIngredient("frozen", "frozen dumpling", format("16 oz bag", 454, 699), {
    pluralName: "frozen dumplings",
    aliases: ["frozen potsticker"],
  }),
] satisfies CanonicalIngredient[];

const bakeryIngredients = [
  makeIngredient("bakery", "sandwich bread", format("20 slice loaf", 20, 349), {
    gramsPerCount: 25,
    pluralName: "sandwich bread",
  }),
  makeIngredient("bakery", "whole wheat bread", format("20 slice loaf", 20, 399), {
    gramsPerCount: 25,
    pluralName: "whole wheat bread",
  }),
  makeIngredient("bakery", "sourdough bread", format("16 slice loaf", 16, 499), {
    gramsPerCount: 32,
    pluralName: "sourdough bread",
  }),
  makeIngredient("bakery", "hamburger bun", format("8 count package", 8, 349), {
    gramsPerCount: 43,
    pluralName: "hamburger buns",
  }),
  makeIngredient("bakery", "hot dog bun", format("8 count package", 8, 349), {
    gramsPerCount: 43,
    pluralName: "hot dog buns",
  }),
  makeIngredient("bakery", "corn tortilla", format("30 count package", 30, 299), {
    gramsPerCount: 25,
    pluralName: "corn tortillas",
  }),
  makeIngredient("bakery", "pita bread", format("6 count package", 6, 399), {
    gramsPerCount: 60,
    pluralName: "pita breads",
  }),
  makeIngredient("bakery", "naan", format("4 count package", 4, 499), {
    gramsPerCount: 90,
    pluralName: "naan",
  }),
  makeIngredient("bakery", "bagel", format("6 count package", 6, 449), {
    gramsPerCount: 95,
  }),
  makeIngredient("bakery", "English muffin", format("6 count package", 6, 399), {
    gramsPerCount: 57,
    pluralName: "English muffins",
  }),
  makeIngredient("bakery", "dinner roll", format("12 count package", 12, 399), {
    gramsPerCount: 38,
    pluralName: "dinner rolls",
  }),
  makeIngredient("bakery", "baguette", format("1 baguette", 1, 299), {
    gramsPerCount: 350,
  }),
] satisfies CanonicalIngredient[];

const otherIngredients = [
  makeIngredient("other", "water", format("33.8 fl oz tap water", 1000, 0), {
    baseUnit: "ml",
    densityGPerMl: 1,
    sealedShelfDays: 3650,
    openedShelfDays: 3650,
    isStaple: true,
  }),
  makeIngredient("other", "ice", format("5 lb bag", 2268, 249), {
    storageClass: "freezer",
    sealedShelfDays: 365,
    openedShelfDays: 365,
    pluralName: "ice",
  }),
  makeIngredient("other", "coffee", format("12 oz bag", 340, 899), {
    openedShelfDays: 30,
  }),
  makeIngredient("other", "black tea", format("20 count box", 20, 399), {
    baseUnit: "count",
    gramsPerCount: 2,
  }),
  makeIngredient("other", "beer", format("12 fl oz bottle", 355, 199), {
    baseUnit: "ml",
    densityGPerMl: 1.01,
  }),
  makeIngredient("other", "dry red wine", format("25.4 fl oz bottle", 750, 999), {
    baseUnit: "ml",
    densityGPerMl: 0.99,
    openedShelfDays: 5,
  }),
  makeIngredient("other", "dry white wine", format("25.4 fl oz bottle", 750, 999), {
    baseUnit: "ml",
    densityGPerMl: 0.99,
    openedShelfDays: 5,
  }),
  makeIngredient("other", "liquid smoke", format("3.5 fl oz bottle", 104, 249), {
    baseUnit: "ml",
    densityGPerMl: 1.01,
  }),
] satisfies CanonicalIngredient[];

/**
 * Checked-in planning estimates for Phase 1. Prices, package sizes, densities,
 * count weights, and shelf lives are intentionally approximate reference data.
 * Retailer reconciliation can replace planning prices without changing stable slugs.
 */
const ingredientManifestInput = [
  ...produceIngredients,
  ...proteinIngredients,
  ...dairyIngredients,
  ...pantryIngredients,
  ...spiceIngredients,
  ...frozenIngredients,
  ...bakeryIngredients,
  ...otherIngredients,
];

export const canonicalIngredients: readonly CanonicalIngredient[] = Object.freeze(
  validateIngredientManifest(ingredientManifestInput),
);
