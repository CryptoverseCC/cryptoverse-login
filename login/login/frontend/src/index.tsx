import React from "react";
import { createRoot } from "react-dom/client";
import { lazy } from "react";
import CssBaseline from "@material-ui/core/CssBaseline";
import { ThemeProvider } from "@material-ui/core/styles";
//import reportWebVitals from "./reportWebVitals";
import theme from "./theme";
import {
  LoginProvider,
  loginData,
  ILoginProvider,
} from "./services/loginProvider";
import { walletProviders } from "./providers";
import { Background as FwBBackground } from "./backgrounds/FwB";
import { Background as DefaultBackground } from "./backgrounds/Default";
import { ProviderList } from "./components/ConnectWalletPage";

const provider = LoginProvider(null);

interface BackgroundProps {
  loginProvider: ILoginProvider;
  walletProviders: ProviderList;
}

const Background: React.FC<BackgroundProps> = ({
  loginProvider,
  walletProviders,
}) => {
  switch (loginData.clientId) {
    case "fwb.cryptoverse.cc":
      return (
        <FwBBackground
          AppComponent={lazy(() => import("./App"))}
          loginProvider={loginProvider}
          walletProviders={walletProviders}
        />
      );
    default:
      return (
        <DefaultBackground
          AppComponent={lazy(() => import("./App"))}
          loginProvider={loginProvider}
          walletProviders={walletProviders}
        />
      );
  }
};

const container = document.getElementById("root");
const root = createRoot(container!); // createRoot(container!) if you use TypeScript
root.render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <Background loginProvider={provider} walletProviders={walletProviders} />
  </ThemeProvider>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
//reportWebVitals();
