import * as Comlink from "comlink";
import {
  IProvider,
  TIdentitiesRequest,
  TIdentitiesResponse,
} from "../services/loginProvider";
import { Window, getIdentities } from "./utils";
import { init } from "./init";
import { login } from "./login";
import { connect } from "./connect";

// The embed is the TOP-WINDOW page (served by the wrapper's embed.html). It owns
// the wallet (a wallet provider must run top-level, not inside an iframe) and
// exposes init/connect/identities/login/redirect to the iframe over Comlink.
(window as unknown as Window).ready = new Promise<void>((resolve, reject) => {
  async function main() {
    try {
      const loginProvider: IProvider = {
        init,
        login,
        connect,
        identities: async (
          _request: TIdentitiesRequest
        ): Promise<TIdentitiesResponse> => {
          return { identities: getIdentities() };
        },
        redirect: (url) => window.location.assign(url),
      };

      const ifr = document.querySelector("#auth") as HTMLIFrameElement;

      ifr.onload = () => {
        Comlink.expose(loginProvider, Comlink.windowEndpoint(ifr.contentWindow!));
        const loader = document.getElementById("loader") as HTMLElement | null;
        if (loader) loader.style.display = "none";
      };

      ifr.onerror = (error) => {
        const sentry = (window as unknown as Window).Sentry;
        sentry?.captureException(error);
      };
    } catch (error) {
      reject(error);
      return;
    }
    resolve();
  }
  setTimeout(main, 0);
});
