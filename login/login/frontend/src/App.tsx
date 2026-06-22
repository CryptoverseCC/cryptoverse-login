import React, { useEffect, useRef, useState } from "react";
import { makeStyles } from "tss-react/mui";
import {
  ILoginProvider,
  IIdentity,
  TLoginRequest,
  TWalletInfo,
} from "./services/loginProvider";
import {
  ConnectWalletPage,
  Modes as ConnectWalletPageModes,
} from "./components/ConnectWalletPage";

import { LoginPage, Modes as LoginPageModes } from "./components/LoginPage";
import { Loader } from "./components/Loader";
import { CssBaseline, Paper } from "@mui/material";
import Grid from "@mui/material/GridLegacy";

interface Window {
  Sentry: any;
}

const HANG_MS = 60 * 1000;

const useStyles = makeStyles()((theme) => ({
  root: {
    flexGrow: 1,
    textAlign: "center",
  },
  paper: {
    flexGrow: 1,
    height: "100vh",
  },
  container: {
    [theme.breakpoints.up("sm")]: {
      padding: theme.spacing(2),
    },
    [theme.breakpoints.down("sm")]: {
      padding: theme.spacing(1),
    },
  },
  addressButton: {
    wordBreak: "break-all",
  },
}));

export interface AppProps {
  loginProvider: ILoginProvider;
  className?: string;
}

let identitiesInterval: number | null = null;

const App: React.FC<AppProps> = ({ loginProvider, className }) => {
  const { classes } = useStyles();
  const [wallets, setWallets] = useState([] as TWalletInfo[]);
  const [currentWallet, setCurrentWallet] = useState(null as TWalletInfo | null);
  const [identities, setIdentities] = useState([] as IIdentity[]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null as string | null);
  // Guards against re-entrant connect/login (a wallet handles one prompt at a
  // time); a second trigger while one is busy is ignored with a message.
  const busy = useRef(false);
  const [walletPageMode, setWalletPageMode] = useState(
    ConnectWalletPageModes.SELECT
  );
  const [loginPageMode, setLoginPageMode] = useState(LoginPageModes.SELECT);

  const reportError = (message: string, err?: unknown) => {
    if (err) {
      const sentry = (window as unknown as Window).Sentry;
      sentry?.captureException?.(err);
    }
    setError(message);
  };

  const onLogin = async (request: TLoginRequest) => {
    if (busy.current) {
      setError("A wallet request is already in progress — check your wallet.");
      return;
    }
    busy.current = true;
    setError(null);
    setLoading(true);
    const guard = window.setTimeout(() => setLoading(false), HANG_MS);

    try {
      const resp = await loginProvider.login(request);
      if (!resp) {
        reportError("Signing was cancelled or failed. Please try again.");
        setLoading(false);
        return;
      }

      const { message, signature, challenge } = resp;
      // Post as URLSearchParams (not a <form>/FormData) so the SIWE message's LF
      // line endings survive — the backend parses EIP-4361 over the signed LF form.
      const body = new URLSearchParams();
      body.set("challenge", challenge);
      body.set("message", message);
      body.set("signature", signature);
      body.set("response", "api");

      const loginResponse = await fetch("/login/process", {
        method: "POST",
        body,
      });
      if (!loginResponse.ok) {
        throw new Error(`/login/process responded ${loginResponse.status}`);
      }
      const data = await loginResponse.json();
      if (!data?.redirect) {
        throw new Error("login response did not include a redirect");
      }
      // Keep the loader up through the navigation.
      window.location.assign(data.redirect);
    } catch (err) {
      reportError("Login failed. Please try again.", err);
      setLoading(false);
    } finally {
      window.clearTimeout(guard);
      busy.current = false;
    }
  };

  const onConnect = async (wallet: TWalletInfo) => {
    if (busy.current) {
      setError("A wallet request is already in progress — check your wallet.");
      return;
    }
    busy.current = true;
    setError(null);
    setLoading(true);
    const guard = window.setTimeout(() => setLoading(false), HANG_MS);

    try {
      const response = await loginProvider.connect({ id: wallet.id });
      if (response.error) {
        setError(response.error);
        return;
      }
      if (response.identities.length === 0) {
        setError("No accounts were shared by the wallet.");
        return;
      }

      setIdentities(response.identities);
      setCurrentWallet(wallet);

      if (identitiesInterval) {
        clearInterval(identitiesInterval);
      }
      identitiesInterval = window.setInterval(async () => {
        const resp = await loginProvider.identities({});
        if (resp) {
          setIdentities(resp.identities);
        }
      }, 1000);
    } catch (err) {
      reportError("Couldn't connect to the wallet. Please try again.", err);
    } finally {
      window.clearTimeout(guard);
      busy.current = false;
      setLoading(false);
    }
  };

  const onBackToSelectWallet = () => {
    setError(null);
    setCurrentWallet(null);
  };

  useEffect(() => {
    let cancelled = false;
    const guard = window.setTimeout(() => setLoading(false), HANG_MS);
    (async () => {
      try {
        const resp = await loginProvider.init({});
        if (!cancelled) setWallets(resp.wallets);
      } catch (err) {
        if (!cancelled) reportError("Could not initialise wallets.", err);
      } finally {
        window.clearTimeout(guard);
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(guard);
    };
  }, [loginProvider]);

  const clientId = loginProvider.loginData.clientId;
  const metadata = loginProvider.loginData.metadata;
  const restrictions = loginProvider.loginData.restrictions;
  const origin = metadata?.app || clientId;
  return (
    <Grid container component="main" className={`${classes.root} ${className}`}>
      <CssBaseline />
      <Paper elevation={5} className={classes.paper}>
        {loading ? (
          <Loader />
        ) : currentWallet ? (
          <LoginPage
            origin={origin}
            identities={identities}
            restrictions={restrictions}
            wallet={currentWallet}
            error={error}
            onLogin={onLogin}
            onSelectWallet={onBackToSelectWallet}
            mode={loginPageMode}
            switchMode={setLoginPageMode}
          ></LoginPage>
        ) : (
          <ConnectWalletPage
            origin={origin}
            onConnect={onConnect}
            wallets={wallets}
            restrictions={restrictions}
            error={error}
            mode={walletPageMode}
            switchMode={setWalletPageMode}
          />
        )}
      </Paper>
    </Grid>
  );
};

export default App;
