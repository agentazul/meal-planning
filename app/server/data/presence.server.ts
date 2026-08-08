import {
  and,
  asc,
  desc,
  eq,
  gte,
  isNull,
  lte,
  or,
} from "drizzle-orm";

import {
  eventLogs,
  householdMembers,
  presenceOverrides,
  presenceRules,
} from "~/db/schema";
import {
  resolvePresence,
  type PresenceOverride,
  type PresenceRule,
} from "~/domain/presence";
import type { ScopedDatabase } from "~/server/context.server";

export type PresenceMember = Readonly<{
  active: boolean;
  appetiteMultiplier: number;
  dietaryNotes: string | null;
  displayName: string;
  id: string;
  memberType: "adult" | "child";
  overrides: readonly PresenceOverride[];
  rules: readonly PresenceRule[];
}>;

export async function listPresenceMembers(
  scoped: ScopedDatabase,
  input: Readonly<{
    from: string;
    includeInactive?: boolean;
    to: string;
  }>,
): Promise<readonly PresenceMember[]> {
  const householdId = scoped.scope.householdId;
  const memberRows = await scoped.db
    .select({
      active: householdMembers.active,
      appetiteMultiplier: householdMembers.appetiteMultiplier,
      dietaryNotes: householdMembers.dietaryNotes,
      displayName: householdMembers.displayName,
      id: householdMembers.id,
      memberType: householdMembers.memberType,
    })
    .from(householdMembers)
    .where(
      input.includeInactive
        ? eq(householdMembers.householdId, householdId)
        : and(
            eq(householdMembers.householdId, householdId),
            eq(householdMembers.active, true),
          ),
    )
    .orderBy(asc(householdMembers.createdAt), asc(householdMembers.id));

  const [ruleRows, overrideRows] = await Promise.all([
    scoped.db
      .select({
        effect: presenceRules.effect,
        effectiveFrom: presenceRules.effectiveFrom,
        effectiveTo: presenceRules.effectiveTo,
        householdMemberId: presenceRules.householdMemberId,
        id: presenceRules.id,
        priority: presenceRules.priority,
        rrule: presenceRules.rrule,
      })
      .from(presenceRules)
      .where(
        and(
          eq(presenceRules.householdId, householdId),
          lte(presenceRules.effectiveFrom, input.to),
          or(
            isNull(presenceRules.effectiveTo),
            gte(presenceRules.effectiveTo, input.from),
          ),
        ),
      )
      .orderBy(
        asc(presenceRules.householdMemberId),
        desc(presenceRules.priority),
        asc(presenceRules.id),
      ),
    scoped.db
      .select({
        date: presenceOverrides.date,
        householdMemberId: presenceOverrides.householdMemberId,
        isPresent: presenceOverrides.isPresent,
      })
      .from(presenceOverrides)
      .where(
        and(
          eq(presenceOverrides.householdId, householdId),
          gte(presenceOverrides.date, input.from),
          lte(presenceOverrides.date, input.to),
        ),
      )
      .orderBy(
        asc(presenceOverrides.householdMemberId),
        asc(presenceOverrides.date),
      ),
  ]);

  return memberRows.map((member) => ({
    ...member,
    appetiteMultiplier: Number(member.appetiteMultiplier),
    overrides: overrideRows
      .filter((override) => override.householdMemberId === member.id)
      .map(({ date, isPresent }) => ({ date, isPresent })),
    rules: ruleRows
      .filter((rule) => rule.householdMemberId === member.id)
      .map(({ householdMemberId: _memberId, ...rule }) => rule),
  }));
}

export async function updateHouseholdMember(
  scoped: ScopedDatabase,
  input: Readonly<{
    active: boolean;
    appetiteMultiplier: number;
    dietaryNotes: string | null;
    displayName: string;
    memberId: string;
    memberType: "adult" | "child";
  }>,
): Promise<boolean> {
  return scoped.db.transaction(async (transaction) => {
    const [updated] = await transaction
      .update(householdMembers)
      .set({
        active: input.active,
        appetiteMultiplier: input.appetiteMultiplier.toFixed(2),
        dietaryNotes: input.dietaryNotes,
        displayName: input.displayName.trim(),
        memberType: input.memberType,
      })
      .where(
        and(
          eq(householdMembers.householdId, scoped.scope.householdId),
          eq(householdMembers.id, input.memberId),
        ),
      )
      .returning({ id: householdMembers.id });

    if (!updated) {
      return false;
    }

    await transaction.insert(eventLogs).values({
      eventType: "presence.member_updated",
      householdId: scoped.scope.householdId,
      payload: { memberId: updated.id },
    });
    return true;
  });
}

