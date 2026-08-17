import { describe, expect, it } from "vitest";

import {
  PresenceResolutionError,
  resolvePresence,
  type PresenceRule,
} from "./presence";

function absentRule(overrides: Partial<PresenceRule> = {}): PresenceRule {
  return {
    id: "absent-rule",
    rrule: "FREQ=WEEKLY;BYDAY=TH",
    effect: "absent",
    priority: 10,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    ...overrides,
  };
}

describe("resolvePresence", () => {
  it("uses a member's default-away baseline when no rule or override matches", () => {
    expect(
      resolvePresence({
        date: "2026-01-02",
        defaultIsPresent: false,
        rules: [],
        overrides: [],
      }),
    ).toEqual({ isPresent: false, source: "default" });
  });

  it("matches a weekly Thursday absence", () => {
    const rules = [absentRule()];

    expect(
      resolvePresence({ date: "2026-01-01", rules, overrides: [] }),
    ).toEqual({ isPresent: false, source: "rule", ruleId: "absent-rule" });
    expect(
      resolvePresence({ date: "2026-01-02", rules, overrides: [] }),
    ).toEqual({ isPresent: true, source: "default" });
    expect(
      resolvePresence({ date: "2026-01-08", rules, overrides: [] }),
    ).toEqual({ isPresent: false, source: "rule", ruleId: "absent-rule" });
  });

  it("anchors an alternating multi-day absence to effectiveFrom", () => {
    const rules = [
      absentRule({
        rrule: "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH,FR,SA,SU",
      }),
    ];

    for (const date of [
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
      "2026-01-15",
      "2026-01-16",
      "2026-01-17",
      "2026-01-18",
    ]) {
      expect(resolvePresence({ date, rules, overrides: [] }).isPresent).toBe(
        false,
      );
    }

    for (const date of [
      "2026-01-08",
      "2026-01-09",
      "2026-01-10",
      "2026-01-11",
    ]) {
      expect(resolvePresence({ date, rules, overrides: [] })).toEqual({
        isPresent: true,
        source: "default",
      });
    }
  });

  it("applies effective ranges inclusively", () => {
    const rules = [
      absentRule({ effectiveFrom: "2026-01-08", effectiveTo: "2026-01-15" }),
    ];

    expect(
      resolvePresence({ date: "2026-01-01", rules, overrides: [] }).isPresent,
    ).toBe(true);
    expect(
      resolvePresence({ date: "2026-01-08", rules, overrides: [] }).isPresent,
    ).toBe(false);
    expect(
      resolvePresence({ date: "2026-01-15", rules, overrides: [] }).isPresent,
    ).toBe(false);
    expect(
      resolvePresence({ date: "2026-01-22", rules, overrides: [] }).isPresent,
    ).toBe(true);
  });

  it("lets a same-date override win over matching rules", () => {
    expect(
      resolvePresence({
        date: "2026-01-08",
        rules: [absentRule()],
        overrides: [{ date: "2026-01-08", isPresent: true }],
      }),
    ).toEqual({ isPresent: true, source: "override" });
  });

  it("lets rules and overrides take precedence over a default-away baseline", () => {
    const rule = absentRule({ effect: "present", id: "present-rule" });
    expect(
      resolvePresence({
        date: "2026-01-01",
        defaultIsPresent: false,
        rules: [rule],
        overrides: [],
      }),
    ).toEqual({ isPresent: true, source: "rule", ruleId: "present-rule" });
    expect(
      resolvePresence({
        date: "2026-01-01",
        defaultIsPresent: false,
        rules: [rule],
        overrides: [{ date: "2026-01-01", isPresent: false }],
      }),
    ).toEqual({ isPresent: false, source: "override" });
  });

  it("uses the highest priority matching rule", () => {
    const rules: PresenceRule[] = [
      absentRule({ id: "absent", priority: 10 }),
      absentRule({ id: "present", effect: "present", priority: 20 }),
    ];

    expect(
      resolvePresence({ date: "2026-01-08", rules, overrides: [] }),
    ).toEqual({ isPresent: true, source: "rule", ruleId: "present" });
  });

  it("breaks equal priorities by ascending rule ID regardless of input order", () => {
    const first = absentRule({ id: "a-absent", priority: 10 });
    const second = absentRule({
      id: "z-present",
      effect: "present",
      priority: 10,
    });

    for (const rules of [
      [first, second],
      [second, first],
    ]) {
      expect(
        resolvePresence({ date: "2026-01-08", rules, overrides: [] }),
      ).toEqual({ isPresent: false, source: "rule", ruleId: "a-absent" });
    }
  });

  it("rejects sub-day recurrence fields", () => {
    expect(() =>
      resolvePresence({
        date: "2026-01-08",
        rules: [absentRule({ rrule: "FREQ=WEEKLY;BYDAY=TH;BYHOUR=9" })],
        overrides: [],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<PresenceResolutionError>>({
        code: "UNSUPPORTED_RRULE",
      }),
    );
  });

  it("rejects embedded DTSTART so effectiveFrom remains the anchor", () => {
    expect(() =>
      resolvePresence({
        date: "2026-01-08",
        rules: [
          absentRule({
            rrule: "DTSTART;VALUE=DATE:20260102\nRRULE:FREQ=WEEKLY;BYDAY=TH",
          }),
        ],
        overrides: [],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<PresenceResolutionError>>({
        code: "UNSUPPORTED_RRULE",
      }),
    );
  });
});
