import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const serverEnvSchema = z
  .object({
    APP_ORIGIN: z.url(),
    DATABASE_URL: z.string().min(1),
    DATABASE_DIRECT_URL: z.string().min(1).optional(),
    MAGIC_LINK_DELIVERY: z.enum(["console", "smtp"]).default("console"),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    RESEND_API_KEY: z.string().min(1).optional(),
    SESSION_COOKIE_SECRET: z.string().min(32),
    SMTP_FROM: z.string().min(3).optional(),
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_SECURE: booleanFromString,
    SMTP_USER: z.string().optional(),
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV === "production" && env.MAGIC_LINK_DELIVERY !== "smtp") {
      context.addIssue({
        code: "custom",
        message: "Production requires MAGIC_LINK_DELIVERY=smtp",
        path: ["MAGIC_LINK_DELIVERY"],
      });
    }

    if (env.MAGIC_LINK_DELIVERY === "smtp" && (!env.SMTP_HOST || !env.SMTP_FROM)) {
      context.addIssue({
        code: "custom",
        message: "SMTP_HOST and SMTP_FROM are required for SMTP delivery",
        path: ["SMTP_HOST"],
      });
    }

    if (
      env.MAGIC_LINK_DELIVERY === "smtp" &&
      (!env.SMTP_USER || (!env.SMTP_PASSWORD && !env.RESEND_API_KEY))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "SMTP_USER and either SMTP_PASSWORD or RESEND_API_KEY are required for SMTP delivery",
        path: ["SMTP_USER"],
      });
    }

    if (env.NODE_ENV === "production" && !env.APP_ORIGIN.startsWith("https://")) {
      context.addIssue({
        code: "custom",
        message: "Production APP_ORIGIN must use HTTPS",
        path: ["APP_ORIGIN"],
      });
    }

    if (
      env.NODE_ENV === "production" &&
      env.SESSION_COOKIE_SECRET.startsWith("replace-with")
    ) {
      context.addIssue({
        code: "custom",
        message: "Production requires a unique SESSION_COOKIE_SECRET",
        path: ["SESSION_COOKIE_SECRET"],
      });
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cachedEnv: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const parsed = serverEnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = z.prettifyError(parsed.error);
    throw new Error(`Invalid server environment:\n${details}`);
  }

  cachedEnv = parsed.data;
  return cachedEnv;
}
