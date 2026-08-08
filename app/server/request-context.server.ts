import { randomUUID } from "node:crypto";

import type { MiddlewareFunction } from "react-router";

import { createRequestDatabase } from "~/db/request-db.server";
import { resolveRequestIdentity } from "~/server/auth/session.server";
import {
  databaseContext,
  setIdentityContext,
} from "~/server/context.server";
import { getServerEnv } from "~/server/env.server";
import { rejectUntrustedRequest } from "~/server/security/request-security.server";

export const requestContextMiddleware: MiddlewareFunction<Response> = async (
  { context, request },
  next,
) => {
  const requestId = randomUUID();
  const startedAt = performance.now();
  const requestUrl = new URL(request.url);
  const requestDatabase = createRequestDatabase();
  let status = 500;

  context.set(databaseContext, requestDatabase);

  try {
    const rejection = rejectUntrustedRequest(
      request,
      getServerEnv().APP_ORIGIN,
    );
    if (rejection) {
      status = rejection.status;
      rejection.headers.set("X-Request-Id", requestId);
      return rejection;
    }

    const identity = await resolveRequestIdentity(requestDatabase.db, request);
    setIdentityContext(context, identity);

    const response = await next();
    if (!(response instanceof Response)) {
      return response;
    }

    status = response.status;
    response.headers.set("X-Request-Id", requestId);
    if (!requestUrl.pathname.startsWith("/auth/")) {
      response.headers.append(
        "Server-Timing",
        `app;dur=${(performance.now() - startedAt).toFixed(1)}`,
      );
    }
    return response;
  } finally {
    await requestDatabase.close();
    console.info(
      JSON.stringify({
        durationMs: Math.round(performance.now() - startedAt),
        method: request.method,
        path: requestUrl.pathname,
        requestId,
        status,
      }),
    );
  }
};
