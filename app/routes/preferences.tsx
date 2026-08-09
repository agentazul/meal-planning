import {
  BookOpenText,
  CircleAlert,
  Clock3,
  CookingPot,
  HeartHandshake,
  Save,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { useState } from "react";
import { data, Form } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/preferences";
import { FormError, SubmitButton } from "~/components/form-controls";
import { PageHeader } from "~/components/page-header";
import {
  requireIdentity,
  requireScopedDatabase,
} from "~/server/context.server";
import {
  KITCHEN_PREFERENCES_MAX_LENGTH,
  KitchenPreferencesValidationError,
  getHouseholdKitchenPreferences,
  kitchenPreferencesMarkdownSchema,
  saveHouseholdKitchenPreferences,
} from "~/server/data/preferences.server";

const preferencesFormSchema = z
  .object({
    intent: z.literal("save"),
    markdown: kitchenPreferencesMarkdownSchema,
  })
  .strict();

type ActionResult =
  | Readonly<{
      error: string;
      markdown: string;
      ok: false;
    }>
  | Readonly<{
      markdown: string;
      message: string;
      ok: true;
    }>;

export const meta: Route.MetaFunction = () => [
  { title: "Kitchen preferences | Done For You Kitchen" },
  {
    name: "description",
    content:
      "Keep one shared household note for recipe preferences, safety needs, and kitchen routines.",
  },
];

export async function loader({ context }: Route.LoaderArgs) {
  const identity = requireIdentity(context);
  const preferences = await getHouseholdKitchenPreferences(
    requireScopedDatabase(context),
  );

  return {
    ...preferences,
    maximumCharacterCount: KITCHEN_PREFERENCES_MAX_LENGTH,
    updatedAtLabel: preferences.updatedAt
      ? new Intl.DateTimeFormat("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: identity.householdTimezone,
        }).format(preferences.updatedAt)
      : null,
  };
}

function submittedMarkdown(formData: FormData): string {
  const value = formData.get("markdown");
  return typeof value === "string"
    ? value.slice(0, KITCHEN_PREFERENCES_MAX_LENGTH + 1)
    : "";
}

function firstValidationMessage(error: z.ZodError): string {
  return (
    error.issues[0]?.message ?? "Check the kitchen preferences and try again."
  );
}

export async function action({
  context,
  request,
}: Route.ActionArgs) {
  requireIdentity(context);
  const formData = await request.formData();
  const markdown = submittedMarkdown(formData);
  const parsed = preferencesFormSchema.safeParse(
    Object.fromEntries(formData.entries()),
  );

  if (!parsed.success) {
    return data<ActionResult>(
      {
        error: firstValidationMessage(parsed.error),
        markdown,
        ok: false,
      },
      { status: 400 },
    );
  }

  try {
    const saved = await saveHouseholdKitchenPreferences(
      requireScopedDatabase(context),
      { markdown: parsed.data.markdown },
    );

    return {
      markdown: saved.markdown,
      message: "Kitchen preferences saved.",
      ok: true as const,
    };
  } catch (error) {
    if (error instanceof KitchenPreferencesValidationError) {
      return data<ActionResult>(
        { error: error.userMessage, markdown, ok: false },
        { status: 400 },
      );
    }
    throw error;
  }
}

const writingPrompts = [
  {
    copy: "List every allergy, medical dietary need, and ingredient that must stay out.",
    icon: ShieldCheck,
    title: "Safety first",
  },
  {
    copy: "Name personal spice levels, texture preferences, and reliable family favorites.",
    icon: UsersRound,
    title: "People at the table",
  },
  {
    copy: "Set weeknight time limits, cleanup tolerance, and the equipment you actually use.",
    icon: Clock3,
    title: "Your real routine",
  },
  {
    copy: "Keep a short rotation of proteins and cuisines, plus a clear list of hard nos.",
    icon: CookingPot,
    title: "Flavor direction",
  },
] as const;

