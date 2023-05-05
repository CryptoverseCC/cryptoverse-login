import React from "react";
// also exported from '@storybook/react' if you can deal with breaking changes in 6.1
import { Story, Meta } from "@storybook/react";

import { Identity, IdentityProps } from "../components/Identity";
import { ThemeProvider } from "@material-ui/styles";
import theme from "../theme";

export default {
  title: "Base/Identity",
  component: Identity,
} as Meta;

const Template: Story<IdentityProps> = (args) => (
  <ThemeProvider theme={theme}>
    <Identity {...args}></Identity>
  </ThemeProvider>
);

export const Active = Template.bind({});
Active.args = {
  identity: {
    name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04da",
    ens: "xunkulapchvatal.eth",
    active: true,
  },
};

export const Inactive = Template.bind({});
Inactive.args = {
  identity: {
    name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04da",
    ens: "xunkulapchvatal.eth",
    active: false,
  },
};

export const NoENS = Template.bind({});
NoENS.args = {
  identity: {
    name: "0x6Be450972b30891B16c8588DcBc10c8c2aEf04da",
    ens: null,
    active: true,
  },
};
