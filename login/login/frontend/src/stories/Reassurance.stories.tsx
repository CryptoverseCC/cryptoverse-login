import type { Meta, StoryObj } from "@storybook/react";
import { Reassurance } from "../components/Reassurance";

const meta: Meta<typeof Reassurance> = {
  title: "Components/Reassurance",
  component: Reassurance,
};
export default meta;

type Story = StoryObj<typeof Reassurance>;

// The lock + one calm line shown on the wallet and identity screens.
export const Default: Story = {};
