import { realpathSync } from "node:fs";

import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, searchForWorkspaceRoot } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    fs: {
      allow: [
        searchForWorkspaceRoot(process.cwd()),
        realpathSync("node_modules"),
      ],
    },
  },
});
