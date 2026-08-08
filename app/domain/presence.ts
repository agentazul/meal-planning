import { Temporal } from "@js-temporal/polyfill";
import { RRuleTemporal } from "rrule-temporal";

export type DateOnly = string;

export type PresenceEffect = "present" | "absent";

export interface PresenceRule {
  id: string;
  rrule: string;
  effect: PresenceEffect;
  priority: number;
  effectiveFrom: DateOnly;
  effectiveTo?: DateOnly | null;
}

export interface PresenceOverride {
  date: DateOnly;
  isPresent: boolean;
}

export interface PresenceResolutionInput {
  date: DateOnly;
  rules: readonly PresenceRule[];
  overrides: readonly PresenceOverride[];
}

export type PresenceResolution =
  | {
      isPresent: boolean;
      source: "override";
    }
  | {
      isPresent: boolean;
      source: "rule";
      ruleId: string;
    }
  | {
      isPresent: true;
      source: "default";
    };

export type PresenceResolutionErrorCode =
  | "DUPLICATE_OVERRIDE"
  | "INVALID_DATE"
  | "INVALID_PRIORITY"
  | "INVALID_RANGE"
  | "INVALID_RRULE"
  | "INVALID_RULE_ID"
  | "UNSUPPORTED_RRULE";

export class PresenceResolutionError extends Error {
  override readonly name = "PresenceResolutionError";

  constructor(
    readonly code: PresenceResolutionErrorCode,
    message: string,
    readonly ruleId?: string,
  ) {
    super(message);
  }
}

const SUB_DAY_FREQUENCIES = new Set(["HOURLY", "MINUTELY", "SECONDLY"]);
const SUB_DAY_FIELDS = new Set(["BYHOUR", "BYMINUTE", "BYSECOND"]);
const EXTERNAL_DATE_FIELDS = /(^|\s)(DTSTART|RDATE|EXDATE|EXRULE)(?:;|:)/i;

function parseDateOnly(value: DateOnly, label: string): Temporal.PlainDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PresenceResolutionError(
      "INVALID_DATE",
      `${label} must use the YYYY-MM-DD format`,
    );
  }

  try {
    return Temporal.PlainDate.from(value);
  } catch {
    throw new PresenceResolutionError(
      "INVALID_DATE",
      `${label} is not a valid calendar date`,
    );
  }
}

function compareRuleIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeRRule(rule: PresenceRule): string {
  const value = rule.rrule.trim();

  if (value.length === 0) {
    throw new PresenceResolutionError(
      "INVALID_RRULE",
      `Presence rule ${rule.id} has an empty RRULE`,
      rule.id,
    );
  }

  if (EXTERNAL_DATE_FIELDS.test(value) || /[\r\n]/.test(value)) {
    throw new PresenceResolutionError(
      "UNSUPPORTED_RRULE",
      `Presence rule ${rule.id} must contain one RRULE without embedded dates`,
      rule.id,
    );
  }

  const recurrence = value.replace(/^RRULE:/i, "");
  const fields = new Map<string, string>();

  for (const part of recurrence.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0 || separator === part.length - 1) {
      throw new PresenceResolutionError(
        "INVALID_RRULE",
        `Presence rule ${rule.id} contains an invalid RRULE field`,
        rule.id,
      );
    }

    const key = part.slice(0, separator).trim().toUpperCase();
    const fieldValue = part
      .slice(separator + 1)
      .trim()
      .toUpperCase();
    if (fields.has(key)) {
      throw new PresenceResolutionError(
        "INVALID_RRULE",
        `Presence rule ${rule.id} repeats the ${key} field`,
        rule.id,
      );
    }
    fields.set(key, fieldValue);
  }

  const frequency = fields.get("FREQ");
  if (!frequency) {
    throw new PresenceResolutionError(
      "INVALID_RRULE",
      `Presence rule ${rule.id} must define FREQ`,
      rule.id,
    );
  }

  if (SUB_DAY_FREQUENCIES.has(frequency)) {
    throw new PresenceResolutionError(
      "UNSUPPORTED_RRULE",
      `Presence rule ${rule.id} cannot use sub-day frequency ${frequency}`,
      rule.id,
    );
  }

  for (const field of SUB_DAY_FIELDS) {
    if (fields.has(field)) {
      throw new PresenceResolutionError(
        "UNSUPPORTED_RRULE",
        `Presence rule ${rule.id} cannot use sub-day field ${field}`,
        rule.id,
      );
    }
  }

  const until = fields.get("UNTIL");
  if (until && !/^\d{8}$/.test(until)) {
    throw new PresenceResolutionError(
      "UNSUPPORTED_RRULE",
      `Presence rule ${rule.id} must use a date-only UNTIL value`,
      rule.id,
    );
  }

  return recurrence;
}

