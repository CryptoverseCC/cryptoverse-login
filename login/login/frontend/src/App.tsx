import React, { useEffect, useState } from "react";
import { makeStyles } from "@material-ui/core/styles";
import {
  ILoginProvider,
  TConnectRequest,
  TLoginRequest,
} from "./services/loginProvider";
import {
  Modes as ConnectWalletPageModes,
  ConnectWalletPage,
  ProviderList,
} from "./components/ConnectWalletPage";

import { injected, getProviderInfoByName, IProviderInfo } from "web3modal";
import { IIdentity } from "./services/loginProvider";
import { LoginPage, Modes as LoginPageModes } from "./components/LoginPage";
import { Loader } from "./components/Loader";
import { CssBaseline, Grid, Paper } from "@material-ui/core";

interface Window {
  Sentry: any;
}

const useStyles = makeStyles((theme) => ({
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
  walletProviders: ProviderList;
  className?: string;
}

const missingWallet = {
  provider: {
    ...injected.FALLBACK,
    name: "Wallet Not Detected",
  },
  active: false,
};

let identitiesInterval: number | null = null;

export const App: React.FC<AppProps> = ({
  loginProvider,
  walletProviders,
  className,
}) => {
  const classes = useStyles();
  const [injectedProvider, setInjectedProvider] = useState(missingWallet);
  const [currentProvider, setCurrentProvider] = useState(
    null as IProviderInfo | null
  );
  const [identities, setIdentities] = useState([] as IIdentity[]);
  const [loading, setLoading] = useState(true);
  const [walletPageMode, setWalletPageMode] = useState(
    ConnectWalletPageModes.SELECT
  );
  const [loginPageMode, setLoginPageMode] = useState(LoginPageModes.SELECT);

  const onLogin = async (request: TLoginRequest) => {
    setLoading(true);
    setTimeout(() => {
      // show screen again if login hangs
      setLoading(false);
    }, 60 * 1000);
    let resp = await loginProvider.login(request);
    if (!resp) {
      // TODO: Show error ???
      setLoading(false);
      return;
    }
    try {
      let { signature, csrf, challenge, address } = resp;

      localStorage.setItem("loginHistory", JSON.stringify([{
        address,
        wallet: currentProvider!.name
      }]));

      const addInput = (form: HTMLFormElement, name: string, value: string) => {
        const input = document.createElement("input");
        input.value = value;
        input.name = name;
        form.appendChild(input);
      };

      var form = document.createElement("form");

      form.method = "POST";
      form.action = "/login/process";

      addInput(form, "_csrf", csrf);
      addInput(form, "challenge", challenge);
      addInput(form, "address", address);
      addInput(form, "signature", signature);
      addInput(form, "response", "api");

      const loginResponse = await fetch(form.action, {
        method: form.method,
        body: new URLSearchParams([...(new FormData(form) as any)]),
      });

      const data = await loginResponse.json();

      setTimeout(() => {
        window.location.assign(data.redirect);
      }, 0);
    } catch (error) {
      const sentry = ((window as unknown) as Window).Sentry;
      sentry?.captureException(error);
      setLoading(false);
    }
  };

  const onConnect = async (request: TConnectRequest) => {
    setLoading(true);

    setTimeout(() => {
      // show screen again if login hangs
      setLoading(false);
    }, 60 * 1000);

    let response;

    try {
      response = await loginProvider.connect(request);
    } catch (error) {
      const sentry = ((window as unknown) as Window).Sentry;
      sentry?.captureException(error);
      setLoading(false);
      return;
    }

    if (!response) {
      setLoading(false);
      return;
    }

    try {
      debugger
      setIdentities(response.identities);
      setCurrentProvider(getProviderInfoByName(request.name));

      if (identitiesInterval) {
        clearInterval(identitiesInterval);
      }

      identitiesInterval = window.setInterval(async () => {
        let resp = await loginProvider.identities({});
        if (resp) {
          setIdentities(resp.identities);
        }
      }, 1000);
    } catch (error) {
      const sentry = ((window as unknown) as Window).Sentry;
      sentry?.captureException(error);
    }

    setLoading(false);
  };

  const onBackToSelectWallet = () => {
    setCurrentProvider(null);
  };

  useEffect(() => {
    setTimeout(async () => {
      setTimeout(() => {
        // show screen again if init hangs
        setLoading(false);
      }, 60 * 1000);

      let resp = null;
      try {
        resp = await loginProvider.init({});
      } catch (error) {
        const sentry = ((window as unknown) as Window).Sentry;
        sentry?.captureException(error); // TODO: wrap Sentry in some service eg. ErrorReporter
        setLoading(false);
        return;
      }
      let injectedProvider = resp.name
        ? {
            provider: getProviderInfoByName(resp.name),
            active: true,
          }
        : missingWallet;

      setInjectedProvider(injectedProvider);
      setLoading(false);
    }, 2000);
  }, []);

  let providers = [injectedProvider, ...walletProviders];
  let origin = loginProvider.loginData.clientId;
  let restrictions = loginProvider.loginData.restrictions;
  return (
    <Grid container component="main" className={`${classes.root} ${className}`}>
      <CssBaseline />
      <Paper elevation={5} className={classes.paper}>
        {loading ? (
          <Loader />
        ) : currentProvider ? (
          <LoginPage
            origin={origin}
            identities={identities}
            restrictions={restrictions}
            provider={currentProvider}
            onLogin={onLogin}
            onSelectWallet={onBackToSelectWallet}
            mode={loginPageMode}
            switchMode={setLoginPageMode}
          ></LoginPage>
        ) : (
          <ConnectWalletPage
            origin={origin}
            onConnect={onConnect}
            providers={providers}
            restrictions={restrictions}
            mode={walletPageMode}
            switchMode={setWalletPageMode}
          />
        )}
      </Paper>
    </Grid>
  );
};
