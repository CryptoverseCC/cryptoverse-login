import React, { useState } from "react";

import { makeStyles, Theme } from "@material-ui/core/styles";
import Typography from "@material-ui/core/Typography";
import { IProviderInfo } from "web3modal";

import Grid from "@material-ui/core/Grid";
import { Chip } from "@material-ui/core";

const useStyles = makeStyles((theme: Theme) => {
  const wallet = {
    paddingLeft: theme.spacing(1),
    paddingRight: theme.spacing(1),
    paddingTop: theme.spacing(1),
    paddingBottom: theme.spacing(2),
  };
  return {
    wallet,
    avatar: {
      width: theme.spacing(15),
      height: theme.spacing(15),
      marginBottom: theme.spacing(2),
    },
    walletActive: {
      ...wallet,
      cursor: "pointer",
    },
    walletDisabled: {
      ...wallet,
      cursor: "not-allowed",
      opacity: 0.2,
    },
    walletConnectStatus: {
      marginBottom: theme.spacing(2),
    },
  };
});

export interface WalletProps {
  active: boolean;
  provider: IProviderInfo;
  onClick: (provider: IProviderInfo) => void;
}

export const Wallet: React.FC<WalletProps> = (params) => {
  const { provider } = params;

  switch (provider.id) {
    case "walletconnect":
      return <WalletConnect {...params} />;
    default:
      return <Default {...params} />;
  }
};

const WalletConnect: React.FC<WalletProps> = ({
  active,
  provider,
  onClick,
}) => {
  const [fakeFlag, setFakeFlag] = useState(true);
  const wc = {
    isConnected: (): boolean => {
      return !!localStorage.getItem("walletconnect");
    },
    killSession: () => {
      localStorage.removeItem("walletconnect");
      setFakeFlag(!fakeFlag);
    },
  };
  const handleDisconnect = () => {
    wc.killSession();
  };
  const classes = useStyles();
  const isConnected = wc.isConnected();
  return (
    <Grid
      item
      container
      xs={12}
      sm={6}
      md={4}
      lg={3}
      className={active ? classes.walletActive : classes.walletDisabled}
      onClick={() => (active ? onClick(provider) : null)}
    >
      <Grid item container>
        <Grid item container xs={12} justifyContent="center">
          <img
            className={classes.avatar}
            src={provider.logo}
            alt={provider.name}
          ></img>
        </Grid>
        {isConnected && (
          <Grid item container xs={12} justifyContent="center">
            <Chip
              label="Connected"
              color="primary"
              variant="outlined"
              onDelete={handleDisconnect}
              className={classes.walletConnectStatus}
            />
          </Grid>
        )}
        <Grid item container xs={12} justifyContent="center">
          <Typography>{provider.name}</Typography>
          {provider.description ? (
            <Typography variant="caption">{provider.description}</Typography>
          ) : null}
        </Grid>
      </Grid>
    </Grid>
  );
};

const Default: React.FC<WalletProps> = ({ active, provider, onClick }) => {
  const classes = useStyles();
  return (
    <Grid
      item
      container
      xs={12}
      sm={6}
      md={4}
      lg={3}
      className={active ? classes.walletActive : classes.walletDisabled}
      onClick={() => (active ? onClick(provider) : null)}
    >
      <Grid item container>
        <Grid item container xs={12} justifyContent="center">
          <img
            className={classes.avatar}
            src={provider.logo}
            alt={provider.name}
          ></img>
        </Grid>
        <Grid item container xs={12} justifyContent="center">
          <Typography>{provider.name}</Typography>
          {provider.description ? (
            <Typography variant="caption">{provider.description}</Typography>
          ) : null}
        </Grid>
      </Grid>
    </Grid>
  );
};
