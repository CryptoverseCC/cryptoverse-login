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

// True when the wallet reported a user-initiated rejection of the signature
// prompt (EIP-1193 4001 / viem `UserRejectedRequestError`). Only these map to the
// benign "cancelled" state — any other failure is a real error we surface.
function isUserRejection(error: unknown): boolean {
  const e = error as {
    code?: number;
    name?: string;
    cause?: { code?: number; name?: string };
  };
  const code = e?.code ?? e?.cause?.code;
  const name = e?.name ?? e?.cause?.name;
  return code === 4001 || name === "UserRejectedRequestError";
}

// A human-readable message for a genuine (non-rejection) signing failure.
function humanizeSignError(error: unknown): string {
  const e = error as { shortMessage?: string; message?: string };
  return (
    e?.shortMessage ||
    e?.message ||
    "Couldn't get the signature from your wallet. Please try again."
  );
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
    return { ok: true, message, signature, challenge, address };
  } catch (error) {
    console.error(error);
    if (isUserRejection(error)) {
      // Benign: the user dismissed the prompt. No Sentry noise.
      return { ok: false, cancelled: true, error: "Signing was cancelled." };
    }
    // A real failure (locked wallet, connector/RPC error). Report + surface it.
    sentry?.captureException(error);
    return { ok: false, cancelled: false, error: humanizeSignError(error) };
  }
};
