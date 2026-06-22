import React, { useState, lazy, Suspense, StrictMode } from "react";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CssBaseline from "@mui/material/CssBaseline";
import Paper from "@mui/material/Paper";
import { Theme } from "@mui/material/styles";
import { makeStyles } from "tss-react/mui";
import Typography from "@mui/material/Typography";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";

import { ILoginProvider } from "../services/loginProvider";
import { Loader } from "../components/Loader";
import BrandMark from "../components/BrandMark";
import { vault } from "../theme";

const App = lazy(
  () =>
    import(
      /* webpackMode: "eager", webpackPreload: true, webpackChunkName: "app" */ "../App"
    )
);

const useStyles = makeStyles()((theme: Theme) => ({
  root: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing(2),
    background: theme.palette.vault.bodyBackground,
  },
  // A subtle radial glow behind the card — the one flourish from the spec.
  card: {
    position: "relative",
    width: "100%",
    maxWidth: 440,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
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
    width: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  },
  brand: {
    marginBottom: theme.spacing(4),
  },
  motif: {
    marginBottom: theme.spacing(3),
  },
  signInTo: {
    color: theme.palette.text.secondary,
  },
  origin: {
    marginTop: theme.spacing(0.5),
    marginBottom: theme.spacing(3),
    wordBreak: "break-word",
  },
  cta: {
    width: "100%",
    marginBottom: theme.spacing(2.5),
  },
  reassurance: {
    display: "flex",
    alignItems: "center",
    gap: theme.spacing(1),
    color: theme.palette.text.secondary,
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

// A small, on-brand Ethereum diamond motif rendered inline in the Vault accent
// (no remote PNG). Decorative — hidden from assistive tech.
function EthereumMotif() {
  return (
    <svg
      width={64}
      height={64}
      viewBox="0 0 96 96"
      fill="none"
      role="img"
      aria-hidden
      focusable="false"
    >
      <path
        d="M48 8 L72 48 L48 62 L24 48 Z"
        fill={vault.primary}
        fillOpacity={0.85}
      />
      <path d="M48 8 L72 48 L48 62 Z" fill={vault.primaryLight} fillOpacity={0.5} />
      <path
        d="M24 53 L48 67 L72 53 L48 88 Z"
        fill={vault.primary}
        fillOpacity={0.6}
      />
    </svg>
  );
}

export interface BackgroundProps {
  loginProvider: ILoginProvider;
}

export const Background: React.FC<BackgroundProps> = ({ loginProvider }) => {
  const { classes } = useStyles();
  const [open, setOpen] = useState(false);
  const origin =
    loginProvider.loginData.metadata?.app || loginProvider.loginData.clientId;
  return (
    <StrictMode>
      {!open && (
        <Box className={classes.root}>
          <CssBaseline />
          <Paper className={classes.card}>
            <div className={classes.inner}>
              <BrandMark size={26} className={classes.brand} />
              <div className={classes.motif}>
                <EthereumMotif />
              </div>
              <Typography variant="body2" className={classes.signInTo}>
                Sign in to
              </Typography>
              <Typography variant="h2" component="h1" className={classes.origin}>
                {origin}
              </Typography>
              <Button
                fullWidth
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
      {open && (
        <Suspense fallback={<Loader />}>
          <App className={classes.app} loginProvider={loginProvider} />
        </Suspense>
      )}
    </StrictMode>
  );
};

export default Background;
