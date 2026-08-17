export function weeklyGenerationInvalidOutputMessage(
  phase: "candidates" | "instructions",
  validationIssues: readonly string[] = [],
): string {
  if (phase === "instructions") {
    return "We could not finish writing every recipe in this attempt. Try again.";
  }

  const hasIssueWithPrefix = (prefixes: readonly string[]) =>
    validationIssues.some((issue) =>
      prefixes.some((prefix) => issue.startsWith(prefix)),
    );

  if (
    hasIssueWithPrefix(["MISSING_OUTPUT", "INCOMPLETE_OUTPUT", "SCHEMA_MISMATCH"])
  ) {
    return "The dinner generator did not finish this attempt, so nothing was saved. Try building the week again.";
  }

  if (
    hasIssueWithPrefix([
      "DUPLICATE_TITLE",
      "DUPLICATE_CANDIDATE_TITLE",
      "RECENT_MEAL_REPEAT",
      "SIMILAR_CANDIDATE",
      "SIMILAR_CANDIDATE_POOL",
      "RESERVED_MEAL_REPEAT",
    ])
  ) {
    return "We could not create a complete set of distinct dinners in this attempt. Try building the week again.";
  }

  return "The dinner options did not pass our recipe checks, so nothing was saved. Try building the week again.";
}
