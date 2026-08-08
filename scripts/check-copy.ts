import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const roots = ["app", "docs", "scripts", "README.md", ".env.example"];
const textExtensions = new Set([".css", ".md", ".ts", ".tsx"]);
const prohibited = /[\u2013\u2014]/u;
const violations: string[] = [];

async function inspect(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null);

  if (entries) {
    await Promise.all(
      entries.map((entry) => inspect(join(path, entry.name))),
    );
    return;
  }

  if (!textExtensions.has(extname(path)) && !path.endsWith(".env.example")) {
    return;
  }

  const content = await readFile(path, "utf8");
  const lines = content.split("\n");

  for (const [index, line] of lines.entries()) {
    if (prohibited.test(line)) {
      violations.push(`${relative(process.cwd(), path)}:${index + 1}`);
    }
  }
}

await Promise.all(roots.map(inspect));

if (violations.length > 0) {
  throw new Error(
    `Prohibited long dash characters found at:\n${violations.join("\n")}`,
  );
}

console.info("Copy check passed with no en dash or em dash characters.");