function matchesRule(
  rule: PresenceRule,
  targetDate: Temporal.PlainDate,
): boolean {
  const effectiveFrom = parseDateOnly(
    rule.effectiveFrom,
    `Presence rule ${rule.id} effectiveFrom`,
  );
  const effectiveTo = rule.effectiveTo
    ? parseDateOnly(rule.effectiveTo, `Presence rule ${rule.id} effectiveTo`)
    : null;

  if (
    effectiveTo &&
    Temporal.PlainDate.compare(effectiveTo, effectiveFrom) < 0
  ) {
    throw new PresenceResolutionError(
      "INVALID_RANGE",
      `Presence rule ${rule.id} has effectiveTo before effectiveFrom`,
      rule.id,
    );
  }

  if (Temporal.PlainDate.compare(targetDate, effectiveFrom) < 0) return false;
  if (effectiveTo && Temporal.PlainDate.compare(targetDate, effectiveTo) > 0) {
    return false;
  }

  const recurrence = normalizeRRule(rule);
  const anchor = Temporal.ZonedDateTime.from(
    `${effectiveFrom.toString()}T00:00:00+00:00[UTC]`,
  );

  try {
    const temporalRule = new RRuleTemporal({
      rruleString: recurrence,
      dtstart: anchor,
      includeDtstart: false,
    });
    return temporalRule.occursOn(targetDate);
  } catch (error: unknown) {
    if (error instanceof PresenceResolutionError) throw error;
    const detail =
      error instanceof Error ? error.message : "Unknown RRULE error";
    throw new PresenceResolutionError(
      "INVALID_RRULE",
      `Presence rule ${rule.id} is invalid: ${detail}`,
      rule.id,
    );
  }
}

export function resolvePresence({
  date,
  rules,
  overrides,
}: PresenceResolutionInput): PresenceResolution {
  const targetDate = parseDateOnly(date, "Presence date");
  const targetKey = targetDate.toString();
  const matchingOverrides = overrides.filter(
    (override) =>
      parseDateOnly(override.date, "Presence override date").toString() ===
      targetKey,
  );

  if (matchingOverrides.length > 1) {
    throw new PresenceResolutionError(
      "DUPLICATE_OVERRIDE",
      `Presence date ${targetKey} has more than one override`,
    );
  }

  const override = matchingOverrides[0];
  if (override) {
    return { isPresent: override.isPresent, source: "override" };
  }

  for (const rule of rules) {
    if (rule.id.trim().length === 0) {
      throw new PresenceResolutionError(
        "INVALID_RULE_ID",
        "Presence rule IDs cannot be empty",
      );
    }
    if (!Number.isSafeInteger(rule.priority)) {
      throw new PresenceResolutionError(
        "INVALID_PRIORITY",
        `Presence rule ${rule.id} priority must be a safe integer`,
        rule.id,
      );
    }
  }

  // Equal priorities resolve by ascending rule ID so input order cannot change the result.
  const orderedRules = [...rules].sort(
    (left, right) =>
      right.priority - left.priority || compareRuleIds(left.id, right.id),
  );

  for (const rule of orderedRules) {
    if (matchesRule(rule, targetDate)) {
      return {
        isPresent: rule.effect === "present",
        source: "rule",
        ruleId: rule.id,
      };
    }
  }

  return { isPresent: true, source: "default" };
}

export function isPresent(input: PresenceResolutionInput): boolean {
  return resolvePresence(input).isPresent;
}
