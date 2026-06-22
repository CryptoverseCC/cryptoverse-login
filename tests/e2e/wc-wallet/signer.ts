import { mnemonicToAccount, type HDAccount } from "viem/accounts";
import {
  hexToString,
  isHex,
  recoverMessageAddress,
  type Hex,
} from "viem";

/**
 * The pure signing core of the headless WalletConnect test wallet.
 *
 * No network, no WalletConnect, no browser — just "given a personal_sign RPC
 * params array, produce a signature with the seed key". Kept separate from the
 * WalletKit transport (`responder.ts`) precisely so it can be unit-tested in
 * pure Node (`signer.test.ts`).
 *
 * `personal_sign` params are `[message, address]` where `message` is either a
 * 0x-hex-encoded UTF-8 string (the EIP-4361/SIWE case wagmi sends) or a raw
 * string. We decode it, sign with viem's EIP-191 `signMessage`, and the IdP's
 * `core::auth::verify` recovers the same address.
 */
export class WalletConnectSigner {
  readonly account: HDAccount;

  constructor(mnemonic: string, addressIndex = 0) {
    this.account = mnemonicToAccount(mnemonic, { addressIndex });
  }

  /** Lowercased address of the active account (the OIDC subject). */
  get address(): string {
    return this.account.address.toLowerCase();
  }

  /**
   * Decode a `personal_sign` message param. wagmi/viem hex-encode the UTF-8
   * SIWE string; some wallets pass it raw. Returns the human-readable message.
   */
  static decodeMessage(param: string): string {
    return isHex(param) ? hexToString(param as Hex) : param;
  }

  /**
   * Sign a `personal_sign` request's `params` (`[message, address]`). Validates
   * that the requested signer matches our account when an address is supplied.
   * Returns the 0x signature.
   */
  async signPersonalSign(params: readonly unknown[]): Promise<Hex> {
    const [rawMessage, requestedAddress] = params as [string, string?];
    if (typeof rawMessage !== "string") {
      throw new Error("personal_sign: missing message param");
    }
    if (
      requestedAddress &&
      typeof requestedAddress === "string" &&
      requestedAddress.toLowerCase() !== this.address
    ) {
      throw new Error(
        `personal_sign: requested signer ${requestedAddress.toLowerCase()} != wallet ${this.address}`,
      );
    }
    const message = WalletConnectSigner.decodeMessage(rawMessage);
    return this.account.signMessage({ message });
  }

  /**
   * Recover the signer of a message+signature (used by the unit test to prove
   * the round-trip, mirroring what the Rust backend does).
   */
  static async recover(message: string, signature: Hex): Promise<string> {
    const addr = await recoverMessageAddress({ message, signature });
    return addr.toLowerCase();
  }
}
