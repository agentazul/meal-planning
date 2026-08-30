import { beforeEach, describe, expect, it, vi } from "vitest";

const { processWeeklyGenerationJob, waitUntil } = vi.hoisted(() => ({
  processWeeklyGenerationJob: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({ waitUntil }));
vi.mock("./weekly-generation-processor.server", () => ({
  processWeeklyGenerationJob,
}));

import { dispatchWeeklyGenerationJob } from "./weekly-generation-dispatch.server";

const JOB_ID = "9cb7e308-13b9-4dfe-9e62-fab1db83edca";

beforeEach(() => {
  processWeeklyGenerationJob.mockReset();
  processWeeklyGenerationJob.mockResolvedValue(undefined);
  waitUntil.mockReset();
  vi.unstubAllEnvs();
});

describe("weekly generation dispatch", () => {
  it("registers production processing with the Vercel request lifetime", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");

    expect(dispatchWeeklyGenerationJob(JOB_ID)).toBe(`deferred:${JOB_ID}`);
    expect(processWeeklyGenerationJob).toHaveBeenCalledWith(JOB_ID);
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });

  it("schedules processing in-process outside Vercel", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "0");

    expect(dispatchWeeklyGenerationJob(JOB_ID)).toBe(`deferred:${JOB_ID}`);
    expect(processWeeklyGenerationJob).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(processWeeklyGenerationJob).toHaveBeenCalledWith(JOB_ID);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("does not execute background work in tests", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL", "1");

    expect(dispatchWeeklyGenerationJob(JOB_ID)).toBe(`deferred:${JOB_ID}`);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(processWeeklyGenerationJob).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("rejects malformed job identifiers before scheduling", () => {
    expect(() => dispatchWeeklyGenerationJob("not-a-job-id")).toThrow();
    expect(processWeeklyGenerationJob).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });
});
