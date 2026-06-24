import { describe, it, expect } from "vitest";
import { stringToHex } from "viem";
import { WalletConnectSigner } from "./signer.js";
import { WalletConnectTestWallet } from "./responder.js";
import { ACCOUNT_ADDRESS, SEED_PHRASE } from "../fixtures/wallet.js";

/**
 * Pure-Node unit tests for the headless WalletConnect test wallet.
 *
 * No browser, no WalletConnect relay, no cluster — exercises the signing core
 * and the namespace-building logic directly. This is the "independently
 * unit-testable" guarantee the campaign required: `yarn test:unit`.
 */

const A_SIWE_MESSAGE = [
  "login.cv.127.0.0.1.nip.io wants you to sign in with your Ethereum account:",
  ACCOUNT_ADDRESS,
  "",
  "Sign in to the demo relying party.",
  "",
  "URI: https://login.cv.127.0.0.1.nip.io:9443",
  "Version: 1",
  "Chain ID: 1",
  "Nonce: 0123456789abcdef",
  "Issued At: 2026-06-22T00:00:00.000Z",
].join("\n");

describe("WalletConnectSigner", () => {
  it("derives the seed's account-0 address (parity with test_full.py)", () => {
    const signer = new WalletConnectSigner(SEED_PHRASE);
    expect(signer.address).toBe(ACCOUNT_ADDRESS);
  });

  it("decodes a hex-encoded personal_sign message back to UTF-8", () => {
    const hex = stringToHex(A_SIWE_MESSAGE);
    expect(WalletConnectSigner.decodeMessage(hex)).toBe(A_SIWE_MESSAGE);
  });

  it("passes through a raw (non-hex) message unchanged", () => {
    expect(WalletConnectSigner.decodeMessage(A_SIWE_MESSAGE)).toBe(
      A_SIWE_MESSAGE,
    );
  });

  it("signs a hex-encoded personal_sign and the signature recovers to the account", async () => {
    const signer = new WalletConnectSigner(SEED_PHRASE);
    const params = [stringToHex(A_SIWE_MESSAGE), ACCOUNT_ADDRESS] as const;

    const signature = await signer.signPersonalSign(params);
    expect(signature).toMatch(/^0x[0-9a-f]+$/i);

    // The recovered signer must equal the wallet account — exactly what the
    // Rust backend's core::auth::verify checks (EIP-191).
    const recovered = await WalletConnectSigner.recover(
      A_SIWE_MESSAGE,
      signature,
    );
    expect(recovered).toBe(ACCOUNT_ADDRESS);
  });

  it("signs a raw (non-hex) personal_sign too", async () => {
    const signer = new WalletConnectSigner(SEED_PHRASE);
    const signature = await signer.signPersonalSign([
      A_SIWE_MESSAGE,
      ACCOUNT_ADDRESS,
    ]);
    const recovered = await WalletConnectSigner.recover(
      A_SIWE_MESSAGE,
      signature,
    );
    expect(recovered).toBe(ACCOUNT_ADDRESS);
  });

  it("rejects a personal_sign that requests a different signer", async () => {
    const signer = new WalletConnectSigner(SEED_PHRASE);
    await expect(
      signer.signPersonalSign([
        stringToHex(A_SIWE_MESSAGE),
        "0x000000000000000000000000000000000000dead",
      ]),
    ).rejects.toThrow(/requested signer/);
  });

  it("rejects a personal_sign with no message", async () => {
    const signer = new WalletConnectSigner(SEED_PHRASE);
    await expect(signer.signPersonalSign([])).rejects.toThrow(
      /missing message/,
    );
  });

  it("derives a different address for a non-zero account index", () => {
    const a0 = new WalletConnectSigner(SEED_PHRASE, 0).address;
    const a1 = new WalletConnectSigner(SEED_PHRASE, 1).address;
    expect(a1).not.toBe(a0);
    expect(a1).toMatch(/^0x[0-9a-f]{40}$/);
  });
});

describe("WalletConnectTestWallet namespace building", () => {
  // Construct the wallet WITHOUT init() — we only exercise the pure
  // buildSupportedNamespaces logic, which needs no relay/projectId network.
  const wallet = new WalletConnectTestWallet({
    projectId: "test-project-id",
    mnemonic: SEED_PHRASE,
  });

  it("advertises personal_sign + the account on the required chains", () => {
    const params = {
      requiredNamespaces: {
        eip155: {
          chains: ["eip155:1"],
          methods: ["personal_sign"],
          events: ["chainChanged"],
        },
      },
      optionalNamespaces: {},
    } as unknown as Parameters<typeof wallet.buildSupportedNamespaces>[0];

    const ns = wallet.buildSupportedNamespaces(params);
    expect(ns.eip155.chains).toContain("eip155:1");
    expect(ns.eip155.methods).toContain("personal_sign");
    expect(ns.eip155.accounts).toContain(`eip155:1:${ACCOUNT_ADDRESS}`);
  });

  it("merges the proposal's optional chains so namespace building can't miss one", () => {
    const params = {
      requiredNamespaces: {
        eip155: { chains: ["eip155:1"], methods: ["personal_sign"], events: [] },
      },
      optionalNamespaces: {
        eip155: { chains: ["eip155:137"], methods: [], events: [] },
      },
    } as unknown as Parameters<typeof wallet.buildSupportedNamespaces>[0];

    const ns = wallet.buildSupportedNamespaces(params);
    expect(ns.eip155.chains).toEqual(
      expect.arrayContaining(["eip155:1", "eip155:137"]),
    );
    expect(ns.eip155.accounts).toEqual(
      expect.arrayContaining([
        `eip155:1:${ACCOUNT_ADDRESS}`,
        `eip155:137:${ACCOUNT_ADDRESS}`,
      ]),
    );
  });

  it("exposes the seed account address", () => {
    expect(wallet.address).toBe(ACCOUNT_ADDRESS);
  });
});
