import type { Meta, StoryObj } from "@storybook/react";
import App from "../App";
import { makeMockLoginProvider } from "./mockLoginProvider";

const meta: Meta<typeof App> = {
  title: "App/App",
  component: App,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof App>;

// Full flow against a canned provider: lands on the wallet picker after init.
export const Default: Story = {
  args: { loginProvider: makeMockLoginProvider() },
};

// The live wallet-list-update path: init returns the initial snapshot, then the
// mock fires the `onWalletsChanged` callback to mimic an EIP-6963 wallet (Rabby)
// announcing late — the picker re-renders with the expanded list. The default
// mock already drives this whenever a callback is supplied (which App does), so
// this is just the explicit story for the post-discovery state.
export const WalletListUpdatesAfterDiscovery: Story = {
  args: { loginProvider: makeMockLoginProvider() },
};

// init never resolves → the neutral loading (StatusView "loading") state.
export const Loading: Story = {
  args: {
    loginProvider: makeMockLoginProvider({ init: () => new Promise(() => {}) }),
  },
};

// init returns no wallets → the "no wallet detected" guidance.
export const NoWallets: Story = {
  args: {
    loginProvider: makeMockLoginProvider({
      init: async () => ({ wallets: [] }),
    }),
  },
};

// init rejects → the terminal error surface with a Try again action.
export const InitFailed: Story = {
  args: {
    loginProvider: makeMockLoginProvider({
      init: async () => {
        throw new Error("init failed");
      },
    }),
  },
};

// A rejected connect surfaces a recoverable inline error on the wallet picker.
export const ConnectRejected: Story = {
  args: {
    loginProvider: makeMockLoginProvider({
      connect: async () => ({
        identities: [],
        error: "Connection request rejected in your wallet.",
      }),
    }),
  },
};

// A connect that throws dead-ends into the terminal error surface.
export const ConnectFailed: Story = {
  args: {
    loginProvider: makeMockLoginProvider({
      connect: async () => {
        throw new Error("connect threw");
      },
    }),
  },
};
