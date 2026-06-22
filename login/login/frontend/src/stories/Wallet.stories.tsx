import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { Wallet } from "../components/Wallet";
import { walletMetaMask, walletNoLogo, walletLongName } from "./fixtures";

const meta: Meta<typeof Wallet> = {
  title: "Components/Wallet",
  component: Wallet,
  args: { onClick: fn() },
};
export default meta;

type Story = StoryObj<typeof Wallet>;

export const WithLogo: Story = { args: { wallet: walletMetaMask } };

// No connector icon → the generic wallet glyph fallback (the bug you spotted).
export const WithoutLogo: Story = { args: { wallet: walletNoLogo } };

export const LongName: Story = { args: { wallet: walletLongName } };
