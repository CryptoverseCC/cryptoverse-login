import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { Identity } from "../components/Identity";
import type { IIdentity } from "../services/loginProvider";
import { identityActive, identityInactive, identityEns } from "./fixtures";

const meta: Meta<typeof Identity> = {
  title: "Components/Identity",
  component: Identity,
  args: { onClick: fn() },
};
export default meta;

type Story = StoryObj<typeof Identity>;

// Deterministic gradient avatar derived from the address; mono address chip.
export const Active: Story = { args: { identity: identityActive } };

// Token-gated out: legible (not 0.2-opacity), lock badge + default reason.
export const Inactive: Story = { args: { identity: identityInactive } };

// Token-gated out with an explicit, app-supplied reason string.
export const InactiveWithReason: Story = {
  args: {
    identity: identityInactive,
    restrictionReason: "Needs at least 100 FWB to sign in to this app.",
  },
};

// ENS name resolved → shown above the mono address chip.
export const WithEns: Story = { args: { identity: identityEns } };

// An ENS-only name (no separate .eth resolution) still renders cleanly.
const identityEnsOnly: IIdentity = {
  name: "vault.eth",
  ens: null,
  active: true,
};
export const EnsNameOnly: Story = { args: { identity: identityEnsOnly } };
