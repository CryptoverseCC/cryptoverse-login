import React from "react";
import { Story, Meta } from "@storybook/react";

import { injected } from "web3modal";
import { LoginPage, LoginPageProps, Modes } from "../components/LoginPage";
import { ThemeProvider } from "@material-ui/styles";
import theme from "../theme";

export default {
  title: "Pages/Login Page",
  component: LoginPage,
} as Meta;

const Template: Story<LoginPageProps> = (args) => (
  <ThemeProvider theme={theme}>
    <LoginPage {...args} />
  </ThemeProvider>
);

export const Init = Template.bind({});
Init.args = {
  origin: "https://web.ethmail.cc/",
  onLogin: () => alert("Hello"),
  provider: injected.OPERA,
  identities: [
    {
      name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04da",
      ens: "xunkulapchvatal.eth",
      active: true,
    },
    {
      name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04db",
      ens: null,
      active: true,
    },
    {
      name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04dc",
      ens: null,
      active: true,
    },
    {
      name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04dd",
      ens: null,
      active: true,
    },
  ],
  mode: Modes.SELECT,
  switchMode: () => alert("Switch mode"),
};

export const One = Template.bind({});
One.args = {
  origin: "https://web.ethmail.cc/",
  onLogin: () => alert("Hello"),
  provider: injected.OPERA,
  identities: [
    {
      name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04da",
      ens: "xunkulapchvatal.eth",
      active: true,
    },
  ],
  mode: Modes.SELECT,
  switchMode: () => alert("Switch mode"),
};

export const Many = Template.bind({});
Many.args = {
  origin: "https://web.ethmail.cc/",
  onLogin: () => alert("Hello"),
  onSelectWallet: () => alert("Go back to Select Wallet"),
  provider: injected.OPERA,
  identities: [
    {
      name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04da",
      ens: "xunkulapchvatal.eth",
      active: true,
    },
    {
      name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04db",
      ens: null,
      active: true,
    },
    {
      name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04dc",
      ens: null,
      active: true,
    },
    {
      name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04dd",
      ens: null,
      active: true,
    },
    {
      name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04de",
      ens: null,
      active: true,
    },
    {
      name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04df",
      ens: null,
      active: true,
    },
    {
      name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04d0",
      ens: null,
      active: true,
    },
    {
      name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04d1",
      ens: null,
      active: true,
    },
    {
      name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04d2",
      ens: null,
      active: true,
    },
    {
      name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04d3",
      ens: null,
      active: true,
    },
    {
      name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04d4",
      ens: null,
      active: true,
    },
    {
      name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04d5",
      ens: null,
      active: true,
    },
  ],
  mode: Modes.SELECT,
  switchMode: () => alert("Switch mode"),
};

export const Restricted = Template.bind({});
Restricted.args = {
  origin: "https://web.ethmail.cc/",
  onLogin: () => alert("Hello"),
  onSelectWallet: () => alert("Go back to Select Wallet"),
  restrictions: [
    {
      tokenAddress: "0xTokenAddress",
      condition: "balanceOf > 1000",
    },
  ],
  provider: injected.OPERA,
  identities: [
    {
      name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04da",
      ens: "xunkulapchvatal.eth",
      active: true,
    },
    {
      name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04db",
      ens: null,
      active: false,
    },
    {
      name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04dc",
      ens: null,
      active: false,
    },
    {
      name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04dd",
      ens: null,
      active: false,
    },
  ],
  mode: Modes.SELECT,
  switchMode: () => alert("Switch mode"),
};

export const Help = Template.bind({});
Help.args = {
  origin: "https://web.ethmail.cc/",
  onLogin: () => alert("Hello"),
  provider: injected.OPERA,
  identities: [
    {
      name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04da",
      ens: "xunkulapchvatal.eth",
      active: true,
    },
  ],
  mode: Modes.HELP,
  switchMode: () => alert("Switch mode"),
};
