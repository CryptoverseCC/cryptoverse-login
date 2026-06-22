import React from "react";

import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";

export interface LoaderProps {}

// MUI's CircularProgress carries its own (working) animation — the previous
// hand-rolled spinner used JSS's `$spin` keyframes reference, which emotion /
// tss-react don't resolve, so it never actually spun.
export const Loader: React.FC<LoaderProps> = () => (
  <Box
    role="progressbar"
    sx={{
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      width: "100%",
      minHeight: "60vh",
    }}
  >
    <CircularProgress size={96} thickness={4} />
  </Box>
);
