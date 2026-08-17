import {
  ArrowLeft,
  CalendarCheck2,
  CalendarRange,
  ChevronDown,
  CircleUserRound,
  Home,
  Info,
  PauseCircle,
  PlayCircle,
  RotateCcw,
  Settings2,
  Trash2,
  UserCheck,
  UserMinus,
} from "lucide-react";
import { Form, Link } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/presence";
import { FormError, SubmitButton } from "~/components/form-controls";
import { PageHeader } from "~/components/page-header";
import {
  formatDateLabel,
  getWeekDates,
  getWeekStartDate,
  parseDateOnly,
  todayInTimezone,
} from "~/domain/dates";
import {
  resolvePresence,
  type PresenceResolution,
  type PresenceRule,
} from "~/domain/presence";
import {
  clearPresenceOverride,
  createPresenceRule,
  deletePresenceRule,
  listPresenceMembers,
  setHouseholdMemberActive,
  setHouseholdMemberDefaultPresence,
  setPresenceOverride,
  updateHouseholdMember,
} from "~/server/data/presence.server";
import { refreshPlanServingTargets } from "~/server/data/week.server";
import {
  requireIdentity,
  requireScopedDatabase,
} from "~/server/context.server";

const dateOnlySchema = z
  .string()
  .trim()
  .refine(
    (value) => {
      try {
        parseDateOnly(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Enter a valid date." },
  );

const memberIdSchema = z.uuid("Choose a valid household member.");
const optionalNoteSchema = z
  .string()
  .trim()
  .max(2_000, "Notes must be 2,000 characters or fewer.")
  .transform((value) => (value.length === 0 ? null : value));
const optionalShortNoteSchema = z
  .string()
  .trim()
  .max(500, "Notes must be 500 characters or fewer.")
  .transform((value) => (value.length === 0 ? null : value));

const appetiteSchema = z
  .string()
  .trim()
  .regex(
    /^\d+(?:\.\d{1,2})?$/,
    "Enter an appetite value with up to two decimal places.",
  )
  .transform(Number)
  .pipe(
    z
      .number()
      .finite()
      .gt(0, "Appetite must be greater than zero.")
      .lte(4, "Appetite cannot be greater than 4."),
  );

const prioritySchema = z
  .string()
  .trim()
  .regex(/^-?\d+$/, "Priority must be a whole number.")
  .transform(Number)
  .pipe(
    z
      .number()
      .int()
      .min(-1_000_000, "Priority is too low.")
      .max(1_000_000, "Priority is too high."),
  );

const updateMemberSchema = z.strictObject({
  intent: z.literal("update-member"),
  memberId: memberIdSchema,
  displayName: z.string().trim().min(1, "Enter a name.").max(100),
  memberType: z.enum(["adult", "child"]),
  appetiteMultiplier: appetiteSchema,
  dietaryNotes: optionalNoteSchema,
});

const setDefaultPresenceSchema = z.strictObject({
  intent: z.literal("set-default-presence"),
  memberId: memberIdSchema,
  status: z.enum(["present", "absent"]),
});

const setMemberActiveSchema = z.strictObject({
  intent: z.literal("set-member-active"),
  memberId: memberIdSchema,
  active: z.enum(["true", "false"]).transform((value) => value === "true"),
});

const weekdaySchema = z.enum(["SU", "MO", "TU", "WE", "TH", "FR", "SA"]);

const addRuleSchema = z
  .strictObject({
    intent: z.literal("add-rule"),
    memberId: memberIdSchema,
    effect: z.enum(["present", "absent"]),
    interval: z.enum(["1", "2"]),
    weekdays: z
      .array(weekdaySchema)
      .refine((values) => new Set(values).size === values.length, {
        message: "Choose each weekday once.",
      }),
    effectiveFrom: dateOnlySchema,
    effectiveTo: z
      .union([dateOnlySchema, z.literal("")])
      .transform((value) => (value === "" ? null : value)),
    priority: prioritySchema,
  })
  .superRefine((value, context) => {
    if (value.weekdays.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["weekdays"],
        message: "Choose at least one weekday.",
      });
    }

    if (
      value.effectiveTo &&
      parseDateOnly(value.effectiveTo).since(parseDateOnly(value.effectiveFrom))
        .sign < 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["effectiveTo"],
        message: "End date cannot be before start date.",
      });
    }
  });

const deleteRuleSchema = z.strictObject({
  intent: z.literal("delete-rule"),
  ruleId: z.uuid("Choose a valid rule."),
});

const setOverrideSchema = z.strictObject({
  intent: z.literal("set-override"),
  memberId: memberIdSchema,
  date: dateOnlySchema,
  status: z.enum(["present", "absent"]),
  note: optionalShortNoteSchema,
});

const clearOverrideSchema = z.strictObject({
  intent: z.literal("clear-override"),
  memberId: memberIdSchema,
  date: dateOnlySchema,
});

const intentSchema = z.enum([
  "update-member",
  "set-default-presence",
  "set-member-active",
  "add-rule",
  "delete-rule",
  "set-override",
  "clear-override",
]);

type ActionResult =
  | Readonly<{ ok: true; message: string }>
  | Readonly<{ ok: false; error: string }>;

