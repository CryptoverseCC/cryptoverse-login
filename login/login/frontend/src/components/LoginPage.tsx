import React from "react";

import { IconButton, Alert } from "@mui/material";
import AppBar from "@mui/material/AppBar";
import Grid from "@mui/material/GridLegacy";
import { Theme } from "@mui/material/styles";
import { makeStyles } from "tss-react/mui";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";

import {
  IIdentity,
  TLoginRequest,
  TRestrictions,
  TWalletInfo,
} from "../services/loginProvider";
import { Identity } from "./Identity";
import { Restrictions } from "./Restrictions";
import { CryptoverseFamily } from "./CryptoverseFaimily";

const useStyles = makeStyles()((theme: Theme) => ({
  main: {
    padding: theme.spacing(5),
  },
  actions: {
    padding: theme.spacing(2),
  },
  title: {
    flexGrow: 1,
  },
  backButton: {
    marginRight: theme.spacing(2),
  },
  root: {
    flexGrow: 1,
  },
  restrictions: {
    marginTop: theme.spacing(4),
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
}));

export enum Modes {
  SELECT = "select",
  HELP = "help",
}

export interface LoginPageProps {
  onLogin: (request: TLoginRequest) => void;
  onSelectWallet: () => void;
  restrictions?: TRestrictions;
  origin: string;
  wallet: TWalletInfo;
  identities: IIdentity[];
  error?: string | null;
  mode: Modes;
  switchMode: (mode: Modes) => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({
  onLogin,
  onSelectWallet,
  restrictions,
  origin,
  wallet,
  identities,
  error,
  mode,
  switchMode,
}) => {
  const { classes } = useStyles();
  return (
    <>
      {mode === Modes.SELECT && (
        <Grid container>
          <Grid item container xs={12} className={classes.root}>
            <AppBar position="static">
              <Toolbar>
                <IconButton
                  onClick={onSelectWallet}
                  edge="start"
                  className={classes.backButton}
                  color="inherit"
                  aria-label="back"
                >
                  <ArrowBackIcon />
                </IconButton>

                <Typography color="inherit" className={classes.title}>
                  Login with {wallet.name}
                </Typography>
                <HelpOutlineIcon onClick={() => switchMode(Modes.HELP)} />
              </Toolbar>
            </AppBar>
          </Grid>
          {restrictions && (
            <Grid
              key={"restrictions"}
              item
              container
              xs={12}
              justifyContent="center"
              className={classes.restrictions}
            >
              <Restrictions restrictions={restrictions}></Restrictions>
            </Grid>
          )}
          {error && (
            <Grid
              key={"error"}
              item
              container
              xs={12}
              justifyContent="center"
              className={classes.restrictions}
            >
              <Alert severity="warning" variant="outlined">
                {error}
              </Alert>
            </Grid>
          )}
          <Grid
            item
            container
            xs={12}
            className={classes.main}
            justifyContent="space-evenly"
          >
            {identities.map((identity) => (
              <Identity
                key={identity.name}
                onClick={() => onLogin({ address: identity.name })}
                identity={identity}
              ></Identity>
            ))}
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
                  Login with Identity - Help Page
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
              <Typography variant="h6">Login with Identity</Typography>
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
                In this step you need to decide whish address you wan to use as
                your identity and login to {origin}. Just click on the identity
                you have chosen,you will be asked to sign authentication message
                and after signing it you will be redirected to {origin}.
              </Typography>
            </Grid>
            <CryptoverseFamily />
          </Grid>
        </Grid>
      )}
    </>
  );
};

export default LoginPage;
