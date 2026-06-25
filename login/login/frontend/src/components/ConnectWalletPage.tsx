import React from "react";

import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { IconButton, Alert } from "@mui/material";

import { Wallet } from "./Wallet";
import { Nav } from "./Nav";
import { Restrictions } from "./Restrictions";
import { Reassurance } from "./Reassurance";
import { PageShell } from "./PageShell";
import BrandMark from "./BrandMark";
import { TRestrictions, TWalletInfo } from "../services/loginProvider";
import { CryptoverseFamily } from "./CryptoverseFamily";

import metamaskImage from "./images/metamask.png";
import operaImage from "./images/opera.png";
import othersImage from "./images/others.png";

export enum Modes {
  SELECT = "select",
  HELP = "help",
}

export interface ConnectWalletPageProps {
  onConnect: (wallet: TWalletInfo) => void;
  wallets: TWalletInfo[];
  restrictions?: TRestrictions;
  origin: string;
  error?: string | null;
  mode: Modes;
  switchMode: (mode: Modes) => void;
}

export const ConnectWalletPage: React.FC<ConnectWalletPageProps> = ({
  onConnect,
  wallets,
  restrictions,
  origin,
  error,
  mode,
  switchMode,
}) => {
  if (mode === Modes.HELP) {
    return (
      <PageShell align="top">
        <AppBar position="static">
          <Toolbar>
            <IconButton
              onClick={() => switchMode(Modes.SELECT)}
              edge="start"
              sx={{ mr: 2 }}
              aria-label="Back to wallet selection"
            >
              <ArrowBackIcon />
            </IconButton>
            <Typography variant="subtitle1" sx={{ flexGrow: 1 }}>
              Choosing a wallet
            </Typography>
          </Toolbar>
        </AppBar>

        <Box
          sx={{
            p: { xs: 2, sm: 4 },
            textAlign: "left",
          }}
        >
          <Typography variant="body1" sx={{ mb: 2, color: "text.secondary" }}>
            Pick the wallet you want to use to sign in to {origin}. If you have a
            browser-extension wallet (MetaMask, Rabby, …) or a mobile wallet with
            a built-in browser, it should appear in the list — select it.
          </Typography>

          <Box
            sx={{
              display: "flex",
              gap: 2,
              flexWrap: "wrap",
              justifyContent: "center",
              my: 2,
            }}
          >
            <Box
              component="img"
              src={metamaskImage}
              loading="lazy"
              alt="MetaMask wallet"
              sx={{ maxWidth: { xs: "45%", sm: "30%" }, borderRadius: 1 }}
            />
            <Box
              component="img"
              src={operaImage}
              loading="lazy"
              alt="Opera wallet"
              sx={{ maxWidth: { xs: "45%", sm: "30%" }, borderRadius: 1 }}
            />
          </Box>

          <Typography variant="body1" sx={{ mb: 2, color: "text.secondary" }}>
            No wallet in your browser? Use WalletConnect to pair a mobile wallet
            by scanning a QR code, or use Coinbase Wallet.
          </Typography>

          <Box sx={{ display: "flex", justifyContent: "center", my: 2 }}>
            <Box
              component="img"
              src={othersImage}
              loading="lazy"
              alt="WalletConnect and other wallets"
              sx={{ maxWidth: { xs: "60%", sm: "30%" }, borderRadius: 1 }}
            />
          </Box>

          <CryptoverseFamily />
        </Box>
      </PageShell>
    );
  }

  return (
    <PageShell align="top">
      <AppBar position="static">
        <Toolbar>
          <Nav origin={origin}>
            <Typography color="text.secondary">Choose a wallet</Typography>
          </Nav>
          <Box sx={{ flexGrow: 1 }} />
          <IconButton
            onClick={() => switchMode(Modes.HELP)}
            aria-label="How to choose a wallet"
          >
            <HelpOutlineIcon />
          </IconButton>
        </Toolbar>
      </AppBar>

      <Box
        sx={{
          p: { xs: 3, sm: 4 },
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 3,
        }}
      >
        <BrandMark size={28} />

        <Box sx={{ textAlign: "center" }}>
          <Typography variant="h1" component="h1" sx={{ mb: 0.5 }}>
            Sign in to {origin}
          </Typography>
          <Typography variant="body1" sx={{ color: "text.secondary" }}>
            Connect a wallet to continue.
          </Typography>
        </Box>

        {error && (
          <Alert severity="warning" variant="standard" sx={{ width: "100%" }}>
            {error}
          </Alert>
        )}

        {restrictions && restrictions.length > 0 && (
          <Box sx={{ width: "100%" }}>
            <Restrictions restrictions={restrictions} />
          </Box>
        )}

        {wallets.length === 0 ? (
          <Alert severity="info" variant="standard" sx={{ width: "100%" }}>
            No wallet detected. Install a browser wallet (for example MetaMask or
            Rabby), or use WalletConnect to connect a mobile wallet.
          </Alert>
        ) : (
          // A flat flex row, not MUI Grid: the <Wallet> tiles (owned by Agent C)
          // already provide their own responsive cell, so this only needs to
          // wrap and center them. Off GridLegacy here, per the redesign spec.
          <Box
            sx={{
              width: "100%",
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "center",
            }}
          >
            {wallets.map((wallet) => (
              <Wallet key={wallet.id} onClick={onConnect} wallet={wallet} />
            ))}
          </Box>
        )}

        <Reassurance />
      </Box>
    </PageShell>
  );
};

export default ConnectWalletPage;
