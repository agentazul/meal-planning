import { describe, expect, it } from "vitest";

import {
  formatDateLabel,
  getWeekDates,
  getWeekStartDate,
  isDateInWeek,
  parseDateOnly,
} from "./dates";

describe("date-only week helpers", () => {
  it("anchors weeks on Sunday", () => {
    expect(getWeekStartDate("2026-08-08")).toBe("2026-08-02");
    expect(getWeekStartDate("2026-08-09")).toBe("2026-08-09");
  });

  it("returns seven stable calendar dates", () => {
    expect(getWeekDates("2026-08-09")).toEqual([
      "2026-08-09",
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
      "2026-08-15",
    ]);
  });

  it("checks whether a date belongs to the selected week", () => {
    expect(isDateInWeek("2026-08-09", "2026-08-09")).toBe(true);
    expect(isDateInWeek("2026-08-15", "2026-08-09")).toBe(true);
    expect(isDateInWeek("2026-08-16", "2026-08-09")).toBe(false);
  });

  it("rejects non-date input", () => {
    expect(() => parseDateOnly("08/09/2026")).toThrow(/YYYY-MM-DD/);
  });

  it("formats without host timezone drift", () => {
    expect(
      formatDateLabel("2026-08-09", {
        month: "short",
        day: "numeric",
      }),
    ).toBe("Aug 9");
  });
});
