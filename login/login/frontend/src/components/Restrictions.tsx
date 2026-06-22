import React from "react";

import { Theme } from "@mui/material/styles";
import { makeStyles } from "tss-react/mui";
import { Alert, AlertTitle } from "@mui/material";

import { TRestrictions } from "../services/loginProvider";

const useStyles = makeStyles()((theme: Theme) => {
  return {
    root: {},
  };
});

export interface RestrictionsProps {
  restrictions: TRestrictions;
}

export const Restrictions: React.FC<RestrictionsProps> = ({ restrictions }) => {
  const { classes } = useStyles();
  return (
    <div className={classes.root}>
      {restrictions.map((restriction, i) => (
        <Alert key={`${restriction.tokenAddress}-${restriction.condition}-${i}`} severity="info">
          <AlertTitle>Restricted access</AlertTitle>
          {restriction.message || (
            <>
              This app restricts login to{" "}
              <strong>{restriction.tokenAddress}</strong> token owners
              fulfilling condition: <strong>{restriction.condition}</strong>
            </>
          )}
        </Alert>
      ))}
    </div>
  );
};
