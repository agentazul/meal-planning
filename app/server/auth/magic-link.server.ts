import { createHash, randomBytes } from "node:crypto";

import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import nodemailer from "nodemailer";
import { z } from "zod";

import type { Database } from "~/db/request-db.server";
import {
  appUsers,
  authSessions,
  eventLogs,
  householdUsers,
  households,
  magicLinkTokens,
} from "~/db/schema";
import { getServerEnv } from "~/server/env.server";

const MAGIC_LINK_MINUTES = 15;
const SESSION_DAYS = 30;
const MAX_LINKS_PER_WINDOW = 5;

const rawMagicTokenSchema = z
  .string()
  .min(40)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

function createBearerToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashBearerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function deliverMagicLink(input: Readonly<{
  email: string;
  householdName: string;
  url: string;
}>): Promise<string | null> {
  const env = getServerEnv();

  if (env.MAGIC_LINK_DELIVERY === "console") {
    return env.NODE_ENV === "production" ? null : input.url;
  }

  const transport = nodemailer.createTransport({
    auth: env.SMTP_USER
      ? {
          pass: env.SMTP_PASSWORD ?? "",
          user: env.SMTP_USER,
        }
      : undefined,
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
  });

  await transport.sendMail({
    from: env.SMTP_FROM,
    subject: `Sign in to ${input.householdName}'s meal plan`,
    text: [
      `Use this one-time link to sign in to ${input.householdName}:`,
      "",
      input.url,
      "",
      `This link expires in ${MAGIC_LINK_MINUTES} minutes. If you did not request it, you can ignore this email.`,
    ].join("\n"),
    to: input.email,
  });

  return null;
}

export async function requestMagicLink(
  db: Database,
  normalizedEmail: string,
): Promise<Readonly<{ previewUrl: string | null }>> {
  const email = normalizedEmail.trim().toLowerCase();
  const [account] = await db
    .select({
      appUserId: appUsers.id,
      email: appUsers.email,
      householdId: households.id,
      householdName: households.name,
    })
    .from(appUsers)
    .innerJoin(householdUsers, eq(householdUsers.appUserId, appUsers.id))
    .innerJoin(households, eq(householdUsers.householdId, households.id))
    .where(
      and(
        sql`lower(btrim(${appUsers.email})) = ${email}`,
        eq(appUsers.active, true),
      ),
    )
    .limit(1);

  if (!account) {
    return { previewUrl: null };
  }

  const issuedLink = await db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${account.appUserId}::text, 0))`,
    );

    const windowStart = new Date(
      Date.now() - MAGIC_LINK_MINUTES * 60 * 1_000,
    );
    const [recent] = await transaction
      .select({ value: count() })
      .from(magicLinkTokens)
      .where(
        and(
          eq(magicLinkTokens.appUserId, account.appUserId),
          gt(magicLinkTokens.createdAt, windowStart),
        ),
      );

    if ((recent?.value ?? 0) >= MAX_LINKS_PER_WINDOW) {
      return null;
    }

    const rawToken = createBearerToken();
    const expiresAt = new Date(
      Date.now() + MAGIC_LINK_MINUTES * 60 * 1_000,
    );

    await transaction.insert(magicLinkTokens).values({
      appUserId: account.appUserId,
      expiresAt,
      tokenHash: hashBearerToken(rawToken),
    });

    return { rawToken };
  });

  if (!issuedLink) {
    return { previewUrl: null };
  }

  const url = new URL("/auth/verify", getServerEnv().APP_ORIGIN);
  url.searchParams.set("token", issuedLink.rawToken);

  const previewUrl = await deliverMagicLink({
    email: account.email,
    householdName: account.householdName,
    url: url.toString(),
  });

  await db.insert(eventLogs).values({
    eventType: "auth.magic_link_requested",
    householdId: account.householdId,
    payload: { appUserId: account.appUserId },
  });

  return { previewUrl };
}

export async function consumeMagicLink(
  db: Database,
  tokenInput: string,
): Promise<Readonly<{ rawSessionToken: string }> | null> {
  const parsedToken = rawMagicTokenSchema.safeParse(tokenInput);
  if (!parsedToken.success) {
    return null;
  }

  const now = new Date();
  const rawSessionToken = createBearerToken();

  return db.transaction(async (transaction) => {
    const [link] = await transaction
      .update(magicLinkTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(
            magicLinkTokens.tokenHash,
            hashBearerToken(parsedToken.data),
          ),
          isNull(magicLinkTokens.consumedAt),
          gt(magicLinkTokens.expiresAt, now),
        ),
      )
      .returning({ appUserId: magicLinkTokens.appUserId });

    if (!link) {
      return null;
    }

    const [membership] = await transaction
      .select({
        householdId: householdUsers.householdId,
      })
      .from(householdUsers)
      .innerJoin(appUsers, eq(householdUsers.appUserId, appUsers.id))
      .where(
        and(
          eq(householdUsers.appUserId, link.appUserId),
          eq(appUsers.active, true),
        ),
      )
      .limit(1);

    if (!membership) {
      return null;
    }

    await transaction.insert(authSessions).values({
      appUserId: link.appUserId,
      expiresAt: new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1_000),
      householdId: membership.householdId,
      tokenHash: hashBearerToken(rawSessionToken),
    });

    await transaction.insert(eventLogs).values({
      eventType: "auth.session_created",
      householdId: membership.householdId,
      payload: { appUserId: link.appUserId },
    });

    return { rawSessionToken };
  });
}
