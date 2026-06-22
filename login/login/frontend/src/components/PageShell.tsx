import React from "react";
import Box from "@mui/material/Box";

// The shared layout shell for every in-app screen (wallet picker, address
// picker, the StatusView choreography). An auth UI should always read as a
// single centered, max-width column on the full-bleed Vault gradient — never a
// panel stretched edge-to-edge. The redesign was only ever checked at ~420px
// wide, so the in-app pages had no max-width and the AppBar spanned the whole
// viewport at desktop widths; this is the one place that constraint now lives.
//
// - The outer layer full-bleeds (minHeight 100vh) and centers its child
//   horizontally. The gradient itself comes from `CssBaseline` (body) or the
//   splash background this overlays, so the shell stays transparent.
// - `align` controls the vertical placement of the column: "top" for the
//   AppBar-led pages (so the bar reads as a header) and "center" for the
//   StatusView states (the seal choreography wants to sit mid-surface).
// - The column is `maxWidth` wide (default 480px) and never wider, so the
//   wallet / identity cards inside it always stack ~1 per row — the intended,
//   already-good narrow look — at any viewport width.

export const SHELL_MAX_WIDTH = 480;

export interface PageShellProps {
  children: React.ReactNode;
  /** Vertical placement of the centered column. */
  align?: "top" | "center";
  /** Column max width in px (default 480). */
  maxWidth?: number;
  className?: string;
}

export const PageShell: React.FC<PageShellProps> = ({
  children,
  align = "top",
  maxWidth = SHELL_MAX_WIDTH,
  className,
}) => (
  <Box
    className={className}
    sx={{
      minHeight: "100vh",
      width: "100%",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: align === "center" ? "center" : "flex-start",
    }}
  >
    <Box
      sx={{
        width: "100%",
        maxWidth,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {children}
    </Box>
  </Box>
);

export default PageShell;