type DatePreview =
  | Readonly<{
      date: string;
      error: null;
      resolution: PresenceResolution;
    }>
  | Readonly<{
      date: string;
      error: string;
      resolution: null;
    }>;

const weekdayOptions = [
  { value: "SU", label: "Sun" },
  { value: "MO", label: "Mon" },
  { value: "TU", label: "Tue" },
  { value: "WE", label: "Wed" },
  { value: "TH", label: "Thu" },
  { value: "FR", label: "Fri" },
  { value: "SA", label: "Sat" },
] as const;

export const meta: Route.MetaFunction = () => [
  { title: "Presence | Done For You Kitchen" },
  {
    name: "description",
    content: "Manage household schedules and one time presence changes.",
  },
];

function getEightWeekDates(weekStart: string): readonly string[] {
  const start = parseDateOnly(weekStart);
  return Array.from({ length: 8 }, (_, weekIndex) =>
    getWeekDates(start.add({ weeks: weekIndex }).toString()),
  ).flat();
}

function makeDatePreview(
  date: string,
  defaultIsPresent: boolean,
  rules: readonly PresenceRule[],
  overrides: Parameters<typeof resolvePresence>[0]["overrides"],
): DatePreview {
  try {
    return {
      date,
      error: null,
      resolution: resolvePresence({
        date,
        defaultIsPresent,
        rules,
        overrides,
      }),
    };
  } catch (error: unknown) {
    return {
      date,
      error:
        error instanceof Error
          ? error.message
          : "Presence could not be resolved.",
      resolution: null,
    };
  }
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const identity = requireIdentity(context);
  const scoped = requireScopedDatabase(context);
  const today = todayInTimezone(identity.householdTimezone);
  const requestedWeek = new URL(request.url).searchParams.get("week");
  const parsedWeek = requestedWeek
    ? dateOnlySchema.safeParse(requestedWeek)
    : null;

  if (parsedWeek && !parsedWeek.success) {
    throw new Response("The week query must be a valid date.", { status: 400 });
  }

  const rangeStart = getWeekStartDate(parsedWeek?.data ?? today);
  const previewStart = parsedWeek ? rangeStart : today;
  const rangeDates = getEightWeekDates(rangeStart);
  const rangeEnd = rangeDates.at(-1);

  if (!rangeEnd) {
    throw new Error("Presence preview range could not be created.");
  }

  const members = await listPresenceMembers(scoped, {
    from: rangeStart,
    includeInactive: true,
    to: rangeEnd,
  });

  return {
    householdTimezone: identity.householdTimezone,
    previewStart,
    rangeEnd,
    rangeStart,
    selectedWeek: parsedWeek !== null,
    today,
    weekStart: rangeStart,
    members: members.map((member) => ({
      ...member,
      preview: rangeDates.map((date) =>
        makeDatePreview(
          date,
          member.defaultIsPresent,
          member.rules,
          member.overrides,
        ),
      ),
    })),
  };
}

function firstValidationMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Check the form and try again.";
}

function actionError(error: unknown): ActionResult {
  console.error("Presence action failed", error);

  return {
    ok: false,
    error:
      "The presence change could not be saved. Check the form and try again.",
  };
}

