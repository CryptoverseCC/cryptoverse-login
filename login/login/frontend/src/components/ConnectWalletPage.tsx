import React from "react";

import HelpOutlineIcon from "@material-ui/icons/HelpOutline";
import { makeStyles, Theme } from "@material-ui/core/styles";
import Typography from "@material-ui/core/Typography";
import AppBar from "@material-ui/core/AppBar";
import Toolbar from "@material-ui/core/Toolbar";
import { Wallet } from "./Wallet";
import Grid from "@material-ui/core/Grid";
import { IProviderInfo } from "web3modal";
import { Nav } from "./Nav";
import { Restrictions } from "./Restrictions";
import { TRestrictions } from "../services/loginProvider";
import ArrowBackIcon from "@material-ui/icons/ArrowBack";
import { IconButton } from "@material-ui/core";

import metamaskImage from "./images/metamask.png";
import operaImage from "./images/opera.png";
import othersImage from "./images/others.png";
import { CryptoverseFamily } from "./CryptoverseFaimily";

const useStyles = makeStyles((theme: Theme) => ({
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

export interface ProviderItem {
  provider: IProviderInfo;
  active: boolean;
}

export enum Modes {
  SELECT = "select",
  HELP = "help",
}

export type ProviderList = ProviderItem[];

export interface ConnectWalletPageProps {
  onConnect: (provider: IProviderInfo) => void;
  providers: ProviderList;
  restrictions?: TRestrictions;
  origin: string;
  mode: Modes;
  switchMode: (mode: Modes) => void;
}

export const ConnectWalletPage: React.FC<ConnectWalletPageProps> = ({
  onConnect,
  providers,
  restrictions,
  origin,
  mode,
  switchMode,
}) => {
  const classes = useStyles();
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
            justify="center"
          >
            <Grid key={"header"} item container xs={12} justify="center">
              <Typography variant="h6">
                Which wallet you want to use?
              </Typography>
            </Grid>
            {restrictions && (
              <Grid
                key={"restrictions"}
                item
                container
                xs={12}
                justify="center"
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
              justify="center"
            >
              {providers.map((providerItem, index) => (
                <Wallet
                  key={providerItem.provider.id + index}
                  onClick={() => onConnect(providerItem.provider)}
                  active={providerItem.active}
                  provider={providerItem.provider}
                ></Wallet>
              ))}
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
            justify="center"
          >
            <Grid key={"header"} item container xs={12} justify="center">
              <Typography variant="h6">Select Wallet</Typography>
            </Grid>
            <Grid
              key={"items"}
              item
              container
              xs={12}
              className={classes.help}
              //justify="center"
            >
              <Typography className={classes.helpText}>
                Hi, if you're here then you are probably wondering what you
                should do now.
              </Typography>

              <Typography className={classes.helpText}>
                In this step you should select a wallet you want to use to login
                into {origin}. If you are using mobile wallet with dapp browser
                or Metamask extension you should see the logo of your wallet as
                the first choice. You should select it.
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
                If you are using a browser witch doesn't provide wallet
                capabilities you can use Wallet Connect to connect to many
                mobile browsers or MyEtherWallet to connect to MyEtherWallet
                mobile wallet
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
