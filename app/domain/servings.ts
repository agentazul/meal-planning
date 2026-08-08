import {
  resolvePresence,
  type DateOnly,
  type PresenceOverride,
  type PresenceRule,
} from "./presence";

export interface ServingMember {
  id: string;
  active: boolean;
  appetiteMultiplier: number;
  presenceRules: readonly PresenceRule[];
  presenceOverrides: readonly PresenceOverride[];
}

export interface ServingTargetInput {
  date: DateOnly;
  members: readonly ServingMember[];
  leftoverBufferServings: number;
}

export interface ServingTarget {
  demand: number;
  leftoverBufferServings: number;
  target: number;
}

export type ServingCalculationErrorCode =
  "INVALID_APPETITE_MULTIPLIER" | "INVALID_LEFTOVER_BUFFER";

export class ServingCalculationError extends Error {
  override readonly name = "ServingCalculationError";

  constructor(
    readonly code: ServingCalculationErrorCode,
    message: string,
    readonly memberId?: string,
  ) {
    super(message);
  }
}

function normalizeDecimal(value: number): number {
  return Number(value.toFixed(12));
}

export function calculateServingDemand(
  date: DateOnly,
  members: readonly ServingMember[],
): number {
  let demand = 0;

  for (const member of members) {
    if (!member.active) continue;

    if (
      !Number.isFinite(member.appetiteMultiplier) ||
      member.appetiteMultiplier < 0
    ) {
      throw new ServingCalculationError(
        "INVALID_APPETITE_MULTIPLIER",
        `Member ${member.id} appetite multiplier must be a nonnegative finite number`,
        member.id,
      );
    }

    const presence = resolvePresence({
      date,
      rules: member.presenceRules,
      overrides: member.presenceOverrides,
    });

    if (presence.isPresent) {
      demand = normalizeDecimal(demand + member.appetiteMultiplier);
    }
  }

  return demand;
}

export function calculateServingTarget({
  date,
  members,
  leftoverBufferServings,
}: ServingTargetInput): ServingTarget {
  if (!Number.isFinite(leftoverBufferServings) || leftoverBufferServings < 0) {
    throw new ServingCalculationError(
      "INVALID_LEFTOVER_BUFFER",
      "Leftover buffer servings must be a nonnegative finite number",
    );
  }

  const demand = calculateServingDemand(date, members);
  const normalizedTotal = normalizeDecimal(demand + leftoverBufferServings);

  return {
    demand,
    leftoverBufferServings,
    target: Math.ceil(normalizedTotal),
  };
}
