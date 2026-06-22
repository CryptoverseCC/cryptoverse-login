import type { Meta, StoryObj } from "@storybook/react";
import { Loader } from "../components/Loader";

const meta: Meta<typeof Loader> = {
  title: "Components/Loader",
  component: Loader,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof Loader>;

// The Suspense fallback / neutral "warming up" state (Vault seal + accent).
export const Default: Story = {};
