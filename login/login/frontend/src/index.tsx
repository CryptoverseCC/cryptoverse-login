import React from "react";
import { createRoot } from "react-dom/client";
import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import theme from "./theme";
import { LoginProvider, ILoginProvider } from "./services/loginProvider";
import { Background as FwBBackground } from "./backgrounds/FwB";
import { Background as DefaultBackground } from "./backgrounds/Default";

const provider = LoginProvider(null);

interface BackgroundProps {
  loginProvider: ILoginProvider;
}

const Background: React.FC<BackgroundProps> = ({ loginProvider }) => {
  let origin =
    loginProvider.loginData.metadata?.app || loginProvider.loginData.clientId;
  switch (origin) {
    case "fwb.cryptoverse.cc":
      return <FwBBackground loginProvider={loginProvider} />;
    default:
      return <DefaultBackground loginProvider={loginProvider} />;
  }
};

const container = document.getElementById("root");
const root = createRoot(container!);
root.render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <Background loginProvider={provider} />
  </ThemeProvider>
);
