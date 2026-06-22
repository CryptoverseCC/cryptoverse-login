import React from "react";

import { Theme } from "@mui/material/styles";
import { makeStyles } from "tss-react/mui";
import Typography from "@mui/material/Typography";

import Grid from "@mui/material/GridLegacy";
import { Avatar, Button, Paper, Tooltip } from "@mui/material";

import { IIdentity } from "../services/loginProvider";

// A deterministic, dependency-free gradient avatar derived from the address —
// always renders (unlike the old my.cryptoverse.cc profile URL, which 404s for
// most addresses) and is visually unique per account.
function gradientAvatar(address: string): string {
  const a = address.toLowerCase().replace(/^0x/, "").padEnd(40, "0");
  const c1 = `#${a.slice(0, 6)}`;
  const c2 = `#${a.slice(10, 16)}`;
  const c3 = `#${a.slice(30, 36)}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="${c1}"/>` +
    `<stop offset="50%" stop-color="${c2}"/>` +
    `<stop offset="100%" stop-color="${c3}"/></linearGradient></defs>` +
    `<rect width="80" height="80" fill="url(#g)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const useStyles = makeStyles()((theme: Theme) => {
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
  const { classes } = useStyles();
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
                src={gradientAvatar(identity.name)}
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
