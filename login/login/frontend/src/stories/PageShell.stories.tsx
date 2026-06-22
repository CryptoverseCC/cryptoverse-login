import type { Meta, StoryObj } from "@storybook/react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { PageShell } from "../components/PageShell";

// The PageShell is the centred, max-width column every in-app screen sits in.
// These stories show it holds the same constrained column on the full-bleed
// gradient at any viewport width (the render test mounts both states).
const meta: Meta<typeof PageShell> = {
  title: "Components/PageShell",
  component: PageShell,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof PageShell>;

const Sample = (
  <Box
    sx={{
      width: "100%",
      p: 3,
      borderRadius: 2,
      border: "1px solid",
      borderColor: "hairline.main",
      backgroundColor: "surface.main",
      textAlign: "center",
    }}
  >
    <Typography variant="h2" component="h1">
      Constrained content
    </Typography>
    <Typography variant="body2" sx={{ color: "text.secondary", mt: 1 }}>
      Centred in a max-width column on the full-bleed Vault gradient.
    </Typography>
  </Box>
);

export const TopAligned: Story = {
  args: { align: "top", children: Sample },
};

export const Centered: Story = {
  args: { align: "center", children: Sample },
};
