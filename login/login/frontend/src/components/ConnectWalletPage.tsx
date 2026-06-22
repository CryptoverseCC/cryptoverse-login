import React from "react";

import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import { Theme } from "@mui/material/styles";
import { makeStyles } from "tss-react/mui";
import Typography from "@mui/material/Typography";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import { Wallet } from "./Wallet";
import Grid from "@mui/material/GridLegacy";
import { Nav } from "./Nav";
import { Restrictions } from "./Restrictions";
import { TRestrictions, TWalletInfo } from "../services/loginProvider";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { IconButton, Alert } from "@mui/material";

import metamaskImage from "./images/metamask.png";
import operaImage from "./images/opera.png";
import othersImage from "./images/others.png";
import { CryptoverseFamily } from "./CryptoverseFaimily";

const useStyles = makeStyles()((theme: Theme) => ({
  main: {
    [theme.breakpoints.up("sm")]: {
      padding: theme.spacing(3),
    },
    [theme.breakpoints.down("sm")]: {
      padding: theme.spacing(1),
    },
  },
  actions: {
    padding: theme.spacing(2),
  },
  avatar: {
    width: theme.spacing(20),
    height: theme.spacing(20),
  },
  backButton: {
    marginRight: theme.spacing(2),
  },
  title: {
    flexGrow: 1,
  },
  root: {
    flexGrow: 1,
  },
  help: {
    [theme.breakpoints.up("sm")]: {
      padding: theme.spacing(3),
    },
    [theme.breakpoints.down("sm")]: {
      padding: theme.spacing(1),
    },
  },
  helpText: {
    [theme.breakpoints.up("sm")]: {
      padding: theme.spacing(3),
    },
    [theme.breakpoints.down("sm")]: {
      padding: theme.spacing(1),
    },
  },
  helpImage: {
    [theme.breakpoints.down("sm")]: {
      maxWidth: "100%",
    },
    [theme.breakpoints.up("sm")]: {
      maxWidth: "30%",
    },
  },
}));

export enum Modes {
  SELECT = "select",
  HELP = "help",
}

export interface ConnectWalletPageProps {
  onConnect: (wallet: TWalletInfo) => void;
  wallets: TWalletInfo[];
  restrictions?: TRestrictions;
  origin: string;
  error?: string | null;
  mode: Modes;
  switchMode: (mode: Modes) => void;
}

export const ConnectWalletPage: React.FC<ConnectWalletPageProps> = ({
  onConnect,
  wallets,
  restrictions,
  origin,
  error,
  mode,
  switchMode,
}) => {
  const { classes } = useStyles();
  return (
    <>
      {mode === Modes.SELECT && (
        <Grid container>
          <Grid key={"nav"} item xs={12} className={classes.root}>
            <AppBar position="static">
              <Toolbar>
                <Nav origin={origin} className={classes.title}>
                  <Typography color="inherit">Select Wallet</Typography>
                </Nav>
                <HelpOutlineIcon onClick={() => switchMode(Modes.HELP)} />
              </Toolbar>
            </AppBar>
          </Grid>
          <Grid
            key={"wallets"}
            item
            container
            xs={12}
            className={classes.main}
            justifyContent="center"
          >
            <Grid key={"header"} item container xs={12} justifyContent="center">
              <Typography variant="h6">
                Which wallet do you want to use?
              </Typography>
            </Grid>
            {error && (
              <Grid
                key={"error"}
                item
                container
                xs={12}
                justifyContent="center"
                className={classes.main}
              >
                <Alert severity="warning" variant="outlined">
                  {error}
                </Alert>
              </Grid>
            )}
            {restrictions && (
              <Grid
                key={"restrictions"}
                item
                container
                xs={12}
                justifyContent="center"
              >
                <Restrictions restrictions={restrictions}></Restrictions>
              </Grid>
            )}
            <Grid
              key={"items"}
              item
              container
              xs={12}
              className={classes.main}
              justifyContent="center"
            >
              {wallets.length === 0 ? (
                <Typography className={classes.helpText}>
                  No wallet detected. Install a browser wallet (e.g. MetaMask or
                  Rabby), or use WalletConnect to connect a mobile wallet.
                </Typography>
              ) : (
                wallets.map((wallet) => (
                  <Wallet
                    key={wallet.id}
                    onClick={onConnect}
                    wallet={wallet}
                  ></Wallet>
                ))
              )}
            </Grid>
          </Grid>
        </Grid>
      )}
      {mode === Modes.HELP && (
        <Grid container>
          <Grid key={"nav"} item xs={12} className={classes.root}>
            <AppBar position="static">
              <Toolbar>
                <IconButton
                  onClick={() => switchMode(Modes.SELECT)}
                  edge="start"
                  className={classes.backButton}
                  color="inherit"
                  aria-label="back"
                >
                  <ArrowBackIcon />
                </IconButton>
                <Typography color="inherit" className={classes.title}>
                  Select Wallet - Help Page
                </Typography>
              </Toolbar>
            </AppBar>
          </Grid>
          <Grid
            key={"wallets"}
            item
            container
            xs={12}
            className={classes.main}
            justifyContent="center"
          >
            <Grid key={"header"} item container xs={12} justifyContent="center">
              <Typography variant="h6">Select Wallet</Typography>
            </Grid>
            <Grid
              key={"items"}
              item
              container
              xs={12}
              className={classes.help}
              justifyContent="center"
            >
              <Typography className={classes.helpText}>
                Hi, if you're here then you are probably wondering what you
                should do now.
              </Typography>

              <Typography className={classes.helpText}>
                In this step you should select a wallet you want to use to login
                into {origin}. If you are using a mobile wallet with a dapp
                browser or a browser-extension wallet (MetaMask, Rabby, …) you
                should see it listed here — select it.
              </Typography>

              <img
                src={metamaskImage}
                loading="lazy"
                alt="MetaMask"
                className={classes.helpImage}
              />

              <img
                src={operaImage}
                loading="lazy"
                alt="Opera"
                className={classes.helpImage}
              />

              <Typography className={classes.helpText}>
                If your browser doesn't provide a wallet, use WalletConnect to
                connect a mobile wallet by scanning a QR code, or use Coinbase
                Wallet.
              </Typography>

              <img
                src={othersImage}
                loading="lazy"
                alt="Others"
                className={classes.helpImage}
              />
            </Grid>
            <CryptoverseFamily />
          </Grid>
        </Grid>
      )}
    </>
  );
};

export default ConnectWalletPage;
