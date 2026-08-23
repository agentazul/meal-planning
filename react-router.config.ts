import type { Config } from "@react-router/dev/config";

const canonicalActionOrigins = ["dfy.kitchen", "www.dfy.kitchen"] as const;

export function resolveAllowedActionOrigins(
  appOrigin: string | undefined,
): string[] {
  const origins = new Set<string>(canonicalActionOrigins);

  if (appOrigin) {
    try {
      origins.add(new URL(appOrigin).host);
    } catch {
      // Runtime environment validation reports malformed APP_ORIGIN values.
    }
  }

  return [...origins];
}

export default {
  allowedActionOrigins: resolveAllowedActionOrigins(process.env.APP_ORIGIN),
  ssr: true,
} satisfies Config;
