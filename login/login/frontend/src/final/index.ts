import * as Comlink from "comlink";

interface Redirector {
  redirect(url: string): void
}

async function main() {
  let loginProvider = Comlink.wrap<Redirector>(Comlink.windowEndpoint(window.parent));
  let url = (window as any).redirectUrl as string;
  // TODO: fix, this file is included in main index.html by mistake and causing redirectwith undefined url
  if (url) {
    loginProvider.redirect(url);
  }

}
main();
