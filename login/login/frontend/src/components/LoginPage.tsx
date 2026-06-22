import React from "react";

import { IconButton, Alert } from "@mui/material";
import AppBar from "@mui/material/AppBar";
import Box from "@mui/material/Box";
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
import { Restrictions, restrictionReason } from "./Restrictions";
import { Reassurance } from "./Reassurance";
import { PageShell } from "./PageShell";
import { CryptoverseFamily } from "./CryptoverseFaimily";

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
  // One per-app reason, shared with the <Restrictions> banner so a gated
  // identity card and the banner always tell the same story. `undefined` (no
  // restrictions) lets <Identity> keep its own default copy.
  const reason = restrictionReason(restrictions);

  if (mode === Modes.HELP) {
    return (
      <PageShell align="top">
        <AppBar position="static">
          <Toolbar>
            <IconButton
              onClick={() => switchMode(Modes.SELECT)}
              edge="start"
              sx={{ mr: 2 }}
              aria-label="Back to address selection"
            >
              <ArrowBackIcon />
            </IconButton>
            <Typography variant="subtitle1" sx={{ flexGrow: 1 }}>
              Choosing an address
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
            Choose which address you want to use as your identity to sign in to{" "}
            {origin}. Select an address and you&rsquo;ll be asked to sign a
            message to prove you own it. Once signed, you&rsquo;ll be taken back
            to {origin}.
          </Typography>

          <CryptoverseFamily />
        </Box>
      </PageShell>
    );
  }

  return (
    <PageShell align="top">
      <AppBar position="static">
        <Toolbar>
          <IconButton
            onClick={onSelectWallet}
            edge="start"
            sx={{ mr: 2 }}
            aria-label="Back to wallet selection"
          >
            <ArrowBackIcon />
          </IconButton>
          <Typography variant="subtitle1" sx={{ flexGrow: 1 }}>
            {wallet.name}
          </Typography>
          <IconButton
            onClick={() => switchMode(Modes.HELP)}
            aria-label="How to choose an address"
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
        <Box sx={{ textAlign: "center" }}>
          <Typography variant="h1" component="h1" sx={{ mb: 0.5 }}>
            Choose an address
          </Typography>
          <Typography variant="body1" sx={{ color: "text.secondary" }}>
            Pick the address to sign in to {origin} with.
          </Typography>
        </Box>

        {restrictions && restrictions.length > 0 && (
          <Box sx={{ width: "100%" }}>
            <Restrictions restrictions={restrictions} />
          </Box>
        )}

        {error && (
          <Alert severity="warning" variant="standard" sx={{ width: "100%" }}>
            {error}
          </Alert>
        )}

        {/* Flat flex row, not MUI Grid: the <Identity> cards (owned by Agent C)
            already provide their own responsive cell, so this only wraps and
            centers them. Off GridLegacy here, per the redesign spec. */}
        <Box
          sx={{
            width: "100%",
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
          }}
        >
          {identities.map((identity) => (
            <Identity
              key={identity.name}
              onClick={() => onLogin({ address: identity.name })}
              identity={identity}
              restrictionReason={reason}
            />
          ))}
        </Box>

        <Reassurance />
      </Box>
    </PageShell>
  );
};

export default LoginPage;
