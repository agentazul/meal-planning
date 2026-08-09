import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { eventLogs, householdPreferenceProfiles } from "~/db/schema";
import type { ScopedDatabase } from "~/server/context.server";

export const KITCHEN_PREFERENCES_MAX_LENGTH = 12_000;

export const STARTER_KITCHEN_PREFERENCES = `# Our kitchen preferences

Use this page as the shared note for how your household likes to eat. Keep it practical and update it whenever family needs change.

## Safety first

- Allergies and medical dietary needs: Not entered yet. Add every household restriction before relying on this profile.
- Keep spice mild by default and offer extra heat at the table.
- Use food-safe handling and standard minimum internal temperatures.

## Weeknight rhythm

- Aim for familiar, family-style dinners with a vegetable.
- Prefer about 30 minutes of active cooking on school nights.
- Keep cleanup reasonable and use one-pan meals when they make sense.

## People at our table

- Note individual spice tolerance, texture preferences, and portion needs here.

## Equipment we use

- Oven, stovetop, sheet pans, pots, skillets, and a slow cooker.

## Foods and cuisines

- Proteins in rotation: chicken, beef, pork, fish, beans, and eggs.
- Cuisines we want more of: Add favorites here.
- Hard nos: Add ingredients or dishes the household does not want here.
`;

const longDashPattern = /[\u2013\u2014]/u;

export const kitchenPreferencesMarkdownSchema = z
  .string({ error: "Kitchen preferences must be text." })
  .transform((value) => value.replace(/\r\n?/g, "\n").trim())
  .pipe(
    z
      .string()
      .min(1, "Add at least one kitchen preference.")
      .max(
        KITCHEN_PREFERENCES_MAX_LENGTH,
        `Keep kitchen preferences under ${KITCHEN_PREFERENCES_MAX_LENGTH.toLocaleString("en-US")} characters.`,
      )
      .refine(
        (value) => !longDashPattern.test(value),
        "Use a regular hyphen instead of a long dash.",
      ),
  );

export type HouseholdKitchenPreferences = Readonly<{
  isStarter: boolean;
  markdown: string;
  updatedAt: Date | null;
}>;

export class KitchenPreferencesValidationError extends Error {
  override readonly name = "KitchenPreferencesValidationError";

  constructor(readonly userMessage: string) {
    super(userMessage);
  }
}

function parseMarkdown(markdown: string): string {
  const parsed = kitchenPreferencesMarkdownSchema.safeParse(markdown);
  if (!parsed.success) {
    throw new KitchenPreferencesValidationError(
      parsed.error.issues[0]?.message ??
        "Check the kitchen preferences and try again.",
    );
  }
  return parsed.data;
}

export async function getHouseholdKitchenPreferences(
  scoped: ScopedDatabase,
): Promise<HouseholdKitchenPreferences> {
  const [profile] = await scoped.db
    .select({
      markdown: householdPreferenceProfiles.markdown,
      updatedAt: householdPreferenceProfiles.updatedAt,
    })
    .from(householdPreferenceProfiles)
    .where(
      eq(
        householdPreferenceProfiles.householdId,
        scoped.scope.householdId,
      ),
    )
    .limit(1);

  if (!profile) {
    return {
      isStarter: true,
      markdown: STARTER_KITCHEN_PREFERENCES,
      updatedAt: null,
    };
  }

  return {
    isStarter: false,
    markdown: profile.markdown,
    updatedAt: profile.updatedAt,
  };
}

export async function saveHouseholdKitchenPreferences(
  scoped: ScopedDatabase,
  input: Readonly<{ markdown: string }>,
): Promise<Readonly<{ markdown: string; updatedAt: Date }>> {
  const markdown = parseMarkdown(input.markdown);

  return scoped.db.transaction(async (transaction) => {
    const [saved] = await transaction
      .insert(householdPreferenceProfiles)
      .values({
        householdId: scoped.scope.householdId,
        markdown,
        updatedByAppUserId: scoped.scope.userId,
      })
      .onConflictDoUpdate({
        set: {
          markdown,
          updatedAt: sql`now()`,
          updatedByAppUserId: scoped.scope.userId,
        },
        target: householdPreferenceProfiles.householdId,
      })
      .returning({
        markdown: householdPreferenceProfiles.markdown,
        updatedAt: householdPreferenceProfiles.updatedAt,
      });

    if (!saved) {
      throw new Error("Kitchen preferences were not saved.");
    }

    await transaction.insert(eventLogs).values({
      eventType: "household.preferences_updated",
      householdId: scoped.scope.householdId,
      payload: {
        characterCount: markdown.length,
        userId: scoped.scope.userId,
      },
    });

    return saved;
  });
}
