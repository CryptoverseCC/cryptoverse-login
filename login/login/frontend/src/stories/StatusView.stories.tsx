import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { StatusView } from "../components/StatusView";

const meta: Meta<typeof StatusView> = {
  title: "Components/StatusView",
  component: StatusView,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof StatusView>;

// The neutral "warming up" state (also what Loader renders).
export const Loading: Story = {
  args: { kind: "loading", title: "Getting things ready…" },
};

// Wallet prompt opened — waiting for the user to act in their wallet.
export const Connecting: Story = {
  args: {
    kind: "connecting",
    title: "Opening MetaMask…",
    subtext: "Check your wallet to continue.",
  },
};

// Signature requested — the seal closes; reassurance that it's not a transaction.
export const Signing: Story = {
  args: {
    kind: "signing",
    title: "Confirm the signature in MetaMask",
    subtext: "This proves you own the address — no transaction, no fee.",
    detail: "no transaction · no gas",
  },
};

// Success seal while the browser navigates back to the relying party.
export const Redirecting: Story = {
  args: {
    kind: "redirecting",
    title: "Signed in",
    subtext: "Taking you to demo.app…",
  },
};

// The terminal dead-end state with a Try again action (also the 60s hang guard).
export const Error: Story = {
  args: {
    kind: "error",
    title: "This is taking longer than expected",
    subtext:
      "We didn't hear back from your wallet. Open it to finish, or try again.",
    actionLabel: "Try again",
    onAction: fn(),
  },
};
