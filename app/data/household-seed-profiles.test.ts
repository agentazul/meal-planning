import { describe, expect, it } from "vitest";

import {
  deriveHouseholdMemberId,
  parseHouseholdMemberProfilesJson,
  resolveHouseholdSeedProfiles,
} from "./household-seed-profiles";

const validProfiles: Array<Record<string, unknown>> = [
  {
    seedKey: "adult-one",
    displayName: "Adult One",
    email: "adult-one@example.com",
    memberType: "adult",
    appetiteMultiplier: "1.00",
  },
  {
    seedKey: "adult-two",
    displayName: "Adult Two",
    email: "adult-two@example.com",
    memberType: "adult",
    appetiteMultiplier: "1.00",
  },
  {
    seedKey: "adult-three",
    displayName: "Adult Three",
    email: null,
    memberType: "adult",
    appetiteMultiplier: "1.00",
  },
  {
    seedKey: "teen",
    displayName: "Teen",
    email: null,
    memberType: "child",
    appetiteMultiplier: "1.40",
  },
  {
    seedKey: "young-child",
    displayName: "Young Child",
    email: null,
    memberType: "child",
    appetiteMultiplier: "0.50",
  },
];

function profilesJson(
  mutate?: (profiles: Array<Record<string, unknown>>) => void,
): string {
  const profiles = structuredClone(validProfiles);
  mutate?.(profiles);
  return JSON.stringify(profiles);
}

describe("household seed profiles", () => {
  it("parses a strict five-person household and normalizes seed values", () => {
    const value = profilesJson((profiles) => {
      profiles[0]!.displayName = "  Adult One  ";
      profiles[0]!.email = " ADULT-ONE@EXAMPLE.COM ";
      profiles[0]!.appetiteMultiplier = "1";
    });

    const profiles = parseHouseholdMemberProfilesJson(value);

    expect(profiles).toHaveLength(5);
    expect(profiles[0]).toMatchObject({
      appetiteMultiplier: "1.00",
      displayName: "Adult One",
      email: "adult-one@example.com",
    });
    expect(profiles.filter((profile) => profile.email !== null)).toHaveLength(2);
  });

  it("rejects malformed JSON and unknown profile fields", () => {
    expect(() => parseHouseholdMemberProfilesJson("{not-json")).toThrow(
      "must contain valid JSON",
    );
    expect(() =>
      parseHouseholdMemberProfilesJson(
        profilesJson((profiles) => {
          profiles[0]!.unexpected = true;
        }),
      ),
    ).toThrow();
  });

  it.each([
    ["seed keys", (profiles: Array<Record<string, unknown>>) => {
      profiles[1]!.seedKey = profiles[0]!.seedKey;
    }],
    ["case-insensitive display names", (profiles: Array<Record<string, unknown>>) => {
      profiles[1]!.displayName = "ADULT ONE";
    }],
    ["case-insensitive login emails", (profiles: Array<Record<string, unknown>>) => {
      profiles[1]!.email = "ADULT-ONE@EXAMPLE.COM";
    }],
  ])("rejects duplicate %s", (_label, mutate) => {
    expect(() => parseHouseholdMemberProfilesJson(profilesJson(mutate))).toThrow();
  });

  it("requires exactly two login profiles", () => {
    expect(() =>
      parseHouseholdMemberProfilesJson(
        profilesJson((profiles) => {
          profiles[1]!.email = null;
        }),
      ),
    ).toThrow("exactly two distinct login emails");

    expect(() =>
      parseHouseholdMemberProfilesJson(
        profilesJson((profiles) => {
          profiles[2]!.email = "adult-three@example.com";
        }),
      ),
    ).toThrow("exactly two distinct login emails");
  });

  it("requires valid emails on adult login profiles", () => {
    expect(() =>
      parseHouseholdMemberProfilesJson(
        profilesJson((profiles) => {
          profiles[0]!.email = "not-an-email";
        }),
      ),
    ).toThrow();

    expect(() =>
      parseHouseholdMemberProfilesJson(
        profilesJson((profiles) => {
          profiles[0]!.memberType = "child";
        }),
      ),
    ).toThrow("Login profiles must use the adult member type");
  });

  it.each(["0", "-1", "4.01", "1.001", "not-a-number"])(
    "rejects the appetite multiplier %s",
    (appetiteMultiplier) => {
      expect(() =>
        parseHouseholdMemberProfilesJson(
          profilesJson((profiles) => {
            profiles[4]!.appetiteMultiplier = appetiteMultiplier;
          }),
        ),
      ).toThrow();
    },
  );

  it("derives stable and distinct UUIDs from the household and seed key", () => {
    const householdId = "11111111-1111-4111-8111-111111111111";
    const anotherHouseholdId = "22222222-2222-4222-8222-222222222222";
    const first = deriveHouseholdMemberId(householdId, "teen");

    expect(deriveHouseholdMemberId(householdId, "teen")).toBe(first);
    expect(deriveHouseholdMemberId(householdId, "young-child")).not.toBe(first);
    expect(deriveHouseholdMemberId(anotherHouseholdId, "teen")).not.toBe(first);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("retains the two-email legacy fallback", () => {
    const profiles = resolveHouseholdSeedProfiles({
      legacyAdultEmails: " Adult-One@Example.com,adult-two@example.com ",
    });

    expect(profiles).toHaveLength(4);
    expect(profiles.map((profile) => profile.seedKey)).toEqual([
      "adult-one",
      "adult-two",
      "teen",
      "young-child",
    ]);
    expect(profiles.filter((profile) => profile.email !== null).map((profile) => profile.email))
      .toEqual(["adult-one@example.com", "adult-two@example.com"]);
  });
});
