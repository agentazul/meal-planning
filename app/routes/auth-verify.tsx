import { CircleAlert, KeyRound, Leaf } from "lucide-react";
import { Form, Link, redirect } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/auth-verify";
import { consumeMagicLink } from "~/server/auth/magic-link.server";
import { createSessionCookie } from "~/server/auth/session.server";
import { getRequestDatabase } from "~/server/context.server";

const tokenSchema = z
  .string()
  .min(40)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const invalidLinkMessage =
  "This sign-in link is invalid, expired, or has already been used.";

export const meta: Route.MetaFunction = () => [
  { title: "Verify sign in | Done For You Kitchen" },
  { name: "robots", content: "noindex, nofollow" },
];

export function headers() {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  };
}

export function loader({ request }: Route.LoaderArgs) {
  const token = tokenSchema.safeParse(
    new URL(request.url).searchParams.get("token"),
  );

  if (!token.success) {
    return {
      error: "This sign-in link is incomplete or malformed.",
      token: null,
    };
  }

  return { error: null, token: token.data };
}

export async function action({ context, request }: Route.ActionArgs) {
  const token = tokenSchema.safeParse(
    (await request.formData()).get("token"),
  );

  if (!token.success) {
    return { error: invalidLinkMessage };
  }

  const result = await consumeMagicLink(
    getRequestDatabase(context),
    token.data,
  );

  if (!result) {
    return { error: invalidLinkMessage };
  }

  throw redirect("/", {
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": await createSessionCookie(result.rawSessionToken),
      "X-Frame-Options": "DENY",
    },
  });
}

export default function VerifySignIn({
  actionData,
  loaderData,
}: Route.ComponentProps) {
  const error = actionData?.error ?? loaderData.error;

  return (
    <main className="auth-page auth-page-centered">
      <section className="auth-form-card verify-card">
        <Link className="brand auth-brand" to="/auth/sign-in">
          <span className="brand-mark" aria-hidden="true">
            <Leaf size={21} />
          </span>
          <span className="brand-name">Done For You Kitchen</span>
        </Link>
        {error ? (
          <>
            <span className="auth-icon auth-icon-alert" aria-hidden="true">
              <CircleAlert size={24} />
            </span>
            <p className="eyebrow">Link not accepted</p>
            <h1>Let us send a fresh one</h1>
            <p>{error}</p>
            <Link className="button button-primary" to="/auth/sign-in">
              Request another link
            </Link>
          </>
        ) : (
          <>
            <span className="auth-icon" aria-hidden="true">
              <KeyRound size={24} />
            </span>
            <p className="eyebrow">Secure sign in</p>
            <h1>Finish opening your kitchen</h1>
            <p>
              Continue to use this one-time link. It will be consumed only when
              you confirm below.
            </p>
            <Form action="/auth/verify" method="post">
              <input name="token" type="hidden" value={loaderData.token ?? ""} />
              <button className="button button-primary" type="submit">
                Continue to the meal planner
              </button>
            </Form>
          </>
        )}
      </section>
    </main>
  );
}
