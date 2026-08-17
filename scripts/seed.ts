import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";

import {
  deriveHouseholdMemberId,
  resolveHouseholdSeedProfiles,
} from "../app/data/household-seed-profiles";
import { canonicalIngredients as ingredientManifest } from "../app/data/ingredients";
import { getPostgresConnectionOptions } from "../app/db/postgres-options";
import {
  appUsers,
  canonicalIngredients,
  eventLogs,
  householdMembers,
  households,
  householdUsers,
  purchaseFormats,
} from "../app/db/schema";
import { loadLocalEnvironment } from "./load-env";

loadLocalEnvironment([".env.seed.local", ".env.local", ".env"]);

const seedEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  HOUSEHOLD_ADULT_EMAILS: z.string().optional(),
  HOUSEHOLD_MEMBER_PROFILES_JSON: z.string().optional(),
  HOUSEHOLD_NAME: z.string().trim().min(1).default("Our household"),
  HOUSEHOLD_SEED_DRY_RUN: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  HOUSEHOLD_TIMEZONE: z.string().trim().min(1).default("America/Chicago"),
});

const env = seedEnvSchema.parse(process.env);
const isDryRun =
  env.HOUSEHOLD_SEED_DRY_RUN || process.argv.includes("--dry-run");
const memberProfiles = resolveHouseholdSeedProfiles({
  legacyAdultEmails: env.HOUSEHOLD_ADULT_EMAILS,
  profilesJson: env.HOUSEHOLD_MEMBER_PROFILES_JSON,
});
const loginProfileCount = memberProfiles.filter(
  (profile) => profile.email !== null,
).length;

new Intl.DateTimeFormat("en-US", { timeZone: env.HOUSEHOLD_TIMEZONE });

const client = postgres(
  env.DATABASE_URL,
  getPostgresConnectionOptions(env.DATABASE_URL),
);
const db = drizzle({ client });

type SeedSummary = Readonly<{
  formatCount: number;
  ingredientCount: number;
  loginUserCount: number;
  memberCount: number;
}>;

class SeedDryRunRollback extends Error {
  override readonly name = "SeedDryRunRollback";

  constructor(readonly summary: SeedSummary) {
    super("Household seed dry run completed; rolling back intentionally");
  }
}

function describeSeedSummary(summary: SeedSummary): string {
  return `${summary.loginUserCount} login users, ${summary.memberCount} household members, ${summary.ingredientCount} ingredients, and ${summary.formatCount} purchase formats`;
}

