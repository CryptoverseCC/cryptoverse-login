import React from "react";
// also exported from '@storybook/react' if you can deal with breaking changes in 6.1
import { Story, Meta } from "@storybook/react";

import { Loader, LoaderProps } from "../components/Loader";

export default {
  title: "Base/Loader",
  component: Loader,
} as Meta;

const Template: Story<LoaderProps> = (args) => <Loader {...args}></Loader>;

export const Active = Template.bind({});
Active.args = {};
