import React from "react";
// also exported from '@storybook/react' if you can deal with breaking changes in 6.1
import { Story, Meta } from "@storybook/react";

import { Background, BackgroundProps } from "../../backgrounds/FwB";
import { ThemeProvider } from "@material-ui/styles";
import theme from "../../theme";
import App from "../../App";
import { walletProviders } from "../../providers";

export default {
  title: "Backgrounds/FwB",
  component: Background,
} as Meta;

const Template: Story<BackgroundProps> = (args) => (
  <ThemeProvider theme={theme}>
    <Background {...args}></Background>
  </ThemeProvider>
);

export const Base = Template.bind({});
Base.args = {
  AppComponent: App,
  loginProvider: {
    init: async () => ({ name: "" }),
    login: async () => ({
      signature: "",
      csrf: "",
      address: "",
      challenge: "",
    }),
    connect: async () => ({ identities: [] }),
    identities: async () => ({ identities: [] }),
    loginData: {
      csrf: "",
      challenge: "",
      sourceId: "",
      clientId: "fwb.cryptoverse.cc",
    },
  },
  walletProviders: walletProviders,
};
