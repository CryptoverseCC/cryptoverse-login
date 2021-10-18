import React from "react";
import { Story, Meta } from "@storybook/react";

import { Restrictions, RestrictionsProps } from "../components/Restrictions";
import theme from "../theme";
import { ThemeProvider } from "@material-ui/styles";

export default {
  title: "Base/Restrictions",
  component: Restrictions,
} as Meta;

const Template: Story<RestrictionsProps> = (args) => (
  <ThemeProvider theme={theme}>
    <Restrictions {...args}></Restrictions>
  </ThemeProvider>
);

export const TokenOwners = Template.bind({});
TokenOwners.args = {
  restrictions: [
    {
      tokenAddress: "0x89d24A6b4CcB1B6fAA2625fE562bDD9a23260359",
      condition: "balanceOf >= 1",
    },
  ],
};

export const MultiTokenOwners = Template.bind({});
MultiTokenOwners.args = {
  restrictions: [
    {
      tokenAddress: "0x89d24A6b4CcB1B6fAA2625fE562bDD9a23260359",
      condition: "balanceOf >= 1",
    },
    {
      tokenAddress: "0x89d24A6b4CcB1B6fAA2625fE562bDD9a23260359",
      condition: "balanceOf >= 1000",
    },
  ],
};