export async function action({
  context,
  request,
}: Route.ActionArgs): Promise<ActionResult> {
  requireIdentity(context);
  const scoped = requireScopedDatabase(context);
  const formData = await request.formData();
  const intentResult = intentSchema.safeParse(formData.get("intent"));

  if (!intentResult.success) {
    return { ok: false, error: "Choose a valid presence action." };
  }

  try {
    switch (intentResult.data) {
      case "update-member": {
        const parsed = updateMemberSchema.safeParse({
          intent: intentResult.data,
          memberId: formData.get("memberId"),
          displayName: formData.get("displayName"),
          memberType: formData.get("memberType"),
          appetiteMultiplier: formData.get("appetiteMultiplier"),
          dietaryNotes: formData.get("dietaryNotes"),
        });

        if (!parsed.success) {
          return { ok: false, error: firstValidationMessage(parsed.error) };
        }

        const updated = await updateHouseholdMember(scoped, parsed.data);
        if (!updated) {
          return { ok: false, error: "Household member was not found." };
        }

        await refreshPlanServingTargets(scoped);
        return { ok: true, message: "Household member updated." };
      }

      case "set-default-presence": {
        const parsed = setDefaultPresenceSchema.safeParse({
          intent: intentResult.data,
          memberId: formData.get("memberId"),
          status: formData.get("status"),
        });

        if (!parsed.success) {
          return { ok: false, error: firstValidationMessage(parsed.error) };
        }

        const updated = await setHouseholdMemberDefaultPresence(scoped, {
          defaultIsPresent: parsed.data.status === "present",
          memberId: parsed.data.memberId,
        });
        if (!updated) {
          return { ok: false, error: "Household member was not found." };
        }

        await refreshPlanServingTargets(scoped);
        return {
          ok: true,
          message:
            parsed.data.status === "present"
              ? "Usual presence set to Home."
              : "Usual presence set to Away.",
        };
      }

      case "set-member-active": {
        const parsed = setMemberActiveSchema.safeParse({
          intent: intentResult.data,
          memberId: formData.get("memberId"),
          active: formData.get("active"),
        });

        if (!parsed.success) {
          return { ok: false, error: firstValidationMessage(parsed.error) };
        }

        const updated = await setHouseholdMemberActive(scoped, {
          active: parsed.data.active,
          memberId: parsed.data.memberId,
        });
        if (!updated) {
          return { ok: false, error: "Household member was not found." };
        }

        await refreshPlanServingTargets(scoped);
        return {
          ok: true,
          message: parsed.data.active
            ? "Member returned to meal planning."
            : "Member paused from meal planning.",
        };
      }

      case "add-rule": {
        const parsed = addRuleSchema.safeParse({
          intent: intentResult.data,
          memberId: formData.get("memberId"),
          effect: formData.get("effect"),
          interval: formData.get("interval"),
          weekdays: formData.getAll("weekday"),
          effectiveFrom: formData.get("effectiveFrom"),
          effectiveTo: formData.get("effectiveTo"),
          priority: formData.get("priority"),
        });

        if (!parsed.success) {
          return { ok: false, error: firstValidationMessage(parsed.error) };
        }

        const rrule = `FREQ=WEEKLY;INTERVAL=${parsed.data.interval};BYDAY=${parsed.data.weekdays.join(",")}`;

        await createPresenceRule(scoped, {
          effect: parsed.data.effect,
          effectiveFrom: parsed.data.effectiveFrom,
          effectiveTo: parsed.data.effectiveTo,
          memberId: parsed.data.memberId,
          priority: parsed.data.priority,
          rrule,
        });
        await refreshPlanServingTargets(scoped);
        return { ok: true, message: "Repeating schedule saved." };
      }

      case "delete-rule": {
        const parsed = deleteRuleSchema.safeParse({
          intent: intentResult.data,
          ruleId: formData.get("ruleId"),
        });

        if (!parsed.success) {
          return { ok: false, error: firstValidationMessage(parsed.error) };
        }

        const deleted = await deletePresenceRule(scoped, parsed.data.ruleId);
        if (!deleted) {
          return { ok: false, error: "Presence rule was not found." };
        }

        await refreshPlanServingTargets(scoped);
        return { ok: true, message: "Repeating schedule deleted." };
      }

      case "set-override": {
        const parsed = setOverrideSchema.safeParse({
          intent: intentResult.data,
          memberId: formData.get("memberId"),
          date: formData.get("date"),
          status: formData.get("status"),
          note: formData.get("note"),
        });

        if (!parsed.success) {
          return { ok: false, error: firstValidationMessage(parsed.error) };
        }

        await setPresenceOverride(scoped, {
          date: parsed.data.date,
          isPresent: parsed.data.status === "present",
          memberId: parsed.data.memberId,
          note: parsed.data.note,
        });
        await refreshPlanServingTargets(scoped);
        return { ok: true, message: "One time presence change saved." };
      }

      case "clear-override": {
        const parsed = clearOverrideSchema.safeParse({
          intent: intentResult.data,
          memberId: formData.get("memberId"),
          date: formData.get("date"),
        });

        if (!parsed.success) {
          return { ok: false, error: firstValidationMessage(parsed.error) };
        }

        const cleared = await clearPresenceOverride(scoped, parsed.data);
        if (!cleared) {
          return {
            ok: false,
            error: "No one time change exists for that date.",
          };
        }

        await refreshPlanServingTargets(scoped);
        return { ok: true, message: "Usual schedule restored for that date." };
      }
    }
  } catch (error: unknown) {
    return actionError(error);
  }
}

