import type { Meta, StoryObj } from "@storybook/react";
import { Background } from "../../backgrounds/FwB";
import { makeMockLoginProvider } from "../mockLoginProvider";

const meta: Meta<typeof Background> = {
  title: "Backgrounds/FwB",
  component: Background,
  parameters: { layout: "fullscreen" },
  args: { loginProvider: makeMockLoginProvider() },
};
export default meta;

type Story = StoryObj<typeof Background>;

// The Friends-With-Benefits branded splash.
export const Splash: Story = {};