export async function createPresenceRule(
  scoped: ScopedDatabase,
  input: Readonly<{
    effect: "present" | "absent";
    effectiveFrom: string;
    effectiveTo: string | null;
    memberId: string;
    priority: number;
    rrule: string;
  }>,
): Promise<string> {
  const validationRule: PresenceRule = {
    effect: input.effect,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    id: "pending-rule",
    priority: input.priority,
    rrule: input.rrule,
  };

  resolvePresence({
    date: input.effectiveFrom,
    overrides: [],
    rules: [validationRule],
  });

  return scoped.db.transaction(async (transaction) => {
    const [member] = await transaction
      .select({ id: householdMembers.id })
      .from(householdMembers)
      .where(
        and(
          eq(householdMembers.householdId, scoped.scope.householdId),
          eq(householdMembers.id, input.memberId),
        ),
      )
      .limit(1);

    if (!member) {
      throw new Error("Household member not found");
    }

    const [created] = await transaction
      .insert(presenceRules)
      .values({
        effect: input.effect,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        householdId: scoped.scope.householdId,
        householdMemberId: member.id,
        priority: input.priority,
        rrule: input.rrule,
      })
      .returning({ id: presenceRules.id });

    if (!created) {
      throw new Error("Presence rule was not created");
    }

    await transaction.insert(eventLogs).values({
      eventType: "presence.rule_created",
      householdId: scoped.scope.householdId,
      payload: {
        memberId: member.id,
        presenceRuleId: created.id,
      },
    });
    return created.id;
  });
}

export async function deletePresenceRule(
  scoped: ScopedDatabase,
  ruleId: string,
): Promise<boolean> {
  return scoped.db.transaction(async (transaction) => {
    const [deleted] = await transaction
      .delete(presenceRules)
      .where(
        and(
          eq(presenceRules.householdId, scoped.scope.householdId),
          eq(presenceRules.id, ruleId),
        ),
      )
      .returning({ id: presenceRules.id });

    if (!deleted) {
      return false;
    }

    await transaction.insert(eventLogs).values({
      eventType: "presence.rule_deleted",
      householdId: scoped.scope.householdId,
      payload: { presenceRuleId: deleted.id },
    });
    return true;
  });
}

export async function setPresenceOverride(
  scoped: ScopedDatabase,
  input: Readonly<{
    date: string;
    isPresent: boolean;
    memberId: string;
    note: string | null;
  }>,
): Promise<void> {
  await scoped.db.transaction(async (transaction) => {
    await transaction
      .insert(presenceOverrides)
      .values({
        date: input.date,
        householdId: scoped.scope.householdId,
        householdMemberId: input.memberId,
        isPresent: input.isPresent,
        note: input.note,
      })
      .onConflictDoUpdate({
        set: { isPresent: input.isPresent, note: input.note },
        target: [
          presenceOverrides.householdId,
          presenceOverrides.householdMemberId,
          presenceOverrides.date,
        ],
      });

    await transaction.insert(eventLogs).values({
      eventType: "presence.override_set",
      householdId: scoped.scope.householdId,
      payload: {
        date: input.date,
        isPresent: input.isPresent,
        memberId: input.memberId,
      },
    });
  });
}

export async function clearPresenceOverride(
  scoped: ScopedDatabase,
  input: Readonly<{ date: string; memberId: string }>,
): Promise<boolean> {
  return scoped.db.transaction(async (transaction) => {
    const [deleted] = await transaction
      .delete(presenceOverrides)
      .where(
        and(
          eq(presenceOverrides.householdId, scoped.scope.householdId),
          eq(presenceOverrides.householdMemberId, input.memberId),
          eq(presenceOverrides.date, input.date),
        ),
      )
      .returning({ id: presenceOverrides.id });

    if (!deleted) {
      return false;
    }

    await transaction.insert(eventLogs).values({
      eventType: "presence.override_cleared",
      householdId: scoped.scope.householdId,
      payload: {
        date: input.date,
        memberId: input.memberId,
      },
    });
    return true;
  });
}