function formatRuleDates(rule: PresenceRule): string {
  const start = formatDateLabel(rule.effectiveFrom, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  if (!rule.effectiveTo) {
    return `Starts ${start}, no end date`;
  }
  const end = formatDateLabel(rule.effectiveTo, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${start} through ${end}`;
}

function formatWeekdayList(values: readonly string[]): string {
  const names = values.flatMap((value) => {
    const option = weekdayOptions.find((weekday) => weekday.value === value);
    return option ? [option.label] : [];
  });
  if (names.length < 2) return names[0] ?? "selected days";
  if (names.length === 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

function formatRuleSummary(rule: PresenceRule): string {
  const fields = new Map(
    rule.rrule
      .replace(/^RRULE:/i, "")
      .split(";")
      .flatMap((part) => {
        const separator = part.indexOf("=");
        return separator > 0
          ? [
              [
                part.slice(0, separator).toUpperCase(),
                part.slice(separator + 1),
              ],
            ]
          : [];
      }),
  );
  const weekdays = fields.get("BYDAY")?.split(",") ?? [];
  if (fields.get("FREQ") === "WEEKLY" && weekdays.length > 0) {
    const cadence =
      fields.get("INTERVAL") === "2" ? "every other week" : "every week";
    return `${rule.effect === "present" ? "Home" : "Away"} ${cadence} on ${formatWeekdayList(weekdays)}`;
  }
  return `${rule.effect === "present" ? "Home" : "Away"} on a custom repeating schedule`;
}

function previewSourceLabel(preview: DatePreview): string {
  if (preview.error) return "Schedule error";
  if (!preview.resolution) return "Schedule error";
  if (preview.resolution.source === "override") return "One time change";
  if (preview.resolution.source === "rule") return "Recurring rule";
  return "Default schedule";
}

function PresencePreviewTile({
  member,
  preview,
}: Readonly<{
  member: Route.ComponentProps["loaderData"]["members"][number];
  preview: DatePreview;
}>) {
  const weekday = formatDateLabel(preview.date, { weekday: "short" });
  const dateLabel = formatDateLabel(preview.date, {
    month: "short",
    day: "numeric",
  });

  if (preview.error || !preview.resolution) {
    return (
      <li className="min-w-0 rounded-xl border border-clay/40 bg-red-50 p-3">
        <p className="m-0 text-xs font-bold uppercase tracking-[0.12em] text-clay">
          {weekday}
        </p>
        <p className="mt-1 mb-0 text-sm font-semibold">{dateLabel}</p>
        <p className="mt-2 mb-0 text-xs font-bold text-clay">Schedule error</p>
        <span className="sr-only">{preview.error}</span>
      </li>
    );
  }

  const isPresent = preview.resolution.isPresent;
  if (!member.active) {
    return (
      <li className="min-w-0 rounded-xl border border-rule bg-paper p-3 opacity-70">
        <p className="m-0 text-xs font-bold uppercase tracking-[0.12em] text-muted">
          {weekday}
        </p>
        <p className="mt-1 mb-0 text-sm font-semibold">{dateLabel}</p>
        <p className="mt-2 mb-0 text-xs font-bold text-muted">Not counted</p>
      </li>
    );
  }

  return (
    <li
      className={
        isPresent
          ? "min-w-0 overflow-hidden rounded-xl border border-herb/30 bg-green-50/70"
          : "min-w-0 overflow-hidden rounded-xl border border-clay/30 bg-orange-50/80"
      }
    >
      <Form method="post">
        <input name="intent" type="hidden" value="set-override" />
        <input name="memberId" type="hidden" value={member.id} />
        <input name="date" type="hidden" value={preview.date} />
        <input name="note" type="hidden" value="" />
        <input
          name="status"
          type="hidden"
          value={isPresent ? "absent" : "present"}
        />
        <SubmitButton
          className="block min-h-28 w-full cursor-pointer bg-transparent p-3 text-left transition hover:bg-white/55 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-herb disabled:cursor-wait"
          pendingLabel="Saving day"
          pendingMatch={{
            date: preview.date,
            intent: "set-override",
            memberId: member.id,
          }}
        >
          <span className="block text-xs font-bold uppercase tracking-[0.12em] text-muted">
            {weekday}
          </span>
          <span className="mt-1 block text-sm font-semibold text-ink">
            {dateLabel}
          </span>
          <span
            className={
              isPresent
                ? "mt-2 block text-sm font-bold text-herb"
                : "mt-2 block text-sm font-bold text-clay"
            }
          >
            {isPresent ? "Home" : "Away"}
          </span>
          <span className="mt-1 block text-[0.68rem] font-semibold text-muted">
            Tap to mark {isPresent ? "Away" : "Home"}
          </span>
        </SubmitButton>
      </Form>
      {preview.resolution.source === "override" ? (
        <Form className="border-t border-current/10 p-2" method="post">
          <input name="intent" type="hidden" value="clear-override" />
          <input name="memberId" type="hidden" value={member.id} />
          <input name="date" type="hidden" value={preview.date} />
          <SubmitButton
            className="flex min-h-8 w-full items-center justify-center gap-1 rounded-lg bg-white/65 px-2 text-[0.68rem] font-bold text-muted hover:text-ink"
            pendingLabel="Resetting"
            pendingMatch={{
              date: preview.date,
              intent: "clear-override",
              memberId: member.id,
            }}
          >
            <RotateCcw aria-hidden="true" size={12} />
            Use usual schedule
          </SubmitButton>
        </Form>
      ) : (
        <p className="m-0 border-t border-current/10 px-3 py-2 text-[0.65rem] font-semibold text-muted">
          {previewSourceLabel(preview)}
        </p>
      )}
    </li>
  );
}

function MemberEditor({
  member,
}: Readonly<{
  member: Route.ComponentProps["loaderData"]["members"][number];
}>) {
  const prefix = `member-${member.id}`;

  return (
    <details className="group rounded-2xl border border-rule bg-white/45">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 font-bold text-herb marker:hidden">
        <span className="inline-flex items-center gap-2">
          <Settings2 aria-hidden="true" size={17} />
          Profile and serving details
        </span>
        <ChevronDown
          aria-hidden="true"
          className="transition-transform group-open:rotate-180"
          size={18}
        />
      </summary>
      <Form
        className="grid gap-4 border-t border-rule p-4 md:grid-cols-2"
        method="post"
      >
        <input name="intent" type="hidden" value="update-member" />
        <input name="memberId" type="hidden" value={member.id} />

        <label className="field" htmlFor={`${prefix}-name`}>
          <span className="field-label">Name</span>
          <input
            className="input"
            defaultValue={member.displayName}
            id={`${prefix}-name`}
            maxLength={100}
            name="displayName"
            required
          />
        </label>

        <label className="field" htmlFor={`${prefix}-type`}>
          <span className="field-label">Member type</span>
          <select
            className="select"
            defaultValue={member.memberType}
            id={`${prefix}-type`}
            name="memberType"
          >
            <option value="adult">Adult</option>
            <option value="child">Child</option>
          </select>
        </label>

        <label className="field md:col-span-2" htmlFor={`${prefix}-appetite`}>
          <span className="field-label">Appetite value</span>
          <input
            className="input"
            defaultValue={member.appetiteMultiplier}
            id={`${prefix}-appetite`}
            inputMode="decimal"
            max="4"
            min="0.01"
            name="appetiteMultiplier"
            required
            step="0.01"
            type="number"
          />
          <span className="field-help">
            One adult serving is 1.00. This value drives dinner quantity.
          </span>
        </label>

        <label className="field md:col-span-2" htmlFor={`${prefix}-notes`}>
          <span className="field-label">Dietary notes</span>
          <textarea
            className="textarea"
            defaultValue={member.dietaryNotes ?? ""}
            id={`${prefix}-notes`}
            maxLength={2_000}
            name="dietaryNotes"
            placeholder="Allergies, preferences, or serving notes"
            rows={3}
          />
        </label>

        <div className="md:col-span-2">
          <SubmitButton
            pendingLabel="Saving member"
            pendingMatch={{ intent: "update-member", memberId: member.id }}
          >
            Save member
          </SubmitButton>
        </div>
      </Form>
    </details>
  );
}

function DefaultPresenceButtons({
  member,
}: Readonly<{
  member: Route.ComponentProps["loaderData"]["members"][number];
}>) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:min-w-72">
      {(
        [
          { label: "Usually home", status: "present" },
          { label: "Usually away", status: "absent" },
        ] as const
      ).map((option) => {
        const selected =
          member.defaultIsPresent === (option.status === "present");
        return (
          <Form key={option.status} method="post">
            <input name="intent" type="hidden" value="set-default-presence" />
            <input name="memberId" type="hidden" value={member.id} />
            <input name="status" type="hidden" value={option.status} />
            <SubmitButton
              className={
                selected
                  ? "button min-h-12 w-full border border-herb bg-herb text-paper-light"
                  : "button button-secondary min-h-12 w-full"
              }
              pendingLabel="Updating"
              pendingMatch={{
                intent: "set-default-presence",
                memberId: member.id,
                status: option.status,
              }}
            >
              {selected ? <UserCheck aria-hidden="true" size={17} /> : null}
              {option.label}
            </SubmitButton>
          </Form>
        );
      })}
    </div>
  );
}

function HouseholdDefaultsPanel({
  members,
}: Readonly<{
  members: Route.ComponentProps["loaderData"]["members"];
}>) {
  return (
    <section
      className="surface overflow-hidden"
      aria-labelledby="usual-presence"
    >
      <div className="border-b border-rule bg-paper-light/80 p-5 sm:p-6">
        <p className="eyebrow">Usual attendance</p>
        <h2 className="m-0 text-3xl" id="usual-presence">
          Set the everyday starting point
        </h2>
        <p className="mt-2 mb-0 max-w-3xl text-sm leading-6 text-muted">
          Choose Usually away for someone who only joins occasionally. You can
          mark the individual dates they will be Home below.
        </p>
      </div>
      <div className="divide-y divide-rule">
        {members.map((member) => (
          <div
            className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-6"
            key={member.id}
          >
            <div className="min-w-0">
              <h3 className="m-0 truncate text-xl">{member.displayName}</h3>
              <p className="mt-1 mb-0 text-xs font-semibold text-muted">
                {member.active
                  ? `Currently Usually ${member.defaultIsPresent ? "Home" : "Away"}`
                  : "Paused from all meal plans"}
              </p>
            </div>
            <DefaultPresenceButtons member={member} />
          </div>
        ))}
      </div>
    </section>
  );
}

function MemberPlanningStatus({
  member,
}: Readonly<{
  member: Route.ComponentProps["loaderData"]["members"][number];
}>) {
  const nextActive = !member.active;
  return (
    <section
      aria-labelledby={`planning-status-${member.id}`}
      className="grid gap-4 rounded-2xl border border-rule bg-paper-light p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
    >
      <div>
        <p className="eyebrow">Meal planning status</p>
        <h3 className="m-0 text-xl" id={`planning-status-${member.id}`}>
          {member.active
            ? `${member.displayName} is counted in meal plans`
            : `${member.displayName} is paused from meal plans`}
        </h3>
        <p className="mt-2 mb-0 max-w-2xl text-sm leading-6 text-muted">
          {member.active
            ? "Keep this on for anyone who may eat with the household. Use Usually away for occasional visits."
            : "Paused members are never counted, even on dates marked Home. Resume them before planning meals for them."}
        </p>
      </div>
      <Form method="post">
        <input name="intent" type="hidden" value="set-member-active" />
        <input name="memberId" type="hidden" value={member.id} />
        <input name="active" type="hidden" value={String(nextActive)} />
        <SubmitButton
          className={
            nextActive
              ? "button button-primary min-h-11"
              : "button button-quiet min-h-11 border border-rule"
          }
          pendingLabel={nextActive ? "Resuming" : "Pausing"}
          pendingMatch={{
            active: String(nextActive),
            intent: "set-member-active",
            memberId: member.id,
          }}
        >
          {nextActive ? (
            <PlayCircle aria-hidden="true" size={17} />
          ) : (
            <PauseCircle aria-hidden="true" size={17} />
          )}
          {nextActive ? "Resume meal planning" : "Pause from meal planning"}
        </SubmitButton>
      </Form>
    </section>
  );
}

function RuleList({
  member,
}: Readonly<{
  member: Route.ComponentProps["loaderData"]["members"][number];
}>) {
  return (
    <section aria-labelledby={`rules-${member.id}`}>
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Only when needed</p>
          <h3 className="m-0 text-2xl" id={`rules-${member.id}`}>
            Repeating schedule
          </h3>
        </div>
        <p className="m-0 text-xs font-semibold text-muted">
          One time date changes always win
        </p>
      </div>

      {member.rules.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-rule bg-white/35 p-4 text-sm text-muted">
          No repeating schedule. The usual{" "}
          {member.defaultIsPresent ? "Home" : "Away"} setting fills each date
          until you tap a day to change it.
        </div>
      ) : (
        <ol className="m-0 grid list-none gap-3 p-0">
          {member.rules.map((rule) => (
            <li
              className="rounded-2xl border border-rule bg-white/55 p-4"
              key={rule.id}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="m-0 flex items-center gap-2 text-sm font-bold">
                    {rule.effect === "present" ? (
                      <UserCheck
                        aria-hidden="true"
                        className="text-herb"
                        size={18}
                      />
                    ) : (
                      <UserMinus
                        aria-hidden="true"
                        className="text-clay"
                        size={18}
                      />
                    )}
                    {formatRuleSummary(rule)}
                  </p>
                  <p className="mt-2 mb-0 text-xs text-muted">
                    {formatRuleDates(rule)}
                  </p>
                  <details className="mt-3 text-xs text-muted">
                    <summary className="cursor-pointer font-semibold text-herb">
                      Technical details
                    </summary>
                    <code className="mt-2 block max-w-full overflow-x-auto rounded-lg bg-ink px-3 py-2 text-xs text-paper-light">
                      {rule.rrule} · order {rule.priority}
                    </code>
                  </details>
                </div>

                <Form method="post">
                  <input name="intent" type="hidden" value="delete-rule" />
                  <input name="ruleId" type="hidden" value={rule.id} />
                  <SubmitButton
                    className="button button-danger min-h-11"
                    pendingLabel="Deleting rule"
                    pendingMatch={{ intent: "delete-rule", ruleId: rule.id }}
                  >
                    <Trash2 aria-hidden="true" size={16} />
                    Delete rule
                  </SubmitButton>
                </Form>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function RuleBuilder({
  defaultDate,
  member,
}: Readonly<{
  defaultDate: string;
  member: Route.ComponentProps["loaderData"]["members"][number];
}>) {
  const prefix = `rule-${member.id}`;
  const suggestedPriority =
    Math.max(0, ...member.rules.map((rule) => rule.priority)) + 10;

  return (
    <details className="group rounded-2xl border border-rule bg-white/45">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 font-bold text-herb marker:hidden">
        <span className="inline-flex items-center gap-2">
          <CalendarRange aria-hidden="true" size={17} />
          Add repeating days
        </span>
        <ChevronDown
          aria-hidden="true"
          className="transition-transform group-open:rotate-180"
          size={18}
        />
      </summary>

      <Form className="grid gap-5 border-t border-rule p-4" method="post">
        <input name="intent" type="hidden" value="add-rule" />
        <input name="memberId" type="hidden" value={member.id} />
        <input name="priority" type="hidden" value={suggestedPriority} />

        <div className="flex items-start gap-3 rounded-xl border border-butter/45 bg-butter/12 p-4 text-sm leading-6 text-muted">
          <Info
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-clay"
            size={18}
          />
          <p className="m-0">
            Use this only for a dependable weekly pattern. A date you tap in the
            calendar above always takes precedence.
          </p>
        </div>

        <fieldset className="m-0 grid gap-2 border-0 p-0">
          <legend>On the selected days, mark {member.displayName} as</legend>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex min-h-11 items-center gap-3 rounded-xl border border-rule bg-paper-light px-3 py-2 font-semibold">
              <input
                className="h-5 w-5 accent-herb"
                defaultChecked={!member.defaultIsPresent}
                name="effect"
                required
                type="radio"
                value="present"
              />
              Home
            </label>
            <label className="flex min-h-11 items-center gap-3 rounded-xl border border-rule bg-paper-light px-3 py-2 font-semibold">
              <input
                className="h-5 w-5 accent-clay"
                defaultChecked={member.defaultIsPresent}
                name="effect"
                required
                type="radio"
                value="absent"
              />
              Away
            </label>
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="field sm:col-span-2" htmlFor={`${prefix}-interval`}>
            <span className="field-label">Repeat</span>
            <select
              className="select"
              defaultValue="1"
              id={`${prefix}-interval`}
              name="interval"
            >
              <option value="1">Every week</option>
              <option value="2">Every 2 weeks</option>
            </select>
          </label>
        </div>

        <fieldset className="m-0 grid gap-2 border-0 p-0">
          <legend>Weekdays</legend>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
            {weekdayOptions.map((weekday) => (
              <label
                className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-rule bg-paper-light px-2 py-2 text-sm font-bold"
                key={weekday.value}
              >
                <input
                  className="h-5 w-5 accent-herb"
                  name="weekday"
                  type="checkbox"
                  value={weekday.value}
                />
                {weekday.label}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="field" htmlFor={`${prefix}-from`}>
            <span className="field-label">Starts</span>
            <input
              className="input"
              defaultValue={defaultDate}
              id={`${prefix}-from`}
              name="effectiveFrom"
              required
              type="date"
            />
          </label>
          <label className="field" htmlFor={`${prefix}-to`}>
            <span className="field-label">Ends, optional</span>
            <input
              className="input"
              id={`${prefix}-to`}
              min={defaultDate}
              name="effectiveTo"
              type="date"
            />
          </label>
        </div>

        <div>
          <SubmitButton
            pendingLabel="Adding rule"
            pendingMatch={{ intent: "add-rule", memberId: member.id }}
          >
            Save repeating schedule
          </SubmitButton>
        </div>
      </Form>
    </details>
  );
}

function OverrideForms({
  defaultDate,
  memberId,
}: Readonly<{ defaultDate: string; memberId: string }>) {
  const prefix = `override-${memberId}`;

  return (
    <details className="group rounded-2xl border border-rule bg-white/45">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 font-bold text-herb marker:hidden">
        <span className="inline-flex items-center gap-2">
          <Home aria-hidden="true" size={17} />
          Change another date
        </span>
        <ChevronDown
          aria-hidden="true"
          className="transition-transform group-open:rotate-180"
          size={18}
        />
      </summary>

      <div className="grid gap-5 border-t border-rule p-4 lg:grid-cols-2">
        <Form className="grid content-start gap-4" method="post">
          <input name="intent" type="hidden" value="set-override" />
          <input name="memberId" type="hidden" value={memberId} />

          <label className="field" htmlFor={`${prefix}-date`}>
            <span className="field-label">Date</span>
            <input
              className="input"
              defaultValue={defaultDate}
              id={`${prefix}-date`}
              name="date"
              required
              type="date"
            />
          </label>

          <fieldset className="m-0 grid gap-2 border-0 p-0">
            <legend>Status for that date</legend>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex min-h-11 items-center gap-3 rounded-xl border border-rule bg-paper-light px-3 py-2 font-semibold">
                <input
                  className="h-5 w-5 accent-herb"
                  name="status"
                  required
                  type="radio"
                  value="present"
                />
                Home
              </label>
              <label className="flex min-h-11 items-center gap-3 rounded-xl border border-rule bg-paper-light px-3 py-2 font-semibold">
                <input
                  className="h-5 w-5 accent-clay"
                  name="status"
                  required
                  type="radio"
                  value="absent"
                />
                Away
              </label>
            </div>
          </fieldset>

          <label className="field" htmlFor={`${prefix}-note`}>
            <span className="field-label">Note, optional</span>
            <input
              className="input"
              id={`${prefix}-note`}
              maxLength={500}
              name="note"
              placeholder="Why this date is different"
            />
          </label>

          <div>
            <SubmitButton
              pendingLabel="Saving change"
              pendingMatch={{ intent: "set-override", memberId }}
            >
              Save one time change
            </SubmitButton>
          </div>
        </Form>

        <Form
          className="grid content-start gap-4 rounded-xl border border-dashed border-rule bg-paper-light p-4"
          method="post"
        >
          <input name="intent" type="hidden" value="clear-override" />
          <input name="memberId" type="hidden" value={memberId} />
          <div>
            <p className="m-0 font-bold">Return a date to its usual schedule</p>
            <p className="mt-1 mb-0 text-sm leading-6 text-muted">
              This removes the one time change. A repeating schedule applies
              when it matches. Otherwise, the usual setting applies.
            </p>
          </div>
          <label className="field" htmlFor={`${prefix}-clear-date`}>
            <span className="field-label">Date</span>
            <input
              className="input"
              defaultValue={defaultDate}
              id={`${prefix}-clear-date`}
              name="date"
              required
              type="date"
            />
          </label>
          <div>
            <SubmitButton
              className="button button-secondary min-h-11"
              pendingLabel="Restoring schedule"
              pendingMatch={{ intent: "clear-override", memberId }}
            >
              Use usual schedule
            </SubmitButton>
          </div>
        </Form>
      </div>
    </details>
  );
}

export default function PresencePage({
  actionData,
  loaderData,
}: Route.ComponentProps) {
  const activeCount = loaderData.members.filter(
    (member) => member.active,
  ).length;
  const visibleEnd = parseDateOnly(loaderData.previewStart)
    .add({ days: 6 })
    .toString();
  const dateRangeLabel = `${formatDateLabel(loaderData.previewStart, {
    month: "short",
    day: "numeric",
  })} through ${formatDateLabel(visibleEnd, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Link
            className="button button-secondary"
            to={`/?week=${loaderData.weekStart}`}
          >
            <ArrowLeft aria-hidden="true" size={17} />
            Return to week
          </Link>
        }
        description="Choose where each person usually is, then tap only the dates that change. Dinner servings update automatically."
        eyebrow="Household schedule"
        title="Who's eating this week?"
      />

      {actionData ? (
        actionData.ok ? (
          <div className="success-note" role="status">
            <UserCheck aria-hidden="true" size={18} />
            <span>{actionData.message}</span>
          </div>
        ) : (
          <FormError>{actionData.error}</FormError>
        )
      ) : null}

      {loaderData.members.length > 0 ? (
        <HouseholdDefaultsPanel members={loaderData.members} />
      ) : null}

      <section
        className="surface overflow-hidden"
        aria-labelledby="presence-how-it-works"
      >
        <div className="border-b border-rule bg-herb px-5 py-4 text-paper-light sm:px-6">
          <p className="mb-1 text-xs font-bold uppercase tracking-[0.14em] text-butter">
            Three simple layers
          </p>
          <h2
            className="m-0 text-2xl text-paper-light"
            id="presence-how-it-works"
          >
            Start broad, then handle exceptions
          </h2>
        </div>
        <div className="grid gap-px bg-rule sm:grid-cols-3">
          <div className="flex gap-3 bg-paper-light p-5">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-butter font-bold text-ink">
              1
            </span>
            <div>
              <p className="m-0 font-bold">Choose Usually home or away</p>
              <p className="mt-1 mb-0 text-sm leading-6 text-muted">
                This becomes the starting point for every date.
              </p>
            </div>
          </div>
          <div className="flex gap-3 bg-paper-light p-5">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-herb font-bold text-paper-light">
              2
            </span>
            <div>
              <p className="m-0 font-bold">Add repeating days when useful</p>
              <p className="mt-1 mb-0 text-sm leading-6 text-muted">
                Use these only for a dependable weekly pattern.
              </p>
            </div>
          </div>
          <div className="flex gap-3 bg-paper-light p-5">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-clay font-bold text-paper-light">
              3
            </span>
            <div>
              <p className="m-0 font-bold">Tap a date that is different</p>
              <p className="mt-1 mb-0 text-sm leading-6 text-muted">
                A one time date choice always wins.
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-rule bg-paper px-5 py-3 text-xs font-semibold text-muted sm:px-6">
          <p className="m-0">
            {activeCount} of {loaderData.members.length} members counted in meal
            plans
          </p>
          <p className="m-0">
            Showing {dateRangeLabel} · {loaderData.householdTimezone}
          </p>
        </div>
      </section>

      {loaderData.members.length === 0 ? (
        <section className="empty-state">
          <div>
            <h2>No household members yet</h2>
            <p>
              Add members in the household seed before setting presence rules.
            </p>
          </div>
        </section>
      ) : (
        <div className="grid gap-6">
          {loaderData.members.map((member) => {
            const upcoming = member.preview
              .filter((preview) => preview.date >= loaderData.previewStart)
              .slice(0, 7);

            return (
              <article className="surface overflow-hidden" key={member.id}>
                <header className="flex flex-wrap items-start justify-between gap-4 border-b border-rule bg-paper-light/80 p-5 sm:p-6">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-ink bg-butter/70">
                      <CircleUserRound aria-hidden="true" size={23} />
                    </span>
                    <div className="min-w-0">
                      <h2 className="m-0 truncate text-3xl">
                        {member.displayName}
                      </h2>
                      <p className="mt-1 mb-0 text-sm font-semibold text-muted">
                        {member.memberType === "adult" ? "Adult" : "Child"} with
                        appetite value {member.appetiteMultiplier.toFixed(2)}
                      </p>
                      <p
                        className={
                          member.active
                            ? "mt-2 mb-0 text-xs font-bold text-herb"
                            : "mt-2 mb-0 text-xs font-bold text-clay"
                        }
                      >
                        {member.active
                          ? "Counted in meal plans"
                          : "Paused from meal plans"}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <span
                      className={
                        member.defaultIsPresent
                          ? "rounded-full border border-herb/30 bg-herb/10 px-3 py-2 text-xs font-bold text-herb-dark"
                          : "rounded-full border border-clay/30 bg-clay/10 px-3 py-2 text-xs font-bold text-clay"
                      }
                    >
                      Usually {member.defaultIsPresent ? "Home" : "Away"}
                    </span>
                    <span className="rounded-full border border-rule bg-white px-3 py-2 text-xs font-bold">
                      {member.rules.length}{" "}
                      {member.rules.length === 1
                        ? "repeating schedule"
                        : "repeating schedules"}
                    </span>
                  </div>
                </header>

                <div className="grid gap-6 p-5 sm:p-6">
                  <section aria-labelledby={`preview-${member.id}`}>
                    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
                      <div>
                        <p className="eyebrow">
                          {loaderData.selectedWeek
                            ? "Selected week"
                            : "Next seven days"}
                        </p>
                        <h3
                          className="m-0 text-2xl"
                          id={`preview-${member.id}`}
                        >
                          Tap a day to change it
                        </h3>
                      </div>
                      <p className="m-0 text-xs font-semibold text-muted">
                        One time changes take precedence
                      </p>
                    </div>
                    <ol className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-4 lg:grid-cols-7">
                      {upcoming.map((preview) => (
                        <PresencePreviewTile
                          key={preview.date}
                          member={member}
                          preview={preview}
                        />
                      ))}
                    </ol>
                  </section>

                  <RuleList member={member} />

                  <div className="grid gap-3 xl:grid-cols-2">
                    <RuleBuilder
                      defaultDate={loaderData.previewStart}
                      member={member}
                    />
                    <OverrideForms
                      defaultDate={loaderData.previewStart}
                      memberId={member.id}
                    />
                  </div>

                  <div className="grid gap-3 xl:grid-cols-2">
                    <MemberEditor member={member} />
                    <MemberPlanningStatus member={member} />
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
