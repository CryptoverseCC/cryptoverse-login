import { signMessage } from "@wagmi/core";
import { getAddress } from "viem";
import {
  TInnerLoginRequest,
  TLoginResponse,
  TSiweParams,
} from "../services/loginProvider";
import { Window, getConfig } from "./utils";

// Assemble a canonical EIP-4361 (Sign-In with Ethereum) message. Both this and
// the backend's Rust `siwe` verifier implement EIP-4361, so they interoperate.
// The nonce is supplied by the backend, bound to the Hydra login challenge, so
// the signature can only be used for this one login flow.
function buildSiweMessage(address: string, p: TSiweParams): string {
  const checksummed = getAddress(address);
  const issuedAt = new Date();
  const expirationTime = new Date(
    issuedAt.getTime() + p.expirationMinutes * 60_000
  );
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

export const login = async ({
  address,
  siwe,
  challenge,
}: TInnerLoginRequest): Promise<TLoginResponse> => {
  const sentry = (window as unknown as Window).Sentry;
  const message = buildSiweMessage(address, siwe);

  try {
    // viem/wagmi sign EIP-191 personal_sign over the chosen connected account.
    // This is uniform across injected wallets, Coinbase, and WalletConnect; the
    // backend recovers and verifies the address (smart-contract wallets are
    // handled via EIP-1271 at verification time). No per-wallet branching.
    const signature = await signMessage(getConfig(), {
      account: getAddress(address),
      message,
    });
    return { message, signature, challenge, address };
  } catch (error) {
    console.error(error);
    sentry?.captureException(error);
    return null;
  }
};
