import React from "react";
import { Story, Meta } from "@storybook/react";

import { Wallet, WalletProps } from "../components/Wallet";
import { injected, IProviderInfo, getProviderInfoById } from "web3modal";
import theme from "../theme";
import { ThemeProvider } from "@material-ui/styles";

export default {
  title: "Base/Wallet",
  component: Wallet,
} as Meta;

const Template: Story<WalletProps> = (args) => (
  <ThemeProvider theme={theme}>
    <Wallet {...args}></Wallet>
  </ThemeProvider>
);

export const Active = Template.bind({});
Active.args = {
  active: true,
  provider: injected.OPERA,
  onClick: (provider: IProviderInfo) => alert(`Provider ${provider} Click`),
};

export const Inactive = Template.bind({});
Inactive.args = {
  active: false,
  provider: injected.OPERA,
  onClick: (provider: IProviderInfo) => alert(`Provider ${provider} Click`),
};

export const ProviderMissing = Template.bind({});
ProviderMissing.args = {
  active: false,
  provider: { ...injected.FALLBACK, name: "Wallet Not Detected" },
  onClick: (provider: IProviderInfo) => alert(`Provider ${provider} Click`),
};

export const WalletConnect = Template.bind({});
WalletConnect.args = {
  active: true,
  provider: getProviderInfoById("walletconnect"),
  onClick: (provider: IProviderInfo) => alert(`Provider ${provider} Click`),
};
