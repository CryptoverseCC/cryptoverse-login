import React from "react";

import { Theme } from "@mui/material/styles";
import { makeStyles } from "tss-react/mui";
import Typography from "@mui/material/Typography";
import Grid from "@mui/material/GridLegacy";
import AccountBalanceWalletIcon from "@mui/icons-material/AccountBalanceWallet";
import { TWalletInfo } from "../services/loginProvider";

const useStyles = makeStyles()((theme: Theme) => ({
  wallet: {
    paddingLeft: theme.spacing(1),
    paddingRight: theme.spacing(1),
    paddingTop: theme.spacing(1),
    paddingBottom: theme.spacing(2),
    cursor: "pointer",
  },
  avatar: {
    width: theme.spacing(15),
    height: theme.spacing(15),
    marginBottom: theme.spacing(2),
    objectFit: "contain",
  },
}));

export interface WalletProps {
  wallet: TWalletInfo;
  onClick: (wallet: TWalletInfo) => void;
}

export const Wallet: React.FC<WalletProps> = ({ wallet, onClick }) => {
  const { classes } = useStyles();
  return (
    <Grid
      item
      container
      xs={12}
      sm={6}
      md={4}
      lg={3}
      className={classes.wallet}
      onClick={() => onClick(wallet)}
    >
      <Grid item container>
        <Grid item container xs={12} justifyContent="center">
          {wallet.logo ? (
            <img className={classes.avatar} src={wallet.logo} alt={wallet.name} />
          ) : (
            <AccountBalanceWalletIcon
              className={classes.avatar}
              color="action"
            />
          )}
        </Grid>
        <Grid item container xs={12} justifyContent="center">
          <Typography>{wallet.name}</Typography>
        </Grid>
      </Grid>
    </Grid>
  );
};

export default Wallet;
