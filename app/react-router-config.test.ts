import { describe, expect, it } from "vitest";

import config, { resolveAllowedActionOrigins } from "../react-router.config";

describe("React Router action origins", () => {
  it("allows the canonical production hosts through forwarded requests", () => {
    expect(config.allowedActionOrigins).toEqual(
      expect.arrayContaining(["dfy.kitchen", "www.dfy.kitchen"]),
    );
  });

  it("adds the configured application host without its protocol or path", () => {
    expect(
      resolveAllowedActionOrigins("http://localhost:5173/auth/verify"),
    ).toEqual(["dfy.kitchen", "www.dfy.kitchen", "localhost:5173"]);
  });

  it("leaves only canonical hosts when APP_ORIGIN is malformed", () => {
    expect(resolveAllowedActionOrigins("not a URL")).toEqual([
      "dfy.kitchen",
      "www.dfy.kitchen",
    ]);
  });
});
