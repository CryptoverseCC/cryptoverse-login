import type { Meta, StoryObj } from "@storybook/react";
import { Restrictions } from "../components/Restrictions";
import {
  restrictionWithMessage,
  restrictionNoMessage,
  restrictionsMultiple,
} from "./fixtures";

const meta: Meta<typeof Restrictions> = {
  title: "Components/Restrictions",
  component: Restrictions,
};
export default meta;

type Story = StoryObj<typeof Restrictions>;

// A custom message supplied by the client metadata.
export const WithMessage: Story = {
  args: { restrictions: restrictionWithMessage },
};

// No message → the generated "token owners fulfilling condition" copy.
export const WithoutMessage: Story = {
  args: { restrictions: restrictionNoMessage },
};

export const Multiple: Story = {
  args: { restrictions: restrictionsMultiple },
};

export const None: Story = { args: { restrictions: [] } };
