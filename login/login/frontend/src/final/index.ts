import * as Comlink from "comlink";

interface Redirector {
  redirect(url: string): void;
}

// The `final` bundle is a dedicated Vite entry loaded ONLY by the wrapper's
// final.html, which sets `window.redirectUrl` in an inline script beforehand.
// It asks the top window (the embed, over Comlink) to perform the final
// redirect back to the relying party. The `if (url)` guard is defensive.
async function main() {
  const loginProvider = Comlink.wrap<Redirector>(
    Comlink.windowEndpoint(window.parent)
  );
  const url = (window as unknown as { redirectUrl?: string }).redirectUrl;
  if (url) {
    loginProvider.redirect(url);
  }
}

main();
