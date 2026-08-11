export function weeklyGenerationInvalidOutputMessage(
  phase: "candidates" | "instructions",
): string {
  return phase === "candidates"
    ? "We could not create a complete set of distinct dinners in this attempt. Try building the week again."
    : "We could not finish writing every recipe in this attempt. Try again.";
}
