import { defineConfig } from "vitest/config";
import path from "path";

// Project-root vitest config. Keeps test discovery scoped to project root
// rather than inheriting vite.config.ts's `root: "client"` (which is for the
// Vite dev/build pipeline, not tests).
export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@": path.resolve(import.meta.dirname, "client", "src"),
    },
  },
  test: {
    include: ["{shared,server,client/src}/**/*.{test,spec}.{ts,tsx}"],
    environment: "node",
  },
});
