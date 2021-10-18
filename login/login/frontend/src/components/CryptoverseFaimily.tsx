import React from "react";

import Grid from "@material-ui/core/Grid";
import { makeStyles, Theme } from "@material-ui/core/styles";
import Typography from "@material-ui/core/Typography";
import { Divider } from "@material-ui/core";

const useStyles = makeStyles((theme: Theme) => ({
  divider: {
    marginTop: 10,
    marginBottom: 10,
  },
  help: {
    [theme.breakpoints.up("sm")]: {
      padding: theme.spacing(3),
    },
    [theme.breakpoints.down("sm")]: {
      padding: theme.spacing(1),
    },
  },
  helpText: {
    [theme.breakpoints.up("sm")]: {
      padding: theme.spacing(3),
    },
    [theme.breakpoints.down("sm")]: {
      padding: theme.spacing(1),
    },
  },
}));

export interface CryptoverseFamilyProps {}

export const CryptoverseFamily: React.FC<CryptoverseFamilyProps> = () => {
  const classes = useStyles();
  return (
    <Grid key={"family"} item container xs={12}>
      <Grid key={"divider"} item xs={12} className={classes.divider}>
        <Divider />
      </Grid>
      <Grid key={"header"} item container xs={12} justify="center">
        <Typography variant="h6">Cryptoverse Family</Typography>
      </Grid>
      <Grid key={"items"} item container xs={12} className={classes.help}>
        <Typography className={classes.helpText}>
          <a target="_blank" rel="noreferrer" href="https://cryptoauth.io/">
            Cryptoauth.io
          </a>{" "}
          belongs to{" "}
          <a target="_blank" rel="noreferrer" href="https://cryptoverse.cc/">
            Cryptoverse Family
          </a>{" "}
          together with:
          <div>
            <ul>
              <li>
                <a target="_blank" rel="noreferrer" href="https://ethmail.cc/">
                  ETHMail.cc
                </a>{" "}
                - Email services for Ethereum community
              </li>
              <li>
                <a target="_blank" rel="noreferrer" href="https://calleth.me/">
                  CallETH.me
                </a>{" "}
                - Communication platform for Ethereum community (Voice and Video
                calls, instant messaging)
              </li>
            </ul>
          </div>
        </Typography>
      </Grid>
    </Grid>
  );
};
