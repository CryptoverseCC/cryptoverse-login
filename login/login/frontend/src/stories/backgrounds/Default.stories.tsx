import React from "react";
// also exported from '@storybook/react' if you can deal with breaking changes in 6.1
import { Story, Meta } from "@storybook/react";

import { Background, BackgroundProps } from "../../backgrounds/Default";
import { ThemeProvider } from "@material-ui/styles";
import theme from "../../theme";
import { walletProviders } from "../../providers";
import App from "../../App";

export default {
  title: "Backgrounds/Default",
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
      clientId: "web.ethmail.cc",
    },
  },
  walletProviders: walletProviders,
};
