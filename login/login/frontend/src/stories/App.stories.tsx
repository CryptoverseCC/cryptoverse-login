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

// init never resolves → the loading spinner state.
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

// A rejected connect surfaces the error Alert on the wallet picker.
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
