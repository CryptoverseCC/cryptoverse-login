import React, { useState, lazy, Suspense, StrictMode } from "react";

import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CssBaseline from "@mui/material/CssBaseline";
import Grid from "@mui/material/GridLegacy";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import { Theme } from "@mui/material/styles";
import { makeStyles } from "tss-react/mui";
import Typography from "@mui/material/Typography";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import { ILoginProvider } from "../services/loginProvider";
import { Loader } from "../components/Loader";

const App = lazy(
  () =>
    import(
      /* webpackMode: "eager", webpackPreload: true, webpackChunkName: "app" */ "../App"
    )
);

const useStyles = makeStyles()((theme: Theme) => ({
  root: {
    height: "100vh",
  },
  image: {
    backgroundImage: "url(/login/ethereum-logo.png)",
    backgroundRepeat: "no-repeat",
    backgroundColor:
      theme.palette.mode === "light"
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
  const { classes } = useStyles();
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
}

export const Background: React.FC<BackgroundProps> = ({ loginProvider }) => {
  const { classes } = useStyles();
  const [open, setOpen] = useState(false);
  let origin = loginProvider.loginData.metadata?.app || loginProvider.loginData.clientId;
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
                {origin}
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
          <App className={classes.app} loginProvider={loginProvider} />
        </Suspense>
      )}
    </StrictMode>
  );
};
