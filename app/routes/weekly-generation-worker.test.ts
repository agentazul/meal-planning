import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  dispatchWeeklyGenerationJob,
  getRequestDatabase,
  getServerEnv,
  listRecoverableWeeklyGenerationJobs,
} = vi.hoisted(() => ({
  dispatchWeeklyGenerationJob: vi.fn(),
  getRequestDatabase: vi.fn(),
  getServerEnv: vi.fn(),
  listRecoverableWeeklyGenerationJobs: vi.fn(),
}));

vi.mock("~/server/context.server", () => ({ getRequestDatabase }));
vi.mock("~/server/data/weekly-generation-jobs.server", () => ({
  listRecoverableWeeklyGenerationJobs,
}));
vi.mock("~/server/env.server", () => ({ getServerEnv }));
vi.mock("~/server/jobs/weekly-generation-dispatch.server", () => ({
  dispatchWeeklyGenerationJob,
}));

import { loader } from "./weekly-generation-worker";

const CRON_SECRET = "a-cron-secret-that-is-at-least-32-characters";

function loaderArgs(authorization?: string) {
  return {
    context: {},
    params: {},
    request: new Request("https://dfy.kitchen/internal/weekly-generation-worker", {
      headers: authorization ? { Authorization: authorization } : undefined,
    }),
  } as Parameters<typeof loader>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  getServerEnv.mockReturnValue({ CRON_SECRET });
});

describe("weekly generation recovery worker", () => {
  it("refuses requests when the cron secret is missing", async () => {
    getServerEnv.mockReturnValue({ CRON_SECRET: undefined });

    const response = await loader(loaderArgs(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(503);
    expect(listRecoverableWeeklyGenerationJobs).not.toHaveBeenCalled();
  });

  it("requires the exact bearer credential", async () => {
    const response = await loader(loaderArgs("Bearer wrong-secret"));

    expect(response.status).toBe(401);
    expect(listRecoverableWeeklyGenerationJobs).not.toHaveBeenCalled();
  });

  it("schedules a small recovery batch and returns promptly", async () => {
    const db = { name: "request-db" };
    getRequestDatabase.mockReturnValue(db);
    listRecoverableWeeklyGenerationJobs.mockResolvedValue([
      { id: "9cb7e308-13b9-4dfe-9e62-fab1db83edca" },
      { id: "f8044a3a-b8e1-4bea-a3db-d8f4f322b411" },
    ]);

    const response = await loader(loaderArgs(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ scheduled: 2 });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(listRecoverableWeeklyGenerationJobs).toHaveBeenCalledWith(db, {
      limit: 3,
    });
    expect(dispatchWeeklyGenerationJob).toHaveBeenNthCalledWith(
      1,
      "9cb7e308-13b9-4dfe-9e62-fab1db83edca",
    );
    expect(dispatchWeeklyGenerationJob).toHaveBeenNthCalledWith(
      2,
      "f8044a3a-b8e1-4bea-a3db-d8f4f322b411",
    );
  });
});
