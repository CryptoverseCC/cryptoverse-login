import React from "react";
import { createRoot } from "react-dom/client";
import CssBaseline from "@material-ui/core/CssBaseline";
import { ThemeProvider } from "@material-ui/core/styles";
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
          loginProvider={loginProvider}
          walletProviders={walletProviders}
        />
      );
    default:
      return (
        <DefaultBackground
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
