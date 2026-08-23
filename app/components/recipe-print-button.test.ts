import { describe, expect, it, vi } from "vitest";

import { requestRecipePrint } from "./recipe-print-button";

describe("requestRecipePrint", () => {
  it("opens the browser print preview", () => {
    const print = vi.fn();

    requestRecipePrint({ print });

    expect(print).toHaveBeenCalledOnce();
  });
});
