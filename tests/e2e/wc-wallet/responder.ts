import { Core } from "@walletconnect/core";
import { WalletKit, type WalletKitTypes } from "@reown/walletkit";
import { buildApprovedNamespaces, getSdkError } from "@walletconnect/utils";
import { WalletConnectSigner } from "./signer.js";

/**
 * A headless WalletConnect "test wallet".
 *
 * It is the wallet side of a WalletConnect session: pair with a `wc:` URI
 * scraped from the IdP's QR modal, auto-approve the session proposal for the
 * seed account, and auto-sign any `personal_sign` (the SIWE message) with the
 * seed key via {@link WalletConnectSigner}. No browser, no extension — this is
 * exactly the headless desktop-QR automation the campaign asked for.
 *
 * The transport (WalletKit) is wired here; the signing logic lives in the
 * pure, unit-tested {@link WalletConnectSigner}.
 */

export interface WcWalletOptions {
  /** Reown Cloud / WalletConnect project id. Required by WalletKit. */
  projectId: string;
  /** BIP-39 mnemonic to derive the signing key from. */
  mnemonic: string;
  /** Account index on m/44'/60'/0'/0/<index>. Default 0. */
  addressIndex?: number;
  /**
   * eip155 chain ids the wallet advertises. The IdP only uses mainnet, but we
   * advertise the proposal's required + optional chains so namespace building
   * never rejects. Default ["eip155:1"].
   */
  chains?: string[];
}

const WALLET_METADATA = {
  name: "Cryptoverse E2E Test Wallet",
  description: "Headless WalletConnect test wallet for the Cryptoverse Login e2e suite",
  url: "https://github.com/cryptoverse/login",
  icons: [],
};

export class WalletConnectTestWallet {
  private walletKit?: Awaited<ReturnType<typeof WalletKit.init>>;
  private readonly signer: WalletConnectSigner;
  private readonly projectId: string;
  private readonly chains: string[];
  /** Resolves once a session has been approved (handy for tests/sequencing). */
  private sessionApproved!: Promise<void>;
  private resolveSessionApproved!: () => void;

  constructor(opts: WcWalletOptions) {
    this.projectId = opts.projectId;
    this.chains = opts.chains ?? ["eip155:1"];
    this.signer = new WalletConnectSigner(opts.mnemonic, opts.addressIndex ?? 0);
  }

  get address(): string {
    return this.signer.address;
  }

  /** Initialise WalletKit and wire the proposal + request auto-handlers. */
  async init(): Promise<void> {
    const core = new Core({ projectId: this.projectId });
    this.walletKit = await WalletKit.init({ core, metadata: WALLET_METADATA });

    this.sessionApproved = new Promise<void>((resolve) => {
      this.resolveSessionApproved = resolve;
    });

    this.walletKit.on(
      "session_proposal",
      (proposal: WalletKitTypes.SessionProposal) =>
        void this.onSessionProposal(proposal),
    );
    this.walletKit.on(
      "session_request",
      (request: WalletKitTypes.SessionRequest) =>
        void this.onSessionRequest(request),
    );
  }

  /** Pair with a dapp's `wc:` URI (scraped from the IdP's QR modal). */
  async pair(uri: string): Promise<void> {
    if (!this.walletKit) throw new Error("call init() before pair()");
    await this.walletKit.pair({ uri });
  }

  /** Await the first approved session (post-pair). */
  waitForSession(): Promise<void> {
    return this.sessionApproved;
  }

  /** Tear down the underlying core (close relay sockets). */
  async close(): Promise<void> {
    // WalletKit/Core has no single dispose; closing the relay transport stops
    // the open handles so a Node process / test worker can exit cleanly.
    const core = (
      this.walletKit as unknown as { core?: { relayer?: { transportClose?: () => Promise<void> } } }
    )?.core;
    await core?.relayer?.transportClose?.().catch(() => {});
  }

  /**
   * Auto-approve a session proposal: advertise our single account on every
   * requested eip155 chain, with personal_sign + the basic methods/events.
   * Exposed (not private) so a test can drive it with a synthetic proposal.
   */
  async onSessionProposal(
    proposal: WalletKitTypes.SessionProposal,
  ): Promise<void> {
    if (!this.walletKit) throw new Error("not initialised");
    const { id, params } = proposal;
    try {
      const supportedNamespaces = this.buildSupportedNamespaces(params);
      const approvedNamespaces = buildApprovedNamespaces({
        proposal: params,
        supportedNamespaces,
      });
      await this.walletKit.approveSession({ id, namespaces: approvedNamespaces });
      this.resolveSessionApproved();
    } catch (error) {
      await this.walletKit.rejectSession({
        id,
        reason: getSdkError("USER_REJECTED"),
      });
      throw error;
    }
  }

  /**
   * Auto-respond to a session request. Handles `personal_sign` (the SIWE flow);
   * rejects anything else with a JSON-RPC error. Exposed for unit driving.
   */
  async onSessionRequest(
    event: WalletKitTypes.SessionRequest,
  ): Promise<void> {
    if (!this.walletKit) throw new Error("not initialised");
    const { topic, params, id } = event;
    const { request } = params;

    if (request.method !== "personal_sign") {
      await this.walletKit.respondSessionRequest({
        topic,
        response: {
          id,
          jsonrpc: "2.0",
          error: { code: 5101, message: `Unsupported method: ${request.method}` },
        },
      });
      return;
    }

    try {
      const signature = await this.signer.signPersonalSign(request.params);
      await this.walletKit.respondSessionRequest({
        topic,
        response: { id, jsonrpc: "2.0", result: signature },
      });
    } catch (error) {
      await this.walletKit.respondSessionRequest({
        topic,
        response: {
          id,
          jsonrpc: "2.0",
          error: { code: 5000, message: (error as Error).message },
        },
      });
      throw error;
    }
  }

  /**
   * Build the `supportedNamespaces` map for `buildApprovedNamespaces`. Merges
   * the proposal's required + optional eip155 chains with our advertised ones so
   * the dapp's mandatory chains are always covered (else buildApprovedNamespaces
   * throws). Pure: exposed for the unit test.
   */
  buildSupportedNamespaces(
    params: WalletKitTypes.SessionProposal["params"],
  ): Parameters<typeof buildApprovedNamespaces>[0]["supportedNamespaces"] {
    const required = params.requiredNamespaces?.eip155?.chains ?? [];
    const optional = params.optionalNamespaces?.eip155?.chains ?? [];
    const chains = Array.from(
      new Set<string>([...this.chains, ...required, ...optional]),
    );
    const accounts = chains.map((chain) => `${chain}:${this.address}`);
    return {
      eip155: {
        chains,
        methods: [
          "personal_sign",
          "eth_sign",
          "eth_sendTransaction",
          "eth_signTypedData",
          "eth_signTypedData_v4",
        ],
        events: ["accountsChanged", "chainChanged"],
        accounts,
      },
    };
  }
}
