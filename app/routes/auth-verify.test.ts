import { describe, expect, it } from "vitest";

import { headers } from "./auth-verify";

describe("auth verify response headers", () => {
  it("does not leak the bearer-token URL through the Referer header", () => {
    expect(headers()["Referrer-Policy"]).toBe("no-referrer");
  });
});
