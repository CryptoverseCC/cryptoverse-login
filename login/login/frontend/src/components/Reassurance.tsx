import React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";

// The quiet reassurance strip (spec §"Supporting touches"): a lock + one calm
// line, shown on both the wallet and identity screens. It tells the user the
// signature is a proof of ownership — not a transaction — before they ever
// reach the wallet prompt.

export interface ReassuranceProps {
  className?: string;
}

export const Reassurance: React.FC<ReassuranceProps> = ({ className }) => (
  <Box
    className={className}
    sx={(theme) => ({
      display: "flex",
      alignItems: "center",
      gap: 1.25,
      maxWidth: 460,
      px: 2,
      py: 1.25,
      borderRadius: `${theme.shape.borderRadius}px`,
      border: `1px solid ${theme.palette.hairline.main}`,
      backgroundColor: theme.palette.vault.infoTint,
    })}
  >
    <LockOutlinedIcon
      fontSize="small"
      sx={{ color: "primary.main", flexShrink: 0 }}
      aria-hidden="true"
    />
    <Typography variant="body2" sx={{ color: "text.secondary", textAlign: "left" }}>
      You&rsquo;ll sign a message to prove you own your address &mdash; no
      transaction, no gas.
    </Typography>
  </Box>
);

export default Reassurance;
