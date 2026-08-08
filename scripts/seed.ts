import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";

import { canonicalIngredients as ingredientManifest } from "../app/data/ingredients";
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

loadLocalEnvironment();

const seedEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  HOUSEHOLD_ADULT_EMAILS: z.string().min(1),
  HOUSEHOLD_NAME: z.string().trim().min(1).default("Our household"),
  HOUSEHOLD_TIMEZONE: z.string().trim().min(1).default("America/Chicago"),
});

const env = seedEnvSchema.parse(process.env);
const adultEmails = z
  .array(z.email())
  .length(2, "HOUSEHOLD_ADULT_EMAILS must contain exactly two emails")
  .refine((emails) => new Set(emails).size === emails.length, {
    message: "HOUSEHOLD_ADULT_EMAILS must contain two distinct emails",
  })
  .parse(
    env.HOUSEHOLD_ADULT_EMAILS.split(",").map((email) =>
      email.trim().toLowerCase(),
    ),
  );

new Intl.DateTimeFormat("en-US", { timeZone: env.HOUSEHOLD_TIMEZONE });

const client = postgres(env.DATABASE_URL, { max: 1, prepare: false });
const db = drizzle({ client });

const defaultPeople = [
  {
    appetiteMultiplier: "1.00",
    displayName: "Adult 1",
    email: adultEmails[0],
    memberType: "adult" as const,
  },
  {
    appetiteMultiplier: "1.00",
    displayName: "Adult 2",
    email: adultEmails[1],
    memberType: "adult" as const,
  },
  {
    appetiteMultiplier: "1.40",
    displayName: "Teen",
    email: null,
    memberType: "child" as const,
  },
  {
    appetiteMultiplier: "0.50",
    displayName: "Young child",
    email: null,
    memberType: "child" as const,
  },
] as const;

try {
  const result = await db.transaction(async (transaction) => {
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

    const adultUserIds = new Map<string, string>();

    for (const person of defaultPeople.filter(
      (
        candidate,
      ): candidate is (typeof defaultPeople)[0] | (typeof defaultPeople)[1] =>
        candidate.email !== null,
    )) {
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

      adultUserIds.set(person.email, appUserId);
    }

    const existingMembers = await transaction
      .select({
        appUserId: householdMembers.appUserId,
        displayName: householdMembers.displayName,
        id: householdMembers.id,
        memberType: householdMembers.memberType,
      })
      .from(householdMembers)
      .where(eq(householdMembers.householdId, householdId));
    const claimedMemberIds = new Set<string>();

    for (const person of defaultPeople) {
      const appUserId = person.email
        ? adultUserIds.get(person.email) ?? null
        : null;
      const existingMember = appUserId
        ? existingMembers.find((member) => member.appUserId === appUserId)
        : (existingMembers.find(
            (member) =>
              member.appUserId === null &&
              !claimedMemberIds.has(member.id) &&
              member.displayName.toLowerCase() ===
                person.displayName.toLowerCase(),
          ) ??
          existingMembers.find(
            (member) =>
              member.appUserId === null &&
              member.memberType === person.memberType &&
              !claimedMemberIds.has(member.id),
          ));

      if (existingMember) {
        claimedMemberIds.add(existingMember.id);
        continue;
      }

      await transaction.insert(householdMembers).values({
        appUserId,
        appetiteMultiplier: person.appetiteMultiplier,
        displayName: person.displayName,
        householdId,
        memberType: person.memberType,
      });
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

    await transaction.insert(eventLogs).values({
      eventType: "foundation.seed_completed",
      householdId,
      payload: {
        ingredientCount: ingredientManifest.length,
        purchaseFormatCount: formatCount,
      },
    });

    return { formatCount, householdId };
  });

  console.info(
    `Seeded household ${result.householdId}, ${ingredientManifest.length} ingredients, and ${result.formatCount} purchase formats.`,
  );
} finally {
  await client.end();
}
