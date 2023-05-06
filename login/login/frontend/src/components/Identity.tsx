import React from "react";

import { makeStyles, Theme } from "@material-ui/core/styles";
import Typography from "@material-ui/core/Typography";

import Grid from "@material-ui/core/Grid";
import { Avatar, Button, Paper, Tooltip } from "@material-ui/core";

import { IIdentity } from "../services/loginProvider";

const useStyles = makeStyles((theme: Theme) => {
  const identity = {
    paddingLeft: theme.spacing(1),
    paddingRight: theme.spacing(1),
    paddingTop: theme.spacing(1),
    paddingBottom: theme.spacing(2),
  };
  return {
    identityActive: {
      ...identity,
      cursor: "pointer",
    },
    identityInactive: {
      ...identity,
      opacity: 0.2,
      cursor: "not-allowed",
    },
    avatar: {
      width: theme.spacing(10),
      height: theme.spacing(10),
      marginBottom: theme.spacing(2),
    },
    name: {
      wordBreak: "break-all",
    },
    logmein: {
      marginTop: 10,
    },
    description: {},
    paper: { padding: 20 },
  };
});

export interface IdentityProps {
  identity: IIdentity;
  onClick: () => void;
}

export const Identity: React.FC<IdentityProps> = ({ identity, onClick }) => {
  const classes = useStyles();
  return (
    <Grid
      item
      container
      xs={12}
      sm={6}
      md={3}
      lg={2}
      className={
        identity.active ? classes.identityActive : classes.identityInactive
      }
      onClick={onClick}
    >
      <Grid item container>
        <Tooltip title={`Login with ${identity.name}`} arrow>
          <Paper elevation={3} className={classes.paper}>
            <Grid item container xs={12} justifyContent="center">
              <Avatar
                src={`https://my.cryptoverse.cc/profile/${identity.name}.png`}
                alt={identity.name}
                className={classes.avatar}
                variant="rounded"
              />
            </Grid>
            <Grid
              item
              container
              xs={12}
              justifyContent="center"
              className={classes.name}
            >
              <Typography>{identity.name}</Typography>
            </Grid>
            <Grid
              item
              container
              xs={12}
              justifyContent="center"
              className={classes.logmein}
            >
              <Button
                variant="contained"
                color="primary"
                disabled={!identity.active}
              >
                Select
              </Button>
            </Grid>
          </Paper>
        </Tooltip>
      </Grid>
    </Grid>
  );
};
