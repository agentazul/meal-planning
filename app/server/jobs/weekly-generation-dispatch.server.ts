import { waitUntil } from "@vercel/functions";

import { weeklyGenerationJobIdSchema } from "~/server/data/weekly-generation-jobs.server";
import { processWeeklyGenerationJob } from "./weekly-generation-processor.server";

function dispatchId(jobId: string) {
  return `deferred:${jobId}`;
}

function reportProcessingFailure(jobId: string, error: unknown) {
  console.error(
    JSON.stringify({
      errorName: error instanceof Error ? error.name : "UnknownError",
      jobId,
      status: "weekly_generation_background_processing_failed",
    }),
  );
}

function processInBackground(jobId: string) {
  return processWeeklyGenerationJob(jobId).catch((error: unknown) => {
    reportProcessingFailure(jobId, error);
  });
}

export function dispatchWeeklyGenerationJob(jobIdInput: string): string {
  const jobId = weeklyGenerationJobIdSchema.parse(jobIdInput);

  if (process.env.NODE_ENV === "test") {
    return dispatchId(jobId);
  }

  if (process.env.VERCEL === "1") {
    waitUntil(processInBackground(jobId));
  } else {
    queueMicrotask(() => {
      void processInBackground(jobId);
    });
  }

  return dispatchId(jobId);
}
