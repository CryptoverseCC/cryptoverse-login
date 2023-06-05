import {
    TInnerLoginRequest, TLoginResponse,
} from "../services/loginProvider";
import { signers } from "./signers";
import { Window } from "./utils";


export const login = async ({ address, csrf, challenge }: TInnerLoginRequest): Promise<TLoginResponse> => {
    const getInjectedProvider = (await import(/* webpackPrefetch: true */ "web3modal")).getInjectedProvider;

    const sentry = (window as unknown as Window).Sentry;
    let message = `Cryptoverse Login - auth.cryptoverse.cc|${csrf}|${challenge}`;
    let signer;

    const pp = getInjectedProvider();

    sentry.onLoad(() => sentry?.setContext("provider", {
        name: pp?.name,
        id: pp?.id,
    }));

    sentry.onLoad(() => sentry?.setContext("user", {
        address
    }));

    if (pp) {
        console.log(pp);
        console.log(signers);
        const name = pp.name.toLowerCase();
        console.log(name);
        signer = signers[name];
        console.log(signer);
    } else {
        console.warn("No named signeer")
    }

    if (!signer) {
        signer = signers.default;
    }

    signer = signer();

    let signature;

    try {
        signature = await signer.sign(message, address)
    } catch (error) {
        console.error(error);
        sentry?.captureException(error); // TODO: wrap Sentry in some service eg. ErrorReporter
        return null;
    }


    try {
        await signer.verify(signature, message, address);
    } catch (error) {
        sentry?.captureException(error); // TODO: wrap Sentry in some service eg. ErrorReporter
        return null;
    }

    try {
        return {
            signature,
            csrf,
            challenge,
            address,
        };
    } catch (error) {
        sentry?.captureException(error); // TODO: wrap Sentry in some service eg. ErrorReporter
        return null;
    }
};
