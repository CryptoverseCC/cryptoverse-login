import React from "react";
// also exported from '@storybook/react' if you can deal with breaking changes in 6.1
import { Story, Meta } from "@storybook/react";

import {
  ConnectWalletPage,
  ConnectWalletPageProps,
  Modes,
} from "../components/ConnectWalletPage";
import { injected } from "web3modal";
import theme from "../theme";
import { ThemeProvider } from "@material-ui/styles";
import { walletProviders } from "../providers";

export default {
  title: "Pages/Connect Wallet Page",
  component: ConnectWalletPage,
} as Meta;

const Template: Story<ConnectWalletPageProps> = (args) => (
  <ThemeProvider theme={theme}>
    <ConnectWalletPage
      {...args}
      switchMode={(m) => alert(`Switching mode to ${m}`)}
    />
  </ThemeProvider>
);

export const Opera = Template.bind({});
Opera.args = {
  origin: "https://web.ethmail.cc/",
  onConnect: (provider) => alert(`Hello ${provider}`),
  providers: [{ provider: injected.OPERA, active: true }, ...walletProviders],
  mode: Modes.SELECT,
};

export const Metamask = Template.bind({});
Metamask.args = {
  origin: "https://web.ethmail.cc/",
  onConnect: (provider) => alert(`Hello ${provider}`),
  providers: [
    { provider: injected.METAMASK, active: true },
    ...walletProviders,
  ],
  mode: Modes.SELECT,
};

export const MissingWeb3Provider = Template.bind({});
MissingWeb3Provider.args = {
  origin: "https://web.ethmail.cc/",
  onConnect: (provider) => alert(`Hello ${provider}`),
  providers: [
    {
      provider: {
        ...injected.FALLBACK,
        name: "Wallet Not Detected",
      },
      active: false,
    },
    ...walletProviders,
  ],
  mode: Modes.SELECT,
};

export const Restricted = Template.bind({});
Restricted.args = {
  origin: "https://web.ethmail.cc/",
  onConnect: (provider) => alert(`Hello ${provider}`),
  providers: [
    { provider: injected.METAMASK, active: true },
    ...walletProviders,
  ],
  restrictions: [
    {
      tokenAddress: "0xTokenAddress",
      condition: "balanceOf >= 1000",
    },
  ],
  mode: Modes.SELECT,
};

export const Help = Template.bind({});
Help.args = {
  origin: "https://web.ethmail.cc/",
  onConnect: (provider) => alert(`Hello ${provider}`),
  providers: [
    { provider: injected.METAMASK, active: true },
    ...walletProviders,
  ],
  restrictions: [
    {
      tokenAddress: "0xTokenAddress",
      condition: "balanceOf >= 1000",
    },
  ],
  mode: Modes.HELP,
};