export default function PreferencesPage({
  actionData,
  loaderData,
}: Route.ComponentProps) {
  const [markdown, setMarkdown] = useState(
    actionData?.markdown ?? loaderData.markdown,
  );
  const characterCount = markdown.length;
  const isTooLong = characterCount > loaderData.maximumCharacterCount;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        description="Write one living note that captures safety needs, individual tastes, practical limits, and the meals your family wants more often. Recipe generation can use it as the household source of truth."
        eyebrow="Household playbook"
        title="Teach the kitchen how your family eats."
      />

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
        <Form className="surface overflow-hidden" method="post">
          <input name="intent" type="hidden" value="save" />

          <header className="flex flex-wrap items-center justify-between gap-4 border-b border-rule bg-herb px-5 py-5 text-paper-light sm:px-7">
            <div>
              <p className="mb-2 flex items-center gap-2 text-[0.68rem] font-bold tracking-[0.14em] text-butter uppercase">
                <BookOpenText aria-hidden="true" size={15} />
                Kitchen preference document
              </p>
              <h2 className="m-0 text-3xl text-paper-light">
                One note, easy to change
              </h2>
            </div>
            <span className="rounded-full border border-paper-light/25 bg-paper-light/10 px-3 py-1.5 text-xs font-bold text-paper-light">
              {loaderData.isStarter ? "Starter profile" : "Saved profile"}
            </span>
          </header>

          <div className="grid gap-4 p-5 sm:p-7">
            {loaderData.isStarter ? (
              <div className="flex gap-3 rounded-xl border border-butter/60 bg-butter/15 p-4 text-sm leading-6 text-ink">
                <HeartHandshake
                  aria-hidden="true"
                  className="mt-0.5 shrink-0 text-clay"
                  size={19}
                />
                <p className="m-0">
                  Start with the family-friendly outline below. Replace the
                  placeholders, especially allergies and medical dietary needs,
                  then save it as your household profile.
                </p>
              </div>
            ) : null}

            <label className="field" htmlFor="kitchen-preferences">
              <span className="field-label">Shared markdown note</span>
              <textarea
                aria-describedby="preference-editor-help preference-character-count"
                aria-invalid={
                  isTooLong || (actionData && !actionData.ok) || undefined
                }
                autoCapitalize="sentences"
                autoCorrect="on"
                className="textarea min-h-[36rem] resize-y bg-[#fffdf8] font-mono text-[0.9rem] leading-7 shadow-inner"
                id="kitchen-preferences"
                maxLength={loaderData.maximumCharacterCount + 1}
                name="markdown"
                onChange={(event) => setMarkdown(event.currentTarget.value)}
                required
                spellCheck
                value={markdown}
              />
              <span
                className="flex flex-wrap items-center justify-between gap-2 text-xs leading-5 text-muted"
                id="preference-editor-help"
              >
                <span>
                  Use headings, short paragraphs, and lists. Regular hyphens are
                  supported; long dash characters are rejected.
                </span>
                <span
                  className={isTooLong ? "font-bold text-clay" : "font-semibold"}
                  id="preference-character-count"
                >
                  {characterCount.toLocaleString("en-US")} /{" "}
                  {loaderData.maximumCharacterCount.toLocaleString("en-US")}
                </span>
              </span>
            </label>

            {actionData?.ok ? (
              <div
                className="rounded-xl border border-herb/35 bg-herb/10 px-4 py-3 text-sm font-semibold text-herb"
                role="status"
              >
                {actionData.message}
              </div>
            ) : (
              <FormError>{actionData?.error}</FormError>
            )}

            <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-rule pt-5">
              <p className="m-0 flex max-w-md items-center gap-2 text-xs leading-5 text-muted">
                <ShieldCheck aria-hidden="true" className="shrink-0" size={16} />
                Review every generated recipe for allergy safety. This profile
                guides suggestions but is not a medical safeguard.
              </p>
              <SubmitButton
                pendingLabel="Saving preferences"
                pendingMatch={{ intent: "save" }}
              >
                <Save aria-hidden="true" size={17} />
                Save kitchen preferences
              </SubmitButton>
            </footer>
          </div>
        </Form>

        <aside className="grid gap-5 lg:sticky lg:top-24">
          <section className="surface overflow-hidden">
            <div className="border-b border-rule bg-butter/25 p-5 sm:p-6">
              <p className="eyebrow">A useful profile</p>
              <h2 className="m-0 text-2xl">Write what changes dinner.</h2>
            </div>
            <ol className="m-0 grid list-none gap-0 p-0">
              {writingPrompts.map(({ copy, icon: Icon, title }, index) => (
                <li
                  className="flex gap-3 border-b border-rule p-5 last:border-b-0"
                  key={title}
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-herb text-paper-light">
                    <Icon aria-hidden="true" size={17} />
                  </span>
                  <span>
                    <strong className="block text-sm text-ink">
                      {index + 1}. {title}
                    </strong>
                    <span className="mt-1 block text-xs leading-5 text-muted">
                      {copy}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section className="rounded-[1.2rem] border border-clay/35 bg-[#fff7f3] p-5 shadow-[0_0.7rem_2rem_rgba(29,42,34,0.05)]">
            <p className="m-0 flex items-center gap-2 text-sm font-bold text-clay">
              <CircleAlert aria-hidden="true" size={18} />
              Keep private data out
            </p>
            <p className="mt-2 mb-0 text-xs leading-5 text-muted">
              Food needs and first names are useful. Passwords, account numbers,
              medical records, and other secrets do not belong here.
            </p>
          </section>

          <p className="m-0 px-2 text-center text-xs font-semibold text-muted">
            {loaderData.updatedAtLabel
              ? `Last saved ${loaderData.updatedAtLabel}`
              : "Not saved yet"}
          </p>
        </aside>
      </div>
    </div>
  );
}
