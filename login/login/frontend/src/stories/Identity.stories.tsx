import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { Identity } from "../components/Identity";
import { identityActive, identityInactive, identityEns } from "./fixtures";

const meta: Meta<typeof Identity> = {
  title: "Components/Identity",
  component: Identity,
  args: { onClick: fn() },
};
export default meta;

type Story = StoryObj<typeof Identity>;

// Deterministic gradient avatar derived from the address.
export const Active: Story = { args: { identity: identityActive } };

// Token-gated out: greyed, with the Select button disabled.
export const Inactive: Story = { args: { identity: identityInactive } };

export const WithEns: Story = { args: { identity: identityEns } };
