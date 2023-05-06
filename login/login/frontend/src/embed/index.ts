import * as Comlink from "comlink";
import {
  IProvider,
  TIdentitiesRequest,
  TIdentitiesResponse
} from "../services/loginProvider";
import { Window, getIdentities } from "./utils";

((window as unknown) as Window).ready = new Promise<void>((resolve, reject) => {
  async function main() {
    try {
      const loginProvider: IProvider = {
        init: (await import(/* webpackPreload: true */"./init")).init,
        login: (await import(/* webpackPreload: true */"./login")).login,
        connect: (await import(/* webpackPreload: true */"./connect")).connect,
        identities: async (request: TIdentitiesRequest): Promise<TIdentitiesResponse> => {
          return { identities: getIdentities() };
        },
        redirect: (url) => window.location.assign(url),
      };

      const ifr = document.querySelector("#auth") as HTMLIFrameElement;

      ifr.onload = () => {
        Comlink.expose(
          loginProvider,
          Comlink.windowEndpoint(ifr.contentWindow!)
        );
        let loader = document.getElementById("loader") as HTMLElement;
        loader.style.display = "none";
      };

      ifr.onerror = (error) => {
        const sentry = (window as unknown as Window).Sentry;
        sentry?.captureException(error); // TODO: wrap Sentry in some service eg. ErrorReporter
      }

    } catch (error) {
      reject(error);
    }
    resolve();
  }
  setTimeout(main, 0);
});
