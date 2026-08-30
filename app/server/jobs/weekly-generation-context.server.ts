import { parseDateOnly } from "~/domain/dates";
import { resolvePresence } from "~/domain/presence";
import { weeklyGenerationInvalidOutputMessage } from "~/domain/weekly-generation-error-copy";
import {
  buildDefaultWeeklyGenerationSlots,
  buildWeeklyGenerationCatalog,
  normalizeWeeklyGenerationDietaryNotes,
  WeeklyGenerationValidationError,
  type WeeklyGenerationCatalogEntry,
} from "~/domain/weekly-generation";
import { WeeklyPlanGenerationError } from "~/server/ai/weekly-plan-generation.server";
import type { ScopedDatabase } from "~/server/context.server";
import { listPresenceMembers } from "~/server/data/presence.server";
import { getHouseholdKitchenPreferences } from "~/server/data/preferences.server";
import { listIngredientReferences } from "~/server/data/recipes.server";
import {
  fingerprintKitchenPreferences,
  fingerprintWeeklyGenerationCatalog,
  fingerprintWeeklyGenerationDietaryNotes,
  listRecentCookedRecipeSummaries,
  WeeklyGenerationBuildStaleError,
  WeeklyGenerationRunError,
  type WeeklyGenerationRun,
} from "~/server/data/weekly-generation.server";
import { getWeekPlannerData } from "~/server/data/week.server";

export const weeklyPresenceRequirementMessage =
  "Choose at least five dinner nights with someone Home before building a weekly draft.";

export function createWeeklyGenerationCatalog(
  references: Awaited<ReturnType<typeof listIngredientReferences>>,
): readonly WeeklyGenerationCatalogEntry[] {
  return buildWeeklyGenerationCatalog(
    references.map((ingredient) => ({
      baseUnit: ingredient.baseUnit,
      category: ingredient.category,
      densityGramsPerMl: ingredient.densityGramsPerMl,
      gramsPerCount: ingredient.gramsPerCount,
      id: ingredient.id,
      isStaple: ingredient.isStaple,
      name: ingredient.name,
    })),
  );
}

export function anonymousWeeklyGenerationDietaryNotes(
  members: Awaited<ReturnType<typeof listPresenceMembers>>,
  slotDates: readonly string[],
): readonly string[] {
  return normalizeWeeklyGenerationDietaryNotes(
    members.flatMap((member) => {
      if (member.dietaryNotes === null) return [];
      const joinsAtLeastOneDinner = slotDates.some(
        (date) =>
          resolvePresence({
            date,
            defaultIsPresent: member.defaultIsPresent,
            overrides: member.overrides,
            rules: member.rules,
          }).isPresent,
      );
      return joinsAtLeastOneDinner ? [member.dietaryNotes] : [];
    }),
  );
}

export async function loadWeeklyGenerationContext(
  scoped: ScopedDatabase,
  weekStart: string,
) {
  const weekEnd = parseDateOnly(weekStart).add({ days: 6 }).toString();
  const [week, preferences, references, members, recentHistory] =
    await Promise.all([
      getWeekPlannerData(scoped, weekStart),
      getHouseholdKitchenPreferences(scoped),
      listIngredientReferences(scoped),
      listPresenceMembers(scoped, { from: weekStart, to: weekEnd }),
      listRecentCookedRecipeSummaries(scoped, weekStart),
    ]);
  const slots = buildDefaultWeeklyGenerationSlots(
    week.days.map((day) => ({
      date: day.date,
      demand: day.demand,
      servingsTarget: day.servingsTarget,
    })),
  );

  return {
    catalog: createWeeklyGenerationCatalog(references),
    dietaryNotes: anonymousWeeklyGenerationDietaryNotes(
      members,
      slots.map((slot) => slot.date),
    ),
    preferences,
    recentHistory,
    slots,
    week,
  };
}

function weeklyGenerationSlotsMatch(
  left: WeeklyGenerationRun["slots"],
  right: WeeklyGenerationRun["slots"],
): boolean {
  return (
    left.length === right.length &&
    left.every((slot, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        slot.date === other.date &&
        slot.effortTier === other.effortTier &&
        slot.maxActiveTimeMinutes === other.maxActiveTimeMinutes &&
        slot.servingsTarget === other.servingsTarget &&
        slot.slotKey === other.slotKey
      );
    })
  );
}

export function weeklyGenerationInputsMatch(
  run: WeeklyGenerationRun,
  input: Readonly<{
    catalog: readonly WeeklyGenerationCatalogEntry[];
    dietaryNotes: readonly string[];
    preferenceMarkdown: string;
    slots: WeeklyGenerationRun["slots"];
  }>,
): boolean {
  return (
    fingerprintWeeklyGenerationCatalog(input.catalog) ===
      run.catalogFingerprint &&
    fingerprintWeeklyGenerationDietaryNotes(input.dietaryNotes) ===
      run.dietaryNotesFingerprint &&
    fingerprintKitchenPreferences(input.preferenceMarkdown) ===
      run.preferenceFingerprint &&
    weeklyGenerationSlotsMatch(run.slots, input.slots)
  );
}

export function weeklyGenerationFailureReason(
  error: unknown,
): "configuration" | "provider" | "timeout" | "validation" | "unknown" {
  if (error instanceof WeeklyGenerationValidationError) return "validation";
  if (error instanceof WeeklyPlanGenerationError) {
    if (
      error.code === "invalid_input" ||
      error.code === "invalid_model_output"
    ) {
      return "validation";
    }
    if (error.code === "request_cancelled") return "timeout";
    return "provider";
  }
  if (
    error instanceof Error &&
    (error.message.startsWith("Invalid server environment:") ||
      error.message === "Google Vertex AI credentials are not configured.")
  ) {
    return "configuration";
  }
  return "unknown";
}

export function weeklyGenerationFailureAudit(error: unknown) {
  return error instanceof WeeklyPlanGenerationError
    ? {
        attemptCount: error.attemptCount,
        batch: error.batch,
        code: error.code,
        phase: error.phase,
        providerFailureCode: error.providerFailureCode,
        validationIssues: error.validationIssues,
      }
    : {};
}

export function weeklyGenerationErrorMessage(error: unknown): string {
  if (error instanceof WeeklyPlanGenerationError) {
    if (error.code === "request_cancelled") {
      return "Weekly generation was interrupted. Try again when you are ready.";
    }
    if (error.code === "invalid_model_output") {
      return weeklyGenerationInvalidOutputMessage(
        error.phase,
        error.validationIssues,
      );
    }
    return error.message;
  }
  if (error instanceof WeeklyGenerationValidationError) {
    if (error.code === "INVALID_SLOTS") {
      return weeklyPresenceRequirementMessage;
    }
    return "The AI draft did not pass the recipe safety checks. Try generating the week again.";
  }
  if (error instanceof WeeklyGenerationBuildStaleError) {
    return "The active build changed before this draft could be published. Refresh to see the latest draft, then try again if needed.";
  }
  if (error instanceof WeeklyGenerationRunError) return error.message;
  if (weeklyGenerationFailureReason(error) === "configuration") {
    return "Weekly generation is not configured yet. Try again after the kitchen connection is restored.";
  }
  return "Weekly generation is temporarily unavailable. Try again.";
}

export function shouldRetryWeeklyGenerationError(error: unknown): boolean {
  return (
    error instanceof WeeklyPlanGenerationError &&
    error.retryable &&
    (error.code === "request_cancelled" || error.code === "request_failed")
  );
}