try {
  const result = await db.transaction(async (transaction): Promise<SeedSummary> => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('meal-planning.household-seed', 0::bigint))`,
    );

    const [existingHousehold] = await transaction
      .select({ id: households.id })
      .from(households)
      .where(
        and(
          eq(households.name, env.HOUSEHOLD_NAME),
          eq(households.timezone, env.HOUSEHOLD_TIMEZONE),
        ),
      )
      .limit(1);

    const householdId =
      existingHousehold?.id ??
      (
        await transaction
          .insert(households)
          .values({
            name: env.HOUSEHOLD_NAME,
            timezone: env.HOUSEHOLD_TIMEZONE,
          })
          .returning({ id: households.id })
      )[0]?.id;

    if (!householdId) {
      throw new Error("Household seed failed");
    }

    const loginUserIds = new Map<string, string>();

    for (const person of memberProfiles) {
      if (person.email === null) continue;

      const [existingUser] = await transaction
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(sql`lower(btrim(${appUsers.email})) = ${person.email}`)
        .limit(1);

      const appUserId =
        existingUser?.id ??
        (
          await transaction
            .insert(appUsers)
            .values({
              displayName: person.displayName,
              email: person.email,
            })
            .returning({ id: appUsers.id })
        )[0]?.id;

      if (!appUserId) {
        throw new Error(`User seed failed for ${person.email}`);
      }

      await transaction
        .update(appUsers)
        .set({ active: true, displayName: person.displayName })
        .where(eq(appUsers.id, appUserId));

      const existingMemberships = await transaction
        .select({ householdId: householdUsers.householdId })
        .from(householdUsers)
        .where(eq(householdUsers.appUserId, appUserId));

      if (
        existingMemberships.some(
          (membership) => membership.householdId !== householdId,
        )
      ) {
        throw new Error(
          `Seed user ${person.email} already belongs to another household`,
        );
      }

      await transaction
        .insert(householdUsers)
        .values({ appUserId, householdId })
        .onConflictDoNothing({
          target: [householdUsers.householdId, householdUsers.appUserId],
        });

      loginUserIds.set(person.email, appUserId);
    }

    const existingMembers = await transaction
      .select({
        appUserId: householdMembers.appUserId,
        displayName: householdMembers.displayName,
        id: householdMembers.id,
      })
      .from(householdMembers)
      .where(eq(householdMembers.householdId, householdId));

    for (const person of memberProfiles) {
      const appUserId = person.email
        ? loginUserIds.get(person.email) ?? null
        : null;

      if (person.email !== null && appUserId === null) {
        throw new Error(`Login user seed failed for profile ${person.seedKey}`);
      }

      const deterministicMemberId =
        appUserId === null
          ? deriveHouseholdMemberId(householdId, person.seedKey)
          : null;
      const existingMember =
        existingMembers.find((member) =>
          appUserId === null
            ? member.id === deterministicMemberId
            : member.appUserId === appUserId,
        ) ??
        (appUserId === null
          ? existingMembers.find(
              (member) =>
                member.appUserId === null &&
                member.displayName.trim().toLowerCase() ===
                  person.displayName.trim().toLowerCase(),
            )
          : undefined);

      if (existingMember) {
        await transaction
          .update(householdMembers)
          .set({
            appetiteMultiplier: person.appetiteMultiplier,
            displayName: person.displayName,
            memberType: person.memberType,
          })
          .where(
            and(
              eq(householdMembers.householdId, householdId),
              eq(householdMembers.id, existingMember.id),
            ),
          );
        continue;
      }

      const memberValues = {
        appUserId,
        appetiteMultiplier: person.appetiteMultiplier,
        displayName: person.displayName,
        householdId,
        memberType: person.memberType,
      } as const;

      await transaction
        .insert(householdMembers)
        .values(
          deterministicMemberId === null
            ? memberValues
            : { ...memberValues, id: deterministicMemberId },
        );
    }

    const existingIngredientRows = await transaction
      .select({ id: canonicalIngredients.id, name: canonicalIngredients.name })
      .from(canonicalIngredients);
    const ingredientIdsByName = new Map(
      existingIngredientRows.map((ingredient) => [
        ingredient.name.trim().toLowerCase(),
        ingredient.id,
      ]),
    );

    let formatCount = 0;

    for (const ingredient of ingredientManifest) {
      const normalizedName = ingredient.name.trim().toLowerCase();
      let ingredientId = ingredientIdsByName.get(normalizedName);

      if (ingredientId) {
        await transaction
          .update(canonicalIngredients)
          .set({
            aliases: [...ingredient.aliases],
            baseUnit: ingredient.baseUnit,
            category: ingredient.category,
            densityGramsPerMl: ingredient.densityGPerMl,
            gramsPerCount: ingredient.gramsPerCount,
            isStaple: ingredient.isStaple,
            pluralName: ingredient.pluralName,
            shelfLifeOpenedDays: ingredient.openedShelfDays,
            shelfLifeSealedDays: ingredient.sealedShelfDays,
            storageClass: ingredient.storageClass,
            survivalProbability: ingredient.survivalProbability,
          })
          .where(eq(canonicalIngredients.id, ingredientId));
      } else {
        ingredientId = (
          await transaction
            .insert(canonicalIngredients)
            .values({
              aliases: [...ingredient.aliases],
              baseUnit: ingredient.baseUnit,
              category: ingredient.category,
              densityGramsPerMl: ingredient.densityGPerMl,
              gramsPerCount: ingredient.gramsPerCount,
              isStaple: ingredient.isStaple,
              name: ingredient.name,
              pluralName: ingredient.pluralName,
              shelfLifeOpenedDays: ingredient.openedShelfDays,
              shelfLifeSealedDays: ingredient.sealedShelfDays,
              storageClass: ingredient.storageClass,
              survivalProbability: ingredient.survivalProbability,
            })
            .returning({ id: canonicalIngredients.id })
        )[0]?.id;

        if (!ingredientId) {
          throw new Error(`Ingredient seed failed for ${ingredient.name}`);
        }
        ingredientIdsByName.set(normalizedName, ingredientId);
      }

      await transaction
        .update(purchaseFormats)
        .set({ isDefault: false })
        .where(eq(purchaseFormats.canonicalIngredientId, ingredientId));

      const existingFormats = await transaction
        .select({
          description: purchaseFormats.description,
          id: purchaseFormats.id,
        })
        .from(purchaseFormats)
        .where(eq(purchaseFormats.canonicalIngredientId, ingredientId));

      for (const purchaseFormat of ingredient.formats) {
        const existingFormat = existingFormats.find(
          (candidate) =>
            candidate.description.trim().toLowerCase() ===
            purchaseFormat.description.trim().toLowerCase(),
        );

        if (existingFormat) {
          await transaction
            .update(purchaseFormats)
            .set({
              isDefault: purchaseFormat.isDefault,
              quantityInBaseUnit: purchaseFormat.quantityInBaseUnit,
              typicalPriceCents: purchaseFormat.typicalPriceCents,
            })
            .where(eq(purchaseFormats.id, existingFormat.id));
        } else {
          await transaction.insert(purchaseFormats).values({
            canonicalIngredientId: ingredientId,
            description: purchaseFormat.description,
            isDefault: purchaseFormat.isDefault,
            quantityInBaseUnit: purchaseFormat.quantityInBaseUnit,
            typicalPriceCents: purchaseFormat.typicalPriceCents,
          });
        }
        formatCount += 1;
      }
    }

    const summary: SeedSummary = {
      formatCount,
      ingredientCount: ingredientManifest.length,
      loginUserCount: loginProfileCount,
      memberCount: memberProfiles.length,
    };

    await transaction.insert(eventLogs).values({
      eventType: "foundation.seed_completed",
      householdId,
      payload: {
        ingredientCount: summary.ingredientCount,
        loginUserCount: summary.loginUserCount,
        memberCount: summary.memberCount,
        purchaseFormatCount: formatCount,
      },
    });

    if (isDryRun) {
      throw new SeedDryRunRollback(summary);
    }

    return summary;
  });

  console.info(`Seeded household with ${describeSeedSummary(result)}.`);
} catch (error) {
  if (!(error instanceof SeedDryRunRollback)) throw error;

  console.info(
    `Seed dry run completed and rolled back. Would seed ${describeSeedSummary(error.summary)}.`,
  );
} finally {
  await client.end();
}
