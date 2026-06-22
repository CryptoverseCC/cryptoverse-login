import type { Meta, StoryObj } from "@storybook/react";
import { Loader } from "../components/Loader";

const meta: Meta<typeof Loader> = {
  title: "Components/Loader",
  component: Loader,
};
export default meta;

type Story = StoryObj<typeof Loader>;

// The spinning loader shown during init / connect / sign.
export const Default: Story = {};
