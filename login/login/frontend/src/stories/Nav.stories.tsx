import React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import { Nav } from "../components/Nav";

const meta: Meta<typeof Nav> = {
  title: "Components/Nav",
  component: Nav,
  args: {
    className: "",
    children: <Typography color="inherit">Select Wallet</Typography>,
  },
  // Render inside an AppBar/Toolbar the way the pages use it (inherit colors).
  decorators: [
    (Story) => (
      <AppBar position="static">
        <Toolbar>
          <Story />
        </Toolbar>
      </AppBar>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof Nav>;

export const Default: Story = { args: { origin: "demo.app" } };

export const LongOrigin: Story = {
  args: { origin: "some.really-long-subdomain.example.com" },
};
