import { describe, expect, it } from "vitest";

import {
  calculateServingDemand,
  calculateServingTarget,
  ServingCalculationError,
  type ServingMember,
} from "./servings";

function member(overrides: Partial<ServingMember> = {}): ServingMember {
  return {
    id: "member-1",
    active: true,
    appetiteMultiplier: 1,
    presenceRules: [],
    presenceOverrides: [],
    ...overrides,
  };
}

describe("serving calculation", () => {
  it("sums decimal appetites for active present members", () => {
    const members = [
      member({ id: "adult", appetiteMultiplier: 1 }),
      member({ id: "teen", appetiteMultiplier: 1.4 }),
      member({ id: "child", appetiteMultiplier: 0.5 }),
      member({ id: "inactive", appetiteMultiplier: 5, active: false }),
    ];

    expect(calculateServingDemand("2026-01-07", members)).toBe(2.9);
  });

  it("excludes an active member who is absent", () => {
    const members = [
      member({ id: "present", appetiteMultiplier: 1 }),
      member({
        id: "absent",
        appetiteMultiplier: 1.4,
        presenceRules: [
          {
            id: "thursday-absence",
            rrule: "FREQ=WEEKLY;BYDAY=TH",
            effect: "absent",
            priority: 10,
            effectiveFrom: "2026-01-01",
          },
        ],
      }),
    ];

    expect(calculateServingDemand("2026-01-08", members)).toBe(1);
  });

  it("excludes an active member whose usual presence is away", () => {
    expect(
      calculateServingDemand("2026-01-07", [
        member({ defaultIsPresent: false }),
        member({ id: "present", appetiteMultiplier: 1.4 }),
      ]),
    ).toBe(1.4);
  });

  it("keeps inactive status distinct from usual presence", () => {
    expect(
      calculateServingDemand("2026-01-07", [
        member({ active: false, defaultIsPresent: true }),
        member({ id: "away", defaultIsPresent: false }),
      ]),
    ).toBe(0);
  });

  it("rounds demand plus the deliberate leftover buffer up", () => {
    const result = calculateServingTarget({
      date: "2026-01-07",
      members: [
        member({ id: "adult", appetiteMultiplier: 1 }),
        member({ id: "teen", appetiteMultiplier: 1.4 }),
        member({ id: "child", appetiteMultiplier: 0.5 }),
      ],
      leftoverBufferServings: 1,
    });

    expect(result).toEqual({
      demand: 2.9,
      leftoverBufferServings: 1,
      target: 4,
    });
  });

  it("does not let floating point noise add a serving", () => {
    const result = calculateServingTarget({
      date: "2026-01-07",
      members: [
        member({ id: "one", appetiteMultiplier: 0.1 }),
        member({ id: "two", appetiteMultiplier: 0.2 }),
        member({ id: "three", appetiteMultiplier: 0.7 }),
      ],
      leftoverBufferServings: 0,
    });

    expect(result).toEqual({
      demand: 1,
      leftoverBufferServings: 0,
      target: 1,
    });
  });

  it("returns zero when no active member is present", () => {
    expect(
      calculateServingTarget({
        date: "2026-01-07",
        members: [member({ active: false })],
        leftoverBufferServings: 0,
      }),
    ).toEqual({
      demand: 0,
      leftoverBufferServings: 0,
      target: 0,
    });
  });

  it("rejects invalid appetite multipliers", () => {
    expect(() =>
      calculateServingDemand("2026-01-07", [
        member({ appetiteMultiplier: Number.NaN }),
      ]),
    ).toThrowError(
      expect.objectContaining<Partial<ServingCalculationError>>({
        code: "INVALID_APPETITE_MULTIPLIER",
      }),
    );
  });
});
