import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { ConnectWalletPage, Modes } from "../components/ConnectWalletPage";
import {
  wallets,
  walletMetaMask,
  walletBrowserFallback,
  walletsAfterDiscovery,
  restrictionWithMessage,
  restrictionsMultiple,
} from "./fixtures";

const meta: Meta<typeof ConnectWalletPage> = {
  title: "Pages/ConnectWalletPage",
  component: ConnectWalletPage,
  args: {
    origin: "demo.app",
    wallets,
    mode: Modes.SELECT,
    onConnect: fn(),
    switchMode: fn(),
  },
};
export default meta;

type Story = StoryObj<typeof ConnectWalletPage>;

// EIP-6963 + Coinbase + WalletConnect + an unbranded wallet (icon fallback).
export const MultipleWallets: Story = {};

export const SingleWallet: Story = { args: { wallets: [walletMetaMask] } };

// The list after a late EIP-6963 announcement (Rabby joins via the live
// `onWalletsChanged` push) — the post-discovery picker state.
export const AfterLateDiscovery: Story = {
  args: { wallets: walletsAfterDiscovery },
};

// No EIP-6963 wallet was discovered, so the generic injected() fallback surfaces
// as a single "Browser Wallet" tile (mobile dapp-browser WebViews, etc.).
export const BrowserWalletFallbackOnly: Story = {
  args: { wallets: [walletBrowserFallback] },
};

// Empty list → the "No wallet detected" guidance.
export const NoWalletsDetected: Story = { args: { wallets: [] } };

// A connect error surfaced as an Alert (e.g. the -32002 already-pending case).
export const WithError: Story = {
  args: {
    error: "A connection request is already pending — open your wallet to approve it.",
  },
};

export const WithRestrictions: Story = {
  args: { restrictions: restrictionWithMessage },
};

export const WithRestrictionsMultiple: Story = {
  args: { restrictions: restrictionsMultiple },
};

export const HelpMode: Story = { args: { mode: Modes.HELP } };

export const LongOrigin: Story = {
  args: { origin: "some.really-long-subdomain.example.com" },
};
