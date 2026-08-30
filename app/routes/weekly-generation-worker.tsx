import { timingSafeEqual } from "node:crypto";

import { getRequestDatabase } from "~/server/context.server";
import { listRecoverableWeeklyGenerationJobs } from "~/server/data/weekly-generation-jobs.server";
import { getServerEnv } from "~/server/env.server";
import { dispatchWeeklyGenerationJob } from "~/server/jobs/weekly-generation-dispatch.server";
import type { Route } from "./+types/weekly-generation-worker";

const RECOVERY_BATCH_SIZE = 3;

function authorizedCronRequest(
  authorizationHeader: string | null,
  cronSecret: string,
) {
  const actual = Buffer.from(authorizationHeader ?? "", "utf8");
  const expected = Buffer.from(`Bearer ${cronSecret}`, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const cronSecret = getServerEnv().CRON_SECRET;
  if (!cronSecret) {
    return Response.json(
      { error: "Cron worker is not configured." },
      { status: 503 },
    );
  }

  if (!authorizedCronRequest(request.headers.get("Authorization"), cronSecret)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const jobs = await listRecoverableWeeklyGenerationJobs(
    getRequestDatabase(context),
    { limit: RECOVERY_BATCH_SIZE },
  );
  for (const job of jobs) {
    dispatchWeeklyGenerationJob(job.id);
  }

  return Response.json(
    { scheduled: jobs.length },
    { headers: { "Cache-Control": "no-store" } },
  );
}
