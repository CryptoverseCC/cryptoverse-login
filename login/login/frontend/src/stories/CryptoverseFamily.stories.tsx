import type { Meta, StoryObj } from "@storybook/react";
import { CryptoverseFamily } from "../components/CryptoverseFaimily";

const meta: Meta<typeof CryptoverseFamily> = {
  title: "Components/CryptoverseFamily",
  component: CryptoverseFamily,
};
export default meta;

type Story = StoryObj<typeof CryptoverseFamily>;

export const Default: Story = {};
