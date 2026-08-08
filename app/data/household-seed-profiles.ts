import { createHash } from "node:crypto";

import { z } from "zod";

const seedKeySchema = z
  .string()
  .trim()
  .min(1, "Seed keys cannot be blank")
  .max(100, "Seed keys must be 100 characters or fewer")
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Seed keys must be lowercase words separated by hyphens",
  );

const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Display names cannot be blank")
  .max(100, "Display names must be 100 characters or fewer");

const normalizedEmailSchema = z
  .string()
  .trim()
  .pipe(z.email())
  .transform((email) => email.toLowerCase());

const appetiteMultiplierSchema = z
  .string()
  .trim()
  .regex(
    /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/,
    "Appetite multipliers must be decimal strings with at most two decimal places",
  )
  .refine((value) => Number(value) > 0 && Number(value) <= 4, {
    message: "Appetite multipliers must be greater than zero and no greater than 4",
  })
  .transform((value) => Number(value).toFixed(2));

const householdSeedProfileSchema = z
  .strictObject({
    seedKey: seedKeySchema,
    displayName: displayNameSchema,
    email: normalizedEmailSchema.nullable(),
    memberType: z.enum(["adult", "child"]),
    appetiteMultiplier: appetiteMultiplierSchema,
  })
  .superRefine((profile, context) => {
    if (profile.email !== null && profile.memberType !== "adult") {
      context.addIssue({
        code: "custom",
        path: ["memberType"],
        message: "Login profiles must use the adult member type",
      });
    }
  });

const householdSeedProfilesSchema = z
  .array(householdSeedProfileSchema)
  .min(1, "At least one household member profile is required")
  .max(50, "At most 50 household member profiles are supported")
  .superRefine((profiles, context) => {
    const seedKeys = new Set<string>();
    const displayNames = new Set<string>();
    const loginEmails = new Set<string>();

    for (const [index, profile] of profiles.entries()) {
      if (seedKeys.has(profile.seedKey)) {
        context.addIssue({
          code: "custom",
          path: [index, "seedKey"],
          message: `Duplicate seed key: ${profile.seedKey}`,
        });
      }
      seedKeys.add(profile.seedKey);

      const normalizedDisplayName = profile.displayName.toLocaleLowerCase("en-US");
      if (displayNames.has(normalizedDisplayName)) {
        context.addIssue({
          code: "custom",
          path: [index, "displayName"],
          message: `Duplicate display name: ${profile.displayName}`,
        });
      }
      displayNames.add(normalizedDisplayName);

      if (profile.email !== null) {
        if (loginEmails.has(profile.email)) {
          context.addIssue({
            code: "custom",
            path: [index, "email"],
            message: `Duplicate login email: ${profile.email}`,
          });
        }
        loginEmails.add(profile.email);
      }
    }

    if (loginEmails.size !== 2) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "Household profiles must contain exactly two distinct login emails",
      });
    }
  });

const legacyAdultEmailsSchema = z
  .array(normalizedEmailSchema)
  .length(2, "HOUSEHOLD_ADULT_EMAILS must contain exactly two emails")
  .refine((emails) => new Set(emails).size === emails.length, {
    message: "HOUSEHOLD_ADULT_EMAILS must contain two distinct emails",
  });

const householdIdSchema = z.uuid();

export type HouseholdSeedProfile = z.infer<typeof householdSeedProfileSchema>;

export function parseHouseholdMemberProfilesJson(
  value: string,
): HouseholdSeedProfile[] {
  let input: unknown;

  try {
    input = JSON.parse(value);
  } catch {
    throw new Error("HOUSEHOLD_MEMBER_PROFILES_JSON must contain valid JSON");
  }

  return householdSeedProfilesSchema.parse(input);
}

export function resolveHouseholdSeedProfiles(input: Readonly<{
  legacyAdultEmails?: string;
  profilesJson?: string;
}>): HouseholdSeedProfile[] {
  if (input.profilesJson?.trim()) {
    return parseHouseholdMemberProfilesJson(input.profilesJson);
  }

  if (!input.legacyAdultEmails?.trim()) {
    throw new Error(
      "Set HOUSEHOLD_MEMBER_PROFILES_JSON or the legacy HOUSEHOLD_ADULT_EMAILS value",
    );
  }

  const adultEmails = legacyAdultEmailsSchema.parse(
    input.legacyAdultEmails.split(","),
  );

  return householdSeedProfilesSchema.parse([
    {
      seedKey: "adult-one",
      appetiteMultiplier: "1.00",
      displayName: "Adult 1",
      email: adultEmails[0],
      memberType: "adult",
    },
    {
      seedKey: "adult-two",
      appetiteMultiplier: "1.00",
      displayName: "Adult 2",
      email: adultEmails[1],
      memberType: "adult",
    },
    {
      seedKey: "teen",
      appetiteMultiplier: "1.40",
      displayName: "Teen",
      email: null,
      memberType: "child",
    },
    {
      seedKey: "young-child",
      appetiteMultiplier: "0.50",
      displayName: "Young child",
      email: null,
      memberType: "child",
    },
  ]);
}

export function deriveHouseholdMemberId(
  householdId: string,
  seedKey: string,
): string {
  const normalizedHouseholdId = householdIdSchema.parse(householdId).toLowerCase();
  const normalizedSeedKey = seedKeySchema.parse(seedKey);
  const namespaceBytes = Buffer.from(normalizedHouseholdId.replaceAll("-", ""), "hex");
  const digest = createHash("sha1")
    .update(namespaceBytes)
    .update(normalizedSeedKey, "utf8")
    .digest();

  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;

  const hex = digest.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
