import React from "react";
import ReactDOM from "react-dom";
import CssBaseline from "@material-ui/core/CssBaseline";
import { ThemeProvider } from "@material-ui/core/styles";
import { App } from "./App";
import reportWebVitals from "./reportWebVitals";
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
          AppComponent={App}
          loginProvider={loginProvider}
          walletProviders={walletProviders}
        />
      );
    default:
      return (
        <DefaultBackground
          AppComponent={App}
          loginProvider={loginProvider}
          walletProviders={walletProviders}
        />
      );
  }
};

ReactDOM.render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <Background loginProvider={provider} walletProviders={walletProviders} />
  </ThemeProvider>,
  document.getElementById("root")
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
