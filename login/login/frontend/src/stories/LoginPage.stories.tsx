import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { LoginPage, Modes } from "../components/LoginPage";
import {
  identities,
  identityActive,
  identityInactive,
  walletMetaMask,
  restrictionWithMessage,
  restrictionNoMessage,
  restrictionsMultiple,
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

// A token-gated address is greyed out and not selectable. With no restrictions
// in scope the card falls back to <Identity>'s default reason copy.
export const InactiveIdentity: Story = {
  args: { identities: [identityActive, identityInactive] },
};

// Gated identity + a restriction carrying a custom message: the banner and the
// inactive card both show that message verbatim (derived once via
// restrictionReason and threaded into each <Identity>).
export const InactiveWithCustomMessage: Story = {
  args: {
    identities: [identityActive, identityInactive],
    restrictions: restrictionWithMessage,
  },
};

// Gated identity + a messageless token condition: the card shows the same
// generated requirement sentence the banner uses (token address truncated).
export const InactiveWithGeneratedReason: Story = {
  args: {
    identities: [identityActive, identityInactive],
    restrictions: restrictionNoMessage,
  },
};

// Several requirements at once: the card collapses to a concise generic line
// while the banner still lists each restriction in full.
export const InactiveWithMultipleRestrictions: Story = {
  args: {
    identities: [identityActive, identityInactive],
    restrictions: restrictionsMultiple,
  },
};

export const WithRestrictions: Story = {
  args: { restrictions: restrictionWithMessage },
};

// A cancelled signature surfaced as an inline Alert (the user can re-pick).
export const WithError: Story = {
  args: { error: "Signing was cancelled. Choose an address to try again." },
};

export const HelpMode: Story = { args: { mode: Modes.HELP } };
