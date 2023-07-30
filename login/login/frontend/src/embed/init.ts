import { IProviderInfo } from "web3modal";
import {
  TInitRequest,
  TInitResponse,
} from "../services/loginProvider";
import { Window } from "./utils";

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

const retryOperation = (operation: Function, delay: number, retries: number) => new Promise((resolve, reject) => {
  return operation()
    .then(resolve)
    .catch((reason: Error) => {
      if (retries > 0) {
        return wait(delay)
          .then(retryOperation.bind(null, operation, delay, retries - 1))
          .then(resolve)
          .catch(reject);
      }
      return reject(reason);
    });
});


export const init = async (request: TInitRequest): Promise<TInitResponse> => {
  const getInjectedProvider = (await import(/* webpackMode: "eager", webpackPreload: true, webpackChunkName: "web3modal-gip" */ "web3modal")).getInjectedProvider;
  const sentry = (window as unknown as Window).Sentry;

  try {
    const providerPromise = retryOperation(async () => {
      const ret = getInjectedProvider();
      if (ret) {
        return ret;
      }
      throw Error("Missing Web3 provider");
    }, 1000, 3);
    const pp = (await providerPromise) as IProviderInfo;

    return {
      name: pp ? pp.name : null,
    }
  } catch (error) {
    sentry?.captureException(error); // TODO: wrap Sentry in some service eg. ErrorReporter
    return { name: null }
  }
};
