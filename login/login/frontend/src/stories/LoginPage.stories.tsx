import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { LoginPage, Modes } from "../components/LoginPage";
import {
  identities,
  identityActive,
  identityInactive,
  walletMetaMask,
  restrictionWithMessage,
} from "./fixtures";

const meta: Meta<typeof LoginPage> = {
  title: "Pages/LoginPage",
  component: LoginPage,
  args: {
    origin: "demo.app",
    wallet: walletMetaMask,
    identities,
    mode: Modes.SELECT,
    onLogin: fn(),
    onSelectWallet: fn(),
    switchMode: fn(),
  },
};
export default meta;

type Story = StoryObj<typeof LoginPage>;

export const SingleIdentity: Story = { args: { identities: [identityActive] } };

export const MultipleIdentities: Story = {};

// A token-gated address is greyed out and not selectable.
export const InactiveIdentity: Story = {
  args: { identities: [identityActive, identityInactive] },
};

export const WithRestrictions: Story = {
  args: { restrictions: restrictionWithMessage },
};

// A sign failure / rejection surfaced as an Alert.
export const WithError: Story = {
  args: { error: "Signing was cancelled or failed. Please try again." },
};

export const HelpMode: Story = { args: { mode: Modes.HELP } };
