import React, { useState, lazy, Suspense, StrictMode } from "react";

import Avatar from "@material-ui/core/Avatar";
import Box from "@material-ui/core/Box";
import Button from "@material-ui/core/Button";
import CssBaseline from "@material-ui/core/CssBaseline";
import Grid from "@material-ui/core/Grid";
import Link from "@material-ui/core/Link";
import Paper from "@material-ui/core/Paper";
import { makeStyles, Theme } from "@material-ui/core/styles";
import Typography from "@material-ui/core/Typography";
import LockOutlinedIcon from "@material-ui/icons/LockOutlined";
import { ProviderList } from "../components/ConnectWalletPage";
import { ILoginProvider } from "../services/loginProvider";
import { Loader } from "../components/Loader";

const App = lazy(
  () => import(/* webpackPreload: true, webpackChunkName: "app" */ "../App")
);

const useStyles = makeStyles((theme: Theme) => ({
  root: {
    height: "100vh",
  },
  image: {
    backgroundImage: "url(/login/ethereum-logo.png)",
    backgroundRepeat: "no-repeat",
    backgroundColor:
      theme.palette.type === "light"
        ? theme.palette.grey[50]
        : theme.palette.grey[900],
    backgroundSize: "60%",
    backgroundPosition: "center",
  },
  paper: {
    margin: theme.spacing(8, 4),
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  },
  avatar: {
    backgroundColor: theme.palette.secondary.main,
    margin: theme.spacing(2, 0, 2, 0),
  },
  form: {
    width: "100%",
    marginTop: theme.spacing(0),
  },
  submit: {
    margin: theme.spacing(3, 0, 2),
  },
  origin: {
    margin: theme.spacing(2, 0, 2, 0),
  },
  app: {
    position: "absolute",
    top: 0,
    left: 0,
  },
  info: {},
  coffee: {
    marginTop: 20,
    height: 40,
    width: 143,
  },
}));

function Info() {
  const classes = useStyles();
  return (
    <Typography
      variant="body2"
      color="textSecondary"
      align="center"
      className={classes.info}
    >
      {"Support cryptoverse login with a coffee!"}
      <br />
      <Link href="https://www.buymeacoffee.com/xunkulapchvatal" target="_blank">
        <img
          src="https://cdn.buymeacoffee.com/buttons/v2/default-blue.png"
          alt="Buy Me A Coffee"
          className={classes.coffee}
        />
      </Link>
    </Typography>
  );
}

export interface BackgroundProps {
  loginProvider: ILoginProvider;
  walletProviders: ProviderList;
}

export const Background: React.FC<BackgroundProps> = ({
  loginProvider,
  walletProviders,
}) => {
  const classes = useStyles();
  const [open, setOpen] = useState(false);
  return (
    <StrictMode>
      {!open && (
        <Grid container component="main" className={classes.root}>
          <CssBaseline />
          <Grid item xs={false} sm={4} md={7} className={classes.image} />
          <Grid
            item
            xs={12}
            sm={8}
            md={5}
            component={Paper}
            elevation={6}
            square
          >
            <div className={classes.paper}>
              <Avatar className={classes.avatar}>
                <LockOutlinedIcon />
              </Avatar>
              <Typography component="h1" variant="h5">
                Login to:
              </Typography>
              <Typography
                className={classes.origin}
                component="h1"
                variant="h5"
              >
                {loginProvider.loginData.clientId}
              </Typography>
              <Typography component="h1" variant="h5">
                with:
              </Typography>
              <div className={classes.form}>
                <Button
                  fullWidth
                  variant="contained"
                  color="primary"
                  className={classes.submit}
                  onClick={() => setOpen(true)}
                >
                  Ethereum Wallet
                </Button>
                <Grid container>
                  <Grid item xs>
                    <Link
                      href="mailto:xunkulapchvatal@ethmail.cc"
                      variant="body2"
                    >
                      I need help
                    </Link>
                  </Grid>
                </Grid>
                <Box mt={5}>
                  <Info />
                </Box>
              </div>
            </div>
          </Grid>
        </Grid>
      )}
      {open && (
        <Suspense fallback={<Loader />}>
          <App
            className={classes.app}
            loginProvider={loginProvider}
            walletProviders={walletProviders}
          />
        </Suspense>
      )}
    </StrictMode>
  );
};
