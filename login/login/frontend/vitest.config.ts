import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Dedicated test config (kept separate from the app's vite.config.ts so the
// multi-entry build options don't leak into the test run).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/setupTests.ts"],
    css: false,
    exclude: ["node_modules", "build", "storybook-static"],
  },
});
