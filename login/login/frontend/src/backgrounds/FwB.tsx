import React, { useState, useEffect, Suspense } from "react";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CssBaseline from "@mui/material/CssBaseline";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import { Theme } from "@mui/material/styles";
import { makeStyles } from "tss-react/mui";
import Typography from "@mui/material/Typography";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";

import { ILoginProvider } from "../services/loginProvider";
import { Loader } from "../components/Loader";
import BrandMark from "../components/BrandMark";
import { App, warmApp } from "./lazyApp";

const UNISWAP_FWB =
  "https://app.uniswap.org/#/swap?outputCurrency=0x7d91e637589EC3Bb54D8213a9e92Dc6E8D12da91";

const useStyles = makeStyles()((theme: Theme) => ({
  root: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing(2),
    background: theme.palette.vault.bodyBackground,
  },
  card: {
    position: "relative",
    width: "100%",
    maxWidth: 480,
    padding: theme.spacing(5, 4),
    overflow: "hidden",
    [theme.breakpoints.down("sm")]: {
      padding: theme.spacing(4, 3),
    },
    "&::before": {
      content: '""',
      position: "absolute",
      top: -120,
      left: "50%",
      transform: "translateX(-50%)",
      width: 320,
      height: 320,
      borderRadius: "50%",
      background: `radial-gradient(circle, ${theme.palette.vault.glow} 0%, transparent 70%)`,
      pointerEvents: "none",
    },
  },
  inner: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: theme.spacing(2),
  },
  brandRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: theme.spacing(1),
  },
  // Inline "FWB" mark replacing the remote cargo.site logo PNG.
  fwbMark: {
    fontFamily: theme.typography.h1.fontFamily,
    fontWeight: 700,
    letterSpacing: "0.04em",
    fontSize: "1.1rem",
    color: theme.palette.primary.light,
    border: `1px solid ${theme.palette.hairline.main}`,
    borderRadius: theme.shape.borderRadius,
    padding: theme.spacing(0.5, 1),
    lineHeight: 1,
  },
  heading: {
    lineHeight: 1.15,
  },
  subhead: {
    color: theme.palette.text.secondary,
  },
  requirement: {
    color: theme.palette.text.secondary,
  },
  cta: {
    marginTop: theme.spacing(1),
    alignSelf: "flex-start",
  },
  reassurance: {
    display: "flex",
    alignItems: "center",
    gap: theme.spacing(1),
    color: theme.palette.text.secondary,
    marginTop: theme.spacing(0.5),
  },
  reassuranceIcon: {
    fontSize: 16,
    flexShrink: 0,
  },
  app: {
    position: "absolute",
    inset: 0,
    width: "100%",
  },
}));

export interface BackgroundProps {
  loginProvider: ILoginProvider;
}

export const Background: React.FC<BackgroundProps> = ({ loginProvider }) => {
  const { classes } = useStyles();
  const [open, setOpen] = useState(false);
  // Warm the lazy `App` chunk while the user reads the landing, so the click is
  // instant. See backgrounds/lazyApp.ts.
  useEffect(() => warmApp(), []);
  return (
    <Suspense fallback={<Loader />}>
      {!open && (
        <Box className={classes.root}>
          <CssBaseline />
          <Paper className={classes.card}>
            <div className={classes.inner}>
              <div className={classes.brandRow}>
                <BrandMark size={22} variant="mark" />
                <span className={classes.fwbMark} aria-label="Friends With Benefits">
                  FWB
                </span>
              </div>

              <Typography variant="h1" component="h1" className={classes.heading}>
                Friends With Benefits
              </Typography>
              <Typography variant="subtitle1" className={classes.subhead}>
                Tokenized Community
              </Typography>

              <Typography variant="body2" className={classes.requirement}>
                To access the Discourse, your wallet needs at least{" "}
                <strong>100 FWB</strong> tokens. You can buy FWB{" "}
                <Link href={UNISWAP_FWB} target="_blank" rel="noreferrer">
                  on Uniswap
                </Link>
                .
              </Typography>

              <Button
                size="large"
                variant="contained"
                color="primary"
                className={classes.cta}
                onClick={() => setOpen(true)}
              >
                Continue with a wallet
              </Button>

              <Typography variant="caption" className={classes.reassurance}>
                <LockOutlinedIcon className={classes.reassuranceIcon} aria-hidden />
                You'll sign a message to prove you own your address — no
                transaction, no gas.
              </Typography>
            </div>
          </Paper>
        </Box>
      )}
      {open && <App className={classes.app} loginProvider={loginProvider} />}
    </Suspense>
  );
};

export default Background;
