import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The SPA is served under the `/login` URL prefix (the Rust login backend and
// the gateway route it there), so every asset URL is prefixed accordingly.
//
// Three entry bundles are emitted, mirroring the previous CRACO/webpack setup:
//   - main  → the React app, loaded by the dynamic index.html template
//   - embed → the top-window wallet owner, loaded by the wrapper's embed.html
//   - final → the redirect completer, loaded by the wrapper's final.html
// `embed.js` and `final.js` MUST keep those exact, UNHASHED names: the wrapper
// templates hardcode /login/static/js/{embed,final}.js. The main bundle stays
// content-hashed (it's referenced from the build-emitted index.html).
export default defineConfig({
  base: "/login/",
  plugins: [react()],
  build: {
    outDir: "build",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: "index.html",
        embed: "src/embed/index.ts",
        final: "src/final/index.ts",
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "embed" || chunk.name === "final"
            ? "static/js/[name].js"
            : "static/js/[name].[hash].js",
        chunkFileNames: "static/js/[name].[hash].js",
        assetFileNames: "static/assets/[name].[hash][extname]",
      },
    },
  },
});
