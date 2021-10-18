import React from "react";

import { makeStyles, Theme } from "@material-ui/core/styles";
import { Alert, AlertTitle } from "@material-ui/lab";

import { TRestrictions } from "../services/loginProvider";

const useStyles = makeStyles((theme: Theme) => {
  return {
    root: {},
  };
});

export interface RestrictionsProps {
  restrictions: TRestrictions;
}

export const Restrictions: React.FC<RestrictionsProps> = ({ restrictions }) => {
  const classes = useStyles();
  return (
    <div className={classes.root}>
      {restrictions.map((restriction) => (
        <Alert severity="info">
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
