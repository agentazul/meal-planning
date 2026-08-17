import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export type RecipeStep = Readonly<{
  position: number;
  instruction: string;
}>;

export const memberType = pgEnum("member_type", ["adult", "child"]);
export const presenceEffect = pgEnum("presence_effect", ["present", "absent"]);
export const ingredientCategory = pgEnum("ingredient_category", [
  "produce",
  "protein",
  "dairy",
  "pantry",
  "spice",
  "frozen",
  "bakery",
  "other",
]);
export const ingredientBaseUnit = pgEnum("ingredient_base_unit", [
  "g",
  "ml",
  "count",
]);
export const storageClass = pgEnum("storage_class", [
  "pantry",
  "fridge",
  "freezer",
  "counter",
]);
export const effortTier = pgEnum("effort_tier", [
  "weeknight",
  "weekend",
  "project",
]);
export const recipeSource = pgEnum("recipe_source", [
  "generated",
  "imported",
  "manual",
]);

export const households = pgTable(
  "household",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    timezone: text("timezone").notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check("household_name_not_blank_check", sql`btrim(${table.name}) <> ''`),
    check(
      "household_timezone_not_blank_check",
      sql`btrim(${table.timezone}) <> ''`,
    ),
  ],
);

export const appUsers = pgTable(
  "app_user",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("app_user_email_lower_key").on(
      sql`lower(btrim(${table.email}))`,
    ),
    check(
      "app_user_email_not_blank_check",
      sql`char_length(btrim(${table.email})) > 3`,
    ),
    check(
      "app_user_display_name_not_blank_check",
      sql`${table.displayName} IS NULL OR btrim(${table.displayName}) <> ''`,
    ),
  ],
);

export const householdUsers = pgTable(
  "household_user",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    appUserId: uuid("app_user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("household_user_household_id_app_user_id_key").on(
      table.householdId,
      table.appUserId,
    ),
    index("household_user_app_user_id_idx").on(table.appUserId),
  ],
);

