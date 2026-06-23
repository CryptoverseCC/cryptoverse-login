import { lazy } from "react";

// The main `App` is code-split so the landing screen ("Continue with a wallet")
// paints without paying for the full wallet UI bundle. We keep it lazy, but warm
// the chunk *before* the click so its download + eval overlaps the time the user
// spends reading the landing — the ~53ms post-click stall the benchmark found is
// dominated by fetching this chunk on demand.
//
// NOTE: the old `/* webpackPreload: true */` magic comment is a webpack-ism that
// Vite/Rollup ignore. Vite only auto-injects `<link rel="modulepreload">` for
// STATIC imports; turning this into a static import would defeat the code-split.
// So we warm it imperatively via `importApp()` below instead.
const importApp = () => import("../App");

export const App = lazy(importApp);

let warmed = false;

/**
 * Kick off the dynamic `import()` for the `App` chunk without rendering it, so it
 * is cached by the time the user clicks "Continue with a wallet". Idempotent and
 * safe to call on every mount. Uses `requestIdleCallback` so warming never
 * competes with the landing paint, with a `setTimeout` fallback for browsers
 * (Safari) that lack it. Errors are swallowed — `Suspense` will retry the import
 * on the real click and surface any failure there.
 */
export function warmApp(): void {
  if (warmed) return;
  warmed = true;

  const run = () => {
    importApp().catch(() => {
      // Allow a genuine retry on click if this speculative load failed.
      warmed = false;
    });
  };

  const ric = (
    globalThis as typeof globalThis & {
      requestIdleCallback?: (cb: () => void) => number;
    }
  ).requestIdleCallback;

  if (typeof ric === "function") {
    ric(run);
  } else {
    setTimeout(run, 200);
  }
}
