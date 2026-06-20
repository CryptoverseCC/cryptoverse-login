import {
    TInnerLoginRequest, TLoginResponse, TSiweParams,
} from "../services/loginProvider";
import { getAddress } from "ethers";
import { signers } from "./signers";
import { Window } from "./utils";

// Assemble a canonical EIP-4361 (Sign-In with Ethereum) message. Both this and
// the backend's Rust `siwe` verifier implement EIP-4361, so they interoperate.
// The nonce is supplied by the backend, bound to the Hydra login challenge, so
// the signature can only be used for this one login flow.
function buildSiweMessage(address: string, p: TSiweParams): string {
    const checksummed = getAddress(address);
    const issuedAt = new Date();
    const expirationTime = new Date(issuedAt.getTime() + p.expirationMinutes * 60_000);
    return [
        `${p.domain} wants you to sign in with your Ethereum account:`,
        checksummed,
        "",
        p.statement,
        "",
        `URI: ${p.uri}`,
        `Version: ${p.version}`,
        `Chain ID: ${p.chainId}`,
        `Nonce: ${p.nonce}`,
        `Issued At: ${issuedAt.toISOString()}`,
        `Expiration Time: ${expirationTime.toISOString()}`,
    ].join("\n");
}

export const login = async ({ address, siwe, challenge }: TInnerLoginRequest): Promise<TLoginResponse> => {
    const getInjectedProvider = (await import(/* webpackMode: "eager", webpackPreload: true, webpackChunkName: "web3modal-gip" */ "web3modal")).getInjectedProvider;

    const sentry = (window as unknown as Window).Sentry;
    const message = buildSiweMessage(address, siwe);
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
        const name = pp.name.toLowerCase();
        signer = signers[name];
    } else {
        console.warn("No named signer");
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

    return {
        message,
        signature,
        challenge,
        address,
    };
};