export const householdPreferenceProfiles = pgTable(
  "household_preference_profile",
  {
    householdId: uuid("household_id")
      .primaryKey()
      .references(() => households.id, { onDelete: "cascade" }),
    markdown: text("markdown").notNull(),
    updatedByAppUserId: uuid("updated_by_app_user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("household_preference_profile_updated_by_idx").on(
      table.updatedByAppUserId,
    ),
    check(
      "household_preference_profile_markdown_length_check",
      sql`char_length(${table.markdown}) BETWEEN 1 AND 12000 AND btrim(${table.markdown}) <> ''`,
    ),
    check(
      "household_preference_profile_long_dash_check",
      sql`position(chr(8211) in ${table.markdown}) = 0 AND position(chr(8212) in ${table.markdown}) = 0`,
    ),
    check(
      "household_preference_profile_updated_at_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const authSessions = pgTable(
  "auth_session",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    householdId: uuid("household_id").notNull(),
    appUserId: uuid("app_user_id").notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
    revokedAt: timestamp("revoked_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
  },
  (table) => [
    foreignKey({
      name: "auth_session_household_user_fkey",
      columns: [table.householdId, table.appUserId],
      foreignColumns: [householdUsers.householdId, householdUsers.appUserId],
    }).onDelete("cascade"),
    uniqueIndex("auth_session_token_hash_key").on(table.tokenHash),
    index("auth_session_household_id_app_user_id_idx").on(
      table.householdId,
      table.appUserId,
    ),
    index("auth_session_expires_at_idx").on(table.expiresAt),
    check(
      "auth_session_token_hash_length_check",
      sql`char_length(${table.tokenHash}) = 64`,
    ),
    check(
      "auth_session_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "auth_session_last_seen_check",
      sql`${table.lastSeenAt} >= ${table.createdAt}`,
    ),
    check(
      "auth_session_revoked_at_check",
      sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const magicLinkTokens = pgTable(
  "magic_link_token",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    appUserId: uuid("app_user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
    consumedAt: timestamp("consumed_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
  },
  (table) => [
    uniqueIndex("magic_link_token_token_hash_key").on(table.tokenHash),
    index("magic_link_token_app_user_id_created_at_idx").on(
      table.appUserId,
      table.createdAt,
    ),
    index("magic_link_token_expires_at_idx").on(table.expiresAt),
    check(
      "magic_link_token_token_hash_length_check",
      sql`char_length(${table.tokenHash}) = 64`,
    ),
    check(
      "magic_link_token_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "magic_link_token_consumed_at_check",
      sql`${table.consumedAt} IS NULL OR ${table.consumedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const householdMembers = pgTable(
  "household_member",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    appUserId: uuid("app_user_id"),
    displayName: text("display_name").notNull(),
    memberType: memberType("member_type").notNull(),
    appetiteMultiplier: numeric("appetite_multiplier", {
      mode: "string",
      precision: 4,
      scale: 2,
    })
      .default("1.00")
      .notNull(),
    dietaryNotes: text("dietary_notes"),
    active: boolean("active").default(true).notNull(),
    defaultIsPresent: boolean("default_is_present").default(true).notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("household_member_household_id_id_key").on(
      table.householdId,
      table.id,
    ),
    uniqueIndex("household_member_household_id_app_user_id_key")
      .on(table.householdId, table.appUserId)
      .where(sql`${table.appUserId} IS NOT NULL`),
    foreignKey({
      name: "household_member_household_user_fkey",
      columns: [table.householdId, table.appUserId],
      foreignColumns: [householdUsers.householdId, householdUsers.appUserId],
    }).onDelete("no action"),
    index("household_member_household_id_active_idx").on(
      table.householdId,
      table.active,
    ),
    check(
      "household_member_display_name_not_blank_check",
      sql`btrim(${table.displayName}) <> ''`,
    ),
    check(
      "household_member_appetite_multiplier_check",
      sql`${table.appetiteMultiplier} > 0 AND ${table.appetiteMultiplier} <= 4`,
    ),
  ],
);

export const presenceRules = pgTable(
  "presence_rule",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    householdId: uuid("household_id").notNull(),
    householdMemberId: uuid("household_member_id").notNull(),
    rrule: text("rrule").notNull(),
    effect: presenceEffect("effect").notNull(),
    priority: integer("priority").default(0).notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    effectiveTo: date("effective_to", { mode: "string" }),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "presence_rule_household_member_fkey",
      columns: [table.householdId, table.householdMemberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }).onDelete("cascade"),
    index("presence_rule_member_effective_dates_idx").on(
      table.householdId,
      table.householdMemberId,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    index("presence_rule_member_priority_idx").on(
      table.householdId,
      table.householdMemberId,
      table.priority,
    ),
    check(
      "presence_rule_rrule_not_blank_check",
      sql`btrim(${table.rrule}) <> ''`,
    ),
    check(
      "presence_rule_effective_dates_check",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),
  ],
);

export const presenceOverrides = pgTable(
  "presence_override",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    householdId: uuid("household_id").notNull(),
    householdMemberId: uuid("household_member_id").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    isPresent: boolean("is_present").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "presence_override_household_member_fkey",
      columns: [table.householdId, table.householdMemberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }).onDelete("cascade"),
    unique("presence_override_member_date_key").on(
      table.householdId,
      table.householdMemberId,
      table.date,
    ),
  ],
);

export const canonicalIngredients = pgTable(
  "canonical_ingredient",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    pluralName: text("plural_name").notNull(),
    category: ingredientCategory("category").notNull(),
    baseUnit: ingredientBaseUnit("base_unit").notNull(),
    densityGramsPerMl: numeric("density_g_per_ml", {
      mode: "string",
      precision: 12,
      scale: 6,
    }),
    gramsPerCount: numeric("grams_per_count", {
      mode: "string",
      precision: 12,
      scale: 3,
    }),
    storageClass: storageClass("storage_class").notNull(),
    shelfLifeSealedDays: integer("shelf_life_sealed_days").notNull(),
    shelfLifeOpenedDays: integer("shelf_life_opened_days").notNull(),
    survivalProbability: numeric("survival_probability", {
      mode: "string",
      precision: 5,
      scale: 4,
    }).notNull(),
    isStaple: boolean("is_staple").default(false).notNull(),
    aliases: text("aliases")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("canonical_ingredient_name_lower_key").on(
      sql`lower(btrim(${table.name}))`,
    ),
    index("canonical_ingredient_category_idx").on(table.category),
    check(
      "canonical_ingredient_name_not_blank_check",
      sql`btrim(${table.name}) <> ''`,
    ),
    check(
      "canonical_ingredient_plural_name_not_blank_check",
      sql`btrim(${table.pluralName}) <> ''`,
    ),
    check(
      "canonical_ingredient_density_check",
      sql`${table.densityGramsPerMl} IS NULL OR ${table.densityGramsPerMl} > 0`,
    ),
    check(
      "canonical_ingredient_grams_per_count_check",
      sql`${table.gramsPerCount} IS NULL OR ${table.gramsPerCount} > 0`,
    ),
    check(
      "canonical_ingredient_shelf_life_check",
      sql`${table.shelfLifeSealedDays} >= 0 AND ${table.shelfLifeOpenedDays} >= 0`,
    ),
    check(
      "canonical_ingredient_survival_probability_check",
      sql`${table.survivalProbability} >= 0 AND ${table.survivalProbability} <= 1`,
    ),
  ],
);

export const purchaseFormats = pgTable(
  "purchase_format",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    canonicalIngredientId: uuid("canonical_ingredient_id").notNull(),
    description: text("description").notNull(),
    quantityInBaseUnit: numeric("quantity_in_base_unit", {
      mode: "string",
      precision: 14,
      scale: 3,
    }).notNull(),
    typicalPriceCents: integer("typical_price_cents").notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "purchase_format_ingredient_fkey",
      columns: [table.canonicalIngredientId],
      foreignColumns: [canonicalIngredients.id],
    }).onDelete("restrict"),
    uniqueIndex("purchase_format_ingredient_description_lower_key").on(
      table.canonicalIngredientId,
      sql`lower(btrim(${table.description}))`,
    ),
    uniqueIndex("purchase_format_one_default_per_ingredient_key")
      .on(table.canonicalIngredientId)
      .where(sql`${table.isDefault} = true`),
    index("purchase_format_canonical_ingredient_id_idx").on(
      table.canonicalIngredientId,
    ),
    check(
      "purchase_format_description_not_blank_check",
      sql`btrim(${table.description}) <> ''`,
    ),
    check(
      "purchase_format_quantity_check",
      sql`${table.quantityInBaseUnit} > 0`,
    ),
    check("purchase_format_price_check", sql`${table.typicalPriceCents} >= 0`),
  ],
);

export const pantryItems = pgTable(
  "pantry_item",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    canonicalIngredientId: uuid("canonical_ingredient_id").notNull(),
    quantity: numeric("quantity", {
      mode: "string",
      precision: 14,
      scale: 3,
    }).notNull(),
    unit: text("unit").notNull(),
    quantityInBaseUnit: numeric("quantity_in_base_unit", {
      mode: "string",
      precision: 14,
      scale: 3,
    }).notNull(),
    updatedByAppUserId: uuid("updated_by_app_user_id").notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "pantry_item_ingredient_fkey",
      columns: [table.canonicalIngredientId],
      foreignColumns: [canonicalIngredients.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "pantry_item_updated_by_household_user_fkey",
      columns: [table.householdId, table.updatedByAppUserId],
      foreignColumns: [householdUsers.householdId, householdUsers.appUserId],
    }).onDelete("restrict"),
    unique("pantry_item_household_id_id_key").on(table.householdId, table.id),
    unique("pantry_item_household_ingredient_key").on(
      table.householdId,
      table.canonicalIngredientId,
    ),
    index("pantry_item_canonical_ingredient_id_idx").on(
      table.canonicalIngredientId,
    ),
    index("pantry_item_household_updated_at_idx").on(
      table.householdId,
      table.updatedAt,
    ),
    check("pantry_item_quantity_check", sql`${table.quantity} >= 0`),
    check(
      "pantry_item_base_quantity_check",
      sql`${table.quantityInBaseUnit} >= 0`,
    ),
    check("pantry_item_unit_not_blank_check", sql`btrim(${table.unit}) <> ''`),
    check(
      "pantry_item_updated_at_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const pantryCustomItems = pgTable(
  "pantry_custom_item",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    baseUnit: ingredientBaseUnit("base_unit").notNull(),
    storageClass: storageClass("storage_class").notNull(),
    quantity: numeric("quantity", {
      mode: "string",
      precision: 14,
      scale: 3,
    }).notNull(),
    unit: text("unit").notNull(),
    quantityInBaseUnit: numeric("quantity_in_base_unit", {
      mode: "string",
      precision: 14,
      scale: 3,
    }).notNull(),
    updatedByAppUserId: uuid("updated_by_app_user_id").notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "pantry_custom_item_updated_by_household_user_fkey",
      columns: [table.householdId, table.updatedByAppUserId],
      foreignColumns: [householdUsers.householdId, householdUsers.appUserId],
    }).onDelete("restrict"),
    unique("pantry_custom_item_household_id_id_key").on(
      table.householdId,
      table.id,
    ),
    unique("pantry_custom_item_household_name_key").on(
      table.householdId,
      table.nameKey,
    ),
    index("pantry_custom_item_household_updated_at_idx").on(
      table.householdId,
      table.updatedAt,
    ),
    check(
      "pantry_custom_item_name_not_blank_check",
      sql`btrim(${table.name}) <> ''`,
    ),
    check(
      "pantry_custom_item_name_key_not_blank_check",
      sql`btrim(${table.nameKey}) <> ''`,
    ),
    check("pantry_custom_item_quantity_check", sql`${table.quantity} >= 0`),
    check(
      "pantry_custom_item_base_quantity_check",
      sql`${table.quantityInBaseUnit} >= 0`,
    ),
    check(
      "pantry_custom_item_unit_not_blank_check",
      sql`btrim(${table.unit}) <> ''`,
    ),
    check(
      "pantry_custom_item_updated_at_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const recipes = pgTable(
  "recipe",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    baseServings: integer("base_servings").notNull(),
    activeTimeMinutes: integer("active_time_min").notNull(),
    totalTimeMinutes: integer("total_time_min").notNull(),
    effortTier: effortTier("effort_tier").notNull(),
    cuisine: text("cuisine"),
    primaryProtein: text("primary_protein"),
    techniques: text("techniques")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    source: recipeSource("source").default("manual").notNull(),
    sourceUrl: text("source_url"),
    instructions: jsonb("instructions")
      .$type<readonly RecipeStep[]>()
      .notNull(),
    minInternalTemperatureF: integer("min_internal_temp_f"),
    inRotation: boolean("in_rotation").default(false).notNull(),
    timesCooked: integer("times_cooked").default(0).notNull(),
    lastCookedAt: date("last_cooked_at", { mode: "string" }),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("recipe_household_id_id_key").on(table.householdId, table.id),
    index("recipe_household_id_created_at_idx").on(
      table.householdId,
      table.createdAt,
    ),
    index("recipe_household_id_rotation_idx").on(
      table.householdId,
      table.inRotation,
    ),
    index("recipe_household_id_title_lower_idx").on(
      table.householdId,
      sql`lower(${table.title})`,
    ),
    check("recipe_title_not_blank_check", sql`btrim(${table.title}) <> ''`),
    check("recipe_base_servings_check", sql`${table.baseServings} > 0`),
    check(
      "recipe_time_check",
      sql`${table.activeTimeMinutes} >= 0 AND ${table.totalTimeMinutes} >= ${table.activeTimeMinutes}`,
    ),
    check(
      "recipe_instructions_array_check",
      sql`jsonb_typeof(${table.instructions}) = 'array'`,
    ),
    check(
      "recipe_internal_temperature_check",
      sql`${table.minInternalTemperatureF} IS NULL OR (${table.minInternalTemperatureF} >= 32 AND ${table.minInternalTemperatureF} <= 500)`,
    ),
    check("recipe_times_cooked_check", sql`${table.timesCooked} >= 0`),
  ],
);

export const substitutionGroups = pgTable(
  "substitution_group",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    householdId: uuid("household_id").notNull(),
    recipeId: uuid("recipe_id").notNull(),
    label: text("label").notNull(),
  },
  (table) => [
    foreignKey({
      name: "substitution_group_recipe_fkey",
      columns: [table.householdId, table.recipeId],
      foreignColumns: [recipes.householdId, recipes.id],
    }).onDelete("cascade"),
    unique("substitution_group_household_recipe_id_key").on(
      table.householdId,
      table.recipeId,
      table.id,
    ),
    uniqueIndex("substitution_group_recipe_label_lower_key").on(
      table.householdId,
      table.recipeId,
      sql`lower(btrim(${table.label}))`,
    ),
    check(
      "substitution_group_label_not_blank_check",
      sql`btrim(${table.label}) <> ''`,
    ),
  ],
);

export const substitutionOptions = pgTable(
  "substitution_option",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    householdId: uuid("household_id").notNull(),
    recipeId: uuid("recipe_id").notNull(),
    substitutionGroupId: uuid("substitution_group_id").notNull(),
    canonicalIngredientId: uuid("canonical_ingredient_id").notNull(),
    conversionRatio: numeric("conversion_ratio", {
      mode: "string",
      precision: 12,
      scale: 6,
    }).notNull(),
  },
  (table) => [
    foreignKey({
      name: "substitution_option_ingredient_fkey",
      columns: [table.canonicalIngredientId],
      foreignColumns: [canonicalIngredients.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "substitution_option_group_fkey",
      columns: [table.householdId, table.recipeId, table.substitutionGroupId],
      foreignColumns: [
        substitutionGroups.householdId,
        substitutionGroups.recipeId,
        substitutionGroups.id,
      ],
    }).onDelete("cascade"),
    unique("substitution_option_group_ingredient_key").on(
      table.householdId,
      table.substitutionGroupId,
      table.canonicalIngredientId,
    ),
    index("substitution_option_canonical_ingredient_id_idx").on(
      table.canonicalIngredientId,
    ),
    check(
      "substitution_option_conversion_ratio_check",
      sql`${table.conversionRatio} > 0`,
    ),
  ],
);

export const recipeIngredients = pgTable(
  "recipe_ingredient",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    householdId: uuid("household_id").notNull(),
    recipeId: uuid("recipe_id").notNull(),
    position: integer("position").notNull(),
    canonicalIngredientId: uuid("canonical_ingredient_id").notNull(),
    quantity: numeric("quantity", {
      mode: "string",
      precision: 14,
      scale: 3,
    }).notNull(),
    unit: text("unit").notNull(),
    quantityInBaseUnit: numeric("quantity_in_base_unit", {
      mode: "string",
      precision: 14,
      scale: 3,
    }).notNull(),
    preparation: text("preparation"),
    isOptional: boolean("is_optional").default(false).notNull(),
    scalesLinearly: boolean("scales_linearly").default(true).notNull(),
    substitutionGroupId: uuid("substitution_group_id"),
  },
  (table) => [
    foreignKey({
      name: "recipe_ingredient_canonical_fkey",
      columns: [table.canonicalIngredientId],
      foreignColumns: [canonicalIngredients.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "recipe_ingredient_recipe_fkey",
      columns: [table.householdId, table.recipeId],
      foreignColumns: [recipes.householdId, recipes.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "recipe_ingredient_substitution_group_fkey",
      columns: [table.householdId, table.recipeId, table.substitutionGroupId],
      foreignColumns: [
        substitutionGroups.householdId,
        substitutionGroups.recipeId,
        substitutionGroups.id,
      ],
    }).onDelete("no action"),
    unique("recipe_ingredient_recipe_position_key").on(
      table.householdId,
      table.recipeId,
      table.position,
    ),
    index("recipe_ingredient_canonical_ingredient_id_idx").on(
      table.canonicalIngredientId,
    ),
    check("recipe_ingredient_quantity_check", sql`${table.quantity} > 0`),
    check("recipe_ingredient_position_check", sql`${table.position} > 0`),
    check(
      "recipe_ingredient_unit_not_blank_check",
      sql`btrim(${table.unit}) <> ''`,
    ),
    check(
      "recipe_ingredient_base_quantity_check",
      sql`${table.quantityInBaseUnit} > 0`,
    ),
  ],
);

export const mealPlans = pgTable(
  "meal_plan",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    weekStartDate: date("week_start_date", { mode: "string" }).notNull(),
    status: text("status", {
      enum: ["draft", "shopping", "ordered", "active", "closed"],
    })
      .default("draft")
      .notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("meal_plan_household_id_id_key").on(table.householdId, table.id),
    unique("meal_plan_household_week_key").on(
      table.householdId,
      table.weekStartDate,
    ),
    index("meal_plan_household_id_status_idx").on(
      table.householdId,
      table.status,
    ),
    check(
      "meal_plan_status_check",
      sql`${table.status} IN ('draft', 'shopping', 'ordered', 'active', 'closed')`,
    ),
  ],
);

export const weeklyGenerationRuns = pgTable(
  "weekly_generation_run",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    householdId: uuid("household_id").notNull(),
    requestedByAppUserId: uuid("requested_by_app_user_id").notNull(),
    mealPlanId: uuid("meal_plan_id"),
    weekStartDate: date("week_start_date", { mode: "string" }).notNull(),
    status: text("status", {
      enum: ["ready", "materializing", "accepted", "failed", "superseded"],
    })
      .default("ready")
      .notNull(),
    model: text("model").notNull(),
    catalogFingerprint: varchar("catalog_fingerprint", {
      length: 43,
    }).notNull(),
    dietaryNotesFingerprint: varchar("dietary_notes_fingerprint", {
      length: 43,
    }).notNull(),
    preferenceFingerprint: varchar("preference_fingerprint", {
      length: 43,
    }).notNull(),
    slots: jsonb("slots").$type<unknown>().notNull(),
    candidates: jsonb("candidates").$type<unknown>().notNull(),
    selection: jsonb("selection").$type<unknown>().notNull(),
    rerollHistory: jsonb("reroll_history").$type<unknown>().notNull(),
    usage: jsonb("usage").$type<unknown>().notNull(),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
    acceptedAt: timestamp("accepted_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }),
  },
  (table) => [
    foreignKey({
      name: "weekly_generation_run_household_fkey",
      columns: [table.householdId],
      foreignColumns: [households.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "weekly_generation_run_requester_fkey",
      columns: [table.householdId, table.requestedByAppUserId],
      foreignColumns: [householdUsers.householdId, householdUsers.appUserId],
    }).onDelete("no action"),
    foreignKey({
      name: "weekly_generation_run_meal_plan_fkey",
      columns: [table.householdId, table.mealPlanId],
      foreignColumns: [mealPlans.householdId, mealPlans.id],
    }).onDelete("no action"),
    unique("weekly_generation_run_household_id_id_key").on(
      table.householdId,
      table.id,
    ),
    index("weekly_generation_run_household_week_idx").on(
      table.householdId,
      table.weekStartDate,
      table.createdAt,
    ),
    index("weekly_generation_run_household_status_idx").on(
      table.householdId,
      table.status,
      table.expiresAt,
    ),
    check(
      "weekly_generation_run_status_check",
      sql`${table.status} IN ('ready', 'materializing', 'accepted', 'failed', 'superseded')`,
    ),
    check(
      "weekly_generation_run_model_check",
      sql`btrim(${table.model}) <> ''`,
    ),
    check(
      "weekly_generation_run_fingerprint_check",
      sql`char_length(${table.catalogFingerprint}) = 43 AND char_length(${table.dietaryNotesFingerprint}) = 43 AND char_length(${table.preferenceFingerprint}) = 43`,
    ),
    check(
      "weekly_generation_run_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "weekly_generation_run_acceptance_check",
      sql`(${table.status} = 'accepted' AND ${table.acceptedAt} IS NOT NULL AND ${table.mealPlanId} IS NOT NULL) OR (${table.status} <> 'accepted' AND ${table.acceptedAt} IS NULL)`,
    ),
  ],
);

export const weeklyGenerationBuilds = pgTable(
  "weekly_generation_build",
  {
    householdId: uuid("household_id").notNull(),
    weekStartDate: date("week_start_date", { mode: "string" }).notNull(),
    ownerToken: uuid("owner_token").defaultRandom().notNull(),
    requestedByAppUserId: uuid("requested_by_app_user_id").notNull(),
    phase: text("phase", { enum: ["candidates"] })
      .default("candidates")
      .notNull(),
    runId: uuid("run_id"),
    startedAt: timestamp("started_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "weekly_generation_build_pkey",
      columns: [table.householdId, table.weekStartDate],
    }),
    foreignKey({
      name: "weekly_generation_build_household_fkey",
      columns: [table.householdId],
      foreignColumns: [households.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "weekly_generation_build_requester_fkey",
      columns: [table.householdId, table.requestedByAppUserId],
      foreignColumns: [householdUsers.householdId, householdUsers.appUserId],
    }).onDelete("no action"),
    foreignKey({
      name: "weekly_generation_build_run_fkey",
      columns: [table.householdId, table.runId],
      foreignColumns: [
        weeklyGenerationRuns.householdId,
        weeklyGenerationRuns.id,
      ],
    }).onDelete("cascade"),
    index("weekly_generation_build_lease_idx").on(
      table.householdId,
      table.leaseExpiresAt,
    ),
    index("weekly_generation_build_owner_idx").on(table.ownerToken),
    check(
      "weekly_generation_build_phase_check",
      sql`${table.phase} IN ('candidates')`,
    ),
    check(
      "weekly_generation_build_lease_check",
      sql`${table.leaseExpiresAt} > ${table.startedAt}`,
    ),
  ],
);

export const planEntries = pgTable(
  "plan_entry",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    householdId: uuid("household_id").notNull(),
    mealPlanId: uuid("meal_plan_id").notNull(),
    recipeId: uuid("recipe_id").notNull(),
    scheduledDate: date("scheduled_date", { mode: "string" }),
    servingsTarget: integer("servings_target").notNull(),
    leftoverBufferServings: integer("leftover_buffer_servings")
      .default(0)
      .notNull(),
    status: text("status", {
      enum: ["planned", "bench", "cooked", "skipped", "swapped_out"],
    })
      .default("planned")
      .notNull(),
    benchRank: integer("bench_rank"),
    sequenceHint: integer("sequence_hint").default(0).notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "plan_entry_meal_plan_fkey",
      columns: [table.householdId, table.mealPlanId],
      foreignColumns: [mealPlans.householdId, mealPlans.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "plan_entry_recipe_fkey",
      columns: [table.householdId, table.recipeId],
      foreignColumns: [recipes.householdId, recipes.id],
    }).onDelete("no action"),
    uniqueIndex("plan_entry_scheduled_dinner_key")
      .on(table.householdId, table.mealPlanId, table.scheduledDate)
      .where(sql`${table.scheduledDate} IS NOT NULL`),
    index("plan_entry_meal_plan_status_idx").on(
      table.householdId,
      table.mealPlanId,
      table.status,
    ),
    index("plan_entry_recipe_id_idx").on(table.householdId, table.recipeId),
    check(
      "plan_entry_servings_target_check",
      sql`${table.servingsTarget} >= 0`,
    ),
    check(
      "plan_entry_leftover_buffer_check",
      sql`${table.leftoverBufferServings} >= 0`,
    ),
    check(
      "plan_entry_status_check",
      sql`${table.status} IN ('planned', 'bench', 'cooked', 'skipped', 'swapped_out')`,
    ),
    check(
      "plan_entry_schedule_check",
      sql`(${table.status} = 'bench' AND ${table.scheduledDate} IS NULL AND ${table.benchRank} IS NOT NULL) OR (${table.status} <> 'bench' AND ${table.scheduledDate} IS NOT NULL AND ${table.benchRank} IS NULL)`,
    ),
    check(
      "plan_entry_bench_rank_check",
      sql`${table.benchRank} IS NULL OR ${table.benchRank} > 0`,
    ),
    check("plan_entry_sequence_hint_check", sql`${table.sequenceHint} >= 0`),
  ],
);

export const eventLogs = pgTable(
  "event_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload")
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("event_log_household_id_created_at_idx").on(
      table.householdId,
      table.createdAt,
    ),
    index("event_log_household_id_event_type_idx").on(
      table.householdId,
      table.eventType,
    ),
    check(
      "event_log_event_type_not_blank_check",
      sql`btrim(${table.eventType}) <> ''`,
    ),
    check(
      "event_log_payload_object_check",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
  ],
);
