import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

const defaultEnvironmentPaths = [".env.local", ".env"] as const;

export function loadLocalEnvironment(
  paths: readonly string[] = defaultEnvironmentPaths,
): void {
  for (const path of paths) {
    if (existsSync(path)) {
      loadEnvFile(path);
    }
  }
}
