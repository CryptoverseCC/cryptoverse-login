import type { Meta, StoryObj } from "@storybook/react";
import { Background } from "../../backgrounds/Default";
import { makeMockLoginProvider } from "../mockLoginProvider";

const meta: Meta<typeof Background> = {
  title: "Backgrounds/Default",
  component: Background,
  parameters: { layout: "fullscreen" },
  args: { loginProvider: makeMockLoginProvider() },
};
export default meta;

type Story = StoryObj<typeof Background>;

// The default splash screen; the "Ethereum Wallet" button reveals the app.
export const Splash: Story = {};
