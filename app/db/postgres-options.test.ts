import { describe, expect, it } from "vitest";

import { getPostgresConnectionOptions } from "./postgres-options";

describe("getPostgresConnectionOptions", () => {
  it("enforces certificate verification for required TLS", () => {
    expect(
      getPostgresConnectionOptions(
        "postgresql://user:pass@example.com/app?sslmode=require",
      ),
    ).toEqual({ max: 1, prepare: false, ssl: "verify-full" });
  });

  it("keeps local connections free to run without TLS", () => {
    expect(
      getPostgresConnectionOptions(
        "postgresql://user:pass@localhost:5432/app",
      ),
    ).toEqual({ max: 1, prepare: false });
  });
});
