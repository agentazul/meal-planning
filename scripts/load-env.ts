import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

export function loadLocalEnvironment(): void {
  for (const path of [".env.local", ".env"] as const) {
    if (existsSync(path)) {
      loadEnvFile(path);
    }
  }
}
