import { createHash } from "node:crypto";

import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { createCookie } from "react-router";
import { z } from "zod";

import {
  appUsers,
  authSessions,
  households,
} from "~/db/schema";
import type { Database } from "~/db/request-db.server";
import type { SessionIdentity } from "~/server/context.server";
import { getServerEnv } from "~/server/env.server";

const SESSION_ABSOLUTE_DAYS = 30;
const SESSION_IDLE_DAYS = 7;
const SESSION_TOUCH_MINUTES = 15;

const bearerTokenSchema = z
  .string()
  .min(40)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

function hashBearerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function getSessionCookie() {
  const env = getServerEnv();
  const production = env.NODE_ENV === "production";

  return createCookie(
    production ? "__Host-kitchen-ledger-session" : "kitchen-ledger-session",
    {
      httpOnly: true,
      maxAge: SESSION_ABSOLUTE_DAYS * 24 * 60 * 60,
      path: "/",
      sameSite: "lax",
      secrets: [env.SESSION_COOKIE_SECRET],
      secure: production,
    },
  );
}

async function readRawSessionToken(request: Request): Promise<string | null> {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) {
    return null;
  }

  const parsed: unknown = await getSessionCookie().parse(cookieHeader);
  const token = bearerTokenSchema.safeParse(parsed);
  return token.success ? token.data : null;
}

export async function resolveRequestIdentity(
  db: Database,
  request: Request,
): Promise<SessionIdentity | null> {
  const rawToken = await readRawSessionToken(request);
  if (!rawToken) {
    return null;
  }

  const now = new Date();
  const idleCutoff = new Date(
    now.getTime() - SESSION_IDLE_DAYS * 24 * 60 * 60 * 1_000,
  );
  const [session] = await db
    .select({
      email: appUsers.email,
      householdId: households.id,
      householdName: households.name,
      householdTimezone: households.timezone,
      lastSeenAt: authSessions.lastSeenAt,
      sessionId: authSessions.id,
      userId: appUsers.id,
      userName: appUsers.displayName,
    })
    .from(authSessions)
    .innerJoin(appUsers, eq(authSessions.appUserId, appUsers.id))
    .innerJoin(households, eq(authSessions.householdId, households.id))
    .where(
      and(
        eq(authSessions.tokenHash, hashBearerToken(rawToken)),
        eq(appUsers.active, true),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, now),
        gt(authSessions.lastSeenAt, idleCutoff),
      ),
    )
    .limit(1);

  if (!session) {
    return null;
  }

  const touchCutoff = new Date(
    now.getTime() - SESSION_TOUCH_MINUTES * 60 * 1_000,
  );

  if (session.lastSeenAt < touchCutoff) {
    await db
      .update(authSessions)
      .set({ lastSeenAt: now })
      .where(
        and(
          eq(authSessions.id, session.sessionId),
          lt(authSessions.lastSeenAt, touchCutoff),
          isNull(authSessions.revokedAt),
        ),
      );
  }

  return {
    email: session.email,
    householdId: session.householdId,
    householdName: session.householdName,
    householdTimezone: session.householdTimezone,
    userId: session.userId,
    userName: session.userName?.trim() || session.email.split("@")[0] || "Cook",
  };
}

export async function createSessionCookie(rawToken: string): Promise<string> {
  const token = bearerTokenSchema.parse(rawToken);
  return getSessionCookie().serialize(token);
}

export async function clearSessionCookie(): Promise<string> {
  return getSessionCookie().serialize("", { maxAge: 0 });
}

export async function revokeRequestSession(
  db: Database,
  request: Request,
): Promise<void> {
  const rawToken = await readRawSessionToken(request);
  if (!rawToken) {
    return;
  }

  await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(authSessions.tokenHash, hashBearerToken(rawToken)),
        isNull(authSessions.revokedAt),
      ),
    );
}
