import { KeyRound, Leaf, Mail } from "lucide-react";
import { Form, Link, redirect } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/auth-sign-in";
import { FormError, SubmitButton } from "~/components/form-controls";
import { requestMagicLink } from "~/server/auth/magic-link.server";
import {
  getRequestDatabase,
  identityContext,
} from "~/server/context.server";

const signInSchema = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
});

export const meta: Route.MetaFunction = () => [
  { title: "Sign in | Done For You Kitchen" },
  {
    name: "description",
    content: "Sign in to your household meal plan with a secure email link.",
  },
];

export function loader({ context }: Route.LoaderArgs) {
  if (context.get(identityContext)) {
    throw redirect("/");
  }

  return null;
}

export async function action({ context, request }: Route.ActionArgs) {
  const parsed = signInSchema.safeParse(
    Object.fromEntries(await request.formData()),
  );

  if (!parsed.success) {
    return {
      ok: false as const,
      error: "Enter a valid email address.",
      previewUrl: null,
    };
  }

  const result = await requestMagicLink(
    getRequestDatabase(context),
    parsed.data.email,
  );

  return {
    ok: true as const,
    error: null,
    previewUrl: result.previewUrl,
  };
}

export default function SignIn({ actionData }: Route.ComponentProps) {
  return (
    <main className="auth-page">
      <section className="auth-story" aria-labelledby="auth-story-title">
        <div>
          <Link className="brand auth-brand" to="/">
            <span className="brand-mark" aria-hidden="true">
              <Leaf size={21} />
            </span>
            <span className="brand-name">Done For You Kitchen</span>
          </Link>
          <p className="eyebrow">Household meal planning</p>
          <h1 id="auth-story-title">Buy the week. Keep the value.</h1>
          <p className="auth-intro">
            Plan dinners around who is home, what you already own, and what will
            still be useful next week.
          </p>
        </div>

        <blockquote className="thesis-card">
          <span>True weekly cost</span>
          <strong>what you buy</strong>
          <span className="thesis-minus">minus</span>
          <strong>what has a real chance of carrying forward</strong>
        </blockquote>
      </section>

      <section className="auth-form-panel" aria-labelledby="sign-in-title">
        <div className="auth-form-card">
          <span className="auth-icon" aria-hidden="true">
            <KeyRound size={23} />
          </span>
          <p className="eyebrow">Private household</p>
          <h2 id="sign-in-title">Open your kitchen</h2>
          <p>
            Enter one of the two household email addresses. We will send a
            single-use link that expires in 15 minutes.
          </p>

          {actionData?.ok ? (
            <div className="success-note" role="status">
              <Mail aria-hidden="true" size={18} />
              <span>
                If that address belongs to this household, its sign-in link is
                on the way.
              </span>
            </div>
          ) : null}

          <Form className="auth-form" method="post">
            <label className="field" htmlFor="email">
              <span className="field-label">Email address</span>
              <input
                autoComplete="email"
                autoFocus
                className="input"
                id="email"
                inputMode="email"
                name="email"
                placeholder="you@example.com"
                required
                type="email"
              />
            </label>
            <FormError>{actionData?.error}</FormError>
            <SubmitButton pendingLabel="Sending link">
              Email me a sign-in link
            </SubmitButton>
          </Form>

          {actionData?.previewUrl ? (
            <div className="preview-link" role="status">
              <strong>Development delivery</strong>
              <p>
                SMTP is not enabled, so this local-only preview completes the
                same one-time flow.
              </p>
              <a className="button button-secondary" href={actionData.previewUrl}>
                Use development sign-in link
              </a>
            </div>
          ) : null}

          <p className="auth-footnote">
            No passwords to remember. Links are one-time and sessions can be
            revoked from the server.
          </p>
        </div>
      </section>
    </main>
  );
}
