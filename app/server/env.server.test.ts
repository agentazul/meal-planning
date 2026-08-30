import { afterEach, describe, expect, it, vi } from "vitest";

const productionSmtpEnv = {
  APP_ORIGIN: "https://meal-planning.example.com",
  CRON_SECRET: "a-cron-secret-that-is-at-least-32-characters",
  DATABASE_URL: "postgresql://user:password@example.com/meal_planning",
  GOOGLE_VERTEX_API_KEY: "test-google-key",
  MAGIC_LINK_DELIVERY: "smtp",
  NODE_ENV: "production",
  SESSION_COOKIE_SECRET: "a-unique-session-secret-with-32-characters",
  SMTP_FROM: "Done For You Kitchen <login@example.com>",
  SMTP_HOST: "smtp.resend.com",
  SMTP_PORT: "465",
  SMTP_SECURE: "true",
  SMTP_USER: "resend",
} as const;

async function loadServerEnv() {
  vi.resetModules();
  const { getServerEnv } = await import("./env.server");
  return getServerEnv();
}

function stubProductionSmtpEnv() {
  for (const [key, value] of Object.entries(productionSmtpEnv)) {
    vi.stubEnv(key, value);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("server environment", () => {
  it("accepts the Vercel Resend key as the SMTP password", async () => {
    stubProductionSmtpEnv();
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    delete process.env.SMTP_PASSWORD;

    await expect(loadServerEnv()).resolves.toMatchObject({
      AI_RECIPE_MODEL: "gemini-3.7-flash",
      RESEND_API_KEY: "re_test_key",
      SMTP_USER: "resend",
    });
  });

  it("accepts a provider-specific SMTP password", async () => {
    stubProductionSmtpEnv();
    vi.stubEnv("SMTP_PASSWORD", "smtp-test-password");
    delete process.env.RESEND_API_KEY;

    await expect(loadServerEnv()).resolves.toMatchObject({
      SMTP_PASSWORD: "smtp-test-password",
      SMTP_USER: "resend",
    });
  });

  it("rejects SMTP delivery without an authenticated credential", async () => {
    stubProductionSmtpEnv();
    delete process.env.SMTP_PASSWORD;
    delete process.env.RESEND_API_KEY;

    await expect(loadServerEnv()).rejects.toThrow(
      "SMTP_USER and either SMTP_PASSWORD or RESEND_API_KEY are required",
    );
  });

  it("accepts a configured direct Vertex recipe model", async () => {
    stubProductionSmtpEnv();
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("AI_RECIPE_MODEL", "gemini-3.6-flash");

    await expect(loadServerEnv()).resolves.toMatchObject({
      AI_RECIPE_MODEL: "gemini-3.6-flash",
    });
  });

  it("normalizes a legacy Google Gateway model identifier", async () => {
    stubProductionSmtpEnv();
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("AI_RECIPE_MODEL", "google/gemini-3.7-flash");

    await expect(loadServerEnv()).resolves.toMatchObject({
      AI_RECIPE_MODEL: "gemini-3.7-flash",
    });
  });

  it("allows the rest of the app to boot without Google credentials", async () => {
    stubProductionSmtpEnv();
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    delete process.env.GOOGLE_VERTEX_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;

    await expect(loadServerEnv()).resolves.toMatchObject({
      AI_RECIPE_MODEL: "gemini-3.7-flash",
    });
  });

  it("supports the pre-Vertex Google key name during the production cutover", async () => {
    stubProductionSmtpEnv();
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    delete process.env.GOOGLE_VERTEX_API_KEY;
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "legacy-vertex-key");

    await expect(loadServerEnv()).resolves.toMatchObject({
      GOOGLE_VERTEX_API_KEY: "legacy-vertex-key",
    });
  });

  it("requires the cron credential in production", async () => {
    stubProductionSmtpEnv();
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    delete process.env.CRON_SECRET;

    await expect(loadServerEnv()).rejects.toThrow(
      "Production requires CRON_SECRET",
    );
  });
});
