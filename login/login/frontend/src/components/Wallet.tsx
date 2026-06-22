import React from "react";

import { Theme } from "@mui/material/styles";
import { makeStyles } from "tss-react/mui";
import Typography from "@mui/material/Typography";
import AccountBalanceWalletOutlinedIcon from "@mui/icons-material/AccountBalanceWalletOutlined";
import { TWalletInfo } from "../services/loginProvider";

const useStyles = makeStyles()((theme: Theme) => ({
  // Self-sizing flex cell: sits directly inside the screen's plain
  // `display:flex; flexWrap:wrap` row (no Grid container / negative margins).
  // The padding is the gutter; `box-sizing: border-box` keeps the declared
  // flex-basis honest so the row wraps cleanly. The screen now lives inside a
  // narrow, centred PageShell column (≈480px) at every viewport width, so a
  // wallet always gets its own full-width row — the intended, legible look —
  // rather than collapsing to a cramped fraction at desktop viewport widths.
  cell: {
    boxSizing: "border-box",
    padding: theme.spacing(1),
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: "100%",
    maxWidth: "100%",
  },
  // A full-width row tile: logo on the left, name beside it. Each wallet gets
  // its own row inside the narrow PageShell column at every width, so the row
  // layout (rather than a centred column) reads cleanly and consistently.
  tile: {
    width: "100%",
    display: "flex",
    flexDirection: "row",
    justifyContent: "flex-start",
    alignItems: "center",
    gap: theme.spacing(2),
    padding: theme.spacing(2),
    cursor: "pointer",
    borderRadius: theme.shape.borderRadius,
    backgroundColor: theme.palette.surface.main,
    border: `1px solid ${theme.palette.hairline.main}`,
    boxShadow: theme.palette.vault.softShadow,
    color: theme.palette.text.primary,
    textAlign: "left",
    transition: theme.transitions.create(
      ["border-color", "background-color", "transform", "box-shadow"],
      { duration: 180 }
    ),
    "&:hover": {
      borderColor: theme.palette.primary.main,
      backgroundColor: theme.palette.surfaceRaised.main,
      transform: "translateY(-2px)",
    },
    "&:focus-visible": {
      outline: "none",
      borderColor: theme.palette.primary.main,
      boxShadow: `0 0 0 2px ${theme.palette.primary.main}`,
    },
    "&:active": {
      transform: "translateY(0)",
    },
    "@media (prefers-reduced-motion: reduce)": {
      transition: "none",
      "&:hover": { transform: "none" },
    },
  },
  logoFrame: {
    width: theme.spacing(8),
    height: theme.spacing(8),
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    borderRadius: theme.shape.borderRadius,
    backgroundColor: theme.palette.vault.base,
    border: `1px solid ${theme.palette.hairline.main}`,
  },
  logo: {
    width: theme.spacing(6),
    height: theme.spacing(6),
    objectFit: "contain",
  },
  fallbackGlyph: {
    fontSize: theme.spacing(5),
    color: theme.palette.text.secondary,
  },
  name: {
    fontWeight: 600,
    wordBreak: "break-word",
  },
}));

export interface WalletProps {
  wallet: TWalletInfo;
  onClick: (wallet: TWalletInfo) => void;
}

export const Wallet: React.FC<WalletProps> = ({ wallet, onClick }) => {
  const { classes } = useStyles();
  const select = () => onClick(wallet);
  return (
    <div className={classes.cell}>
      <div
        role="button"
        tabIndex={0}
        aria-label={`Connect with ${wallet.name}`}
        className={classes.tile}
        onClick={select}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            select();
          }
        }}
      >
        <div className={classes.logoFrame}>
          {wallet.logo ? (
            <img className={classes.logo} src={wallet.logo} alt="" />
          ) : (
            <AccountBalanceWalletOutlinedIcon
              className={classes.fallbackGlyph}
              aria-hidden
            />
          )}
        </div>
        <Typography variant="subtitle1" className={classes.name}>
          {wallet.name}
        </Typography>
      </div>
    </div>
  );
};

export default Wallet;
