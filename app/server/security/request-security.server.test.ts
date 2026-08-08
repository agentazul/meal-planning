import { describe, expect, it } from "vitest";

import {
  isTrustedRequest,
  rejectUntrustedRequest,
} from "./request-security.server";

const APP_URL = "https://meals.example.com/app/path";

function makeRequest(
  method: string,
  headers: Readonly<Record<string, string>> = {},
): Request {
  return new Request("https://meals.example.com/presence", {
    method,
    headers,
  });
}

describe("isTrustedRequest", () => {
  it.each(["GET", "HEAD", "OPTIONS"])(
    "allows safe %s requests without browser metadata",
    (method) => {
      expect(isTrustedRequest(makeRequest(method), APP_URL)).toBe(true);
    },
  );

  it("allows an unsafe request from the configured origin", () => {
    const request = makeRequest("POST", {
      Origin: "https://meals.example.com",
      "Sec-Fetch-Site": "same-origin",
    });

    expect(isTrustedRequest(request, APP_URL)).toBe(true);
  });

  it("normalizes default ports before comparing origins", () => {
    const request = makeRequest("POST", {
      Origin: "https://meals.example.com:443",
    });

    expect(isTrustedRequest(request, APP_URL)).toBe(true);
  });

  it("allows same-origin Fetch Metadata when Origin is unavailable", () => {
    const request = makeRequest("POST", {
      "Sec-Fetch-Site": "same-origin",
    });

    expect(isTrustedRequest(request, APP_URL)).toBe(true);
  });

  it.each(["same-site", "cross-site"])(
    "rejects unsafe %s requests",
    (fetchSite) => {
      const request = makeRequest("POST", {
        Origin: "https://untrusted.example.com",
        "Sec-Fetch-Site": fetchSite,
      });

      expect(isTrustedRequest(request, APP_URL)).toBe(false);
    },
  );

  it("rejects a contradictory untrusted Origin", () => {
    const request = makeRequest("POST", {
      Origin: "https://untrusted.example.com",
      "Sec-Fetch-Site": "same-origin",
    });

    expect(isTrustedRequest(request, APP_URL)).toBe(false);
  });

  it("rejects unsafe requests with no browser trust signal", () => {
    expect(isTrustedRequest(makeRequest("POST"), APP_URL)).toBe(false);
  });
});

describe("rejectUntrustedRequest", () => {
  it("returns a non-cacheable 403 response", () => {
    const response = rejectUntrustedRequest(makeRequest("DELETE"), APP_URL);

    expect(response?.status).toBe(403);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
  });
});
