import React from "react";

import { makeStyles, Theme } from "@material-ui/core/styles";

const useStyles = makeStyles((theme: Theme) => {
  return {
    loader: {
      position: "relative",
      left: "50%",
      top: "50%",
      zIndex: 1,
      width: 120,
      height: 120,
      margin: "0 0 0 -76px",
      border: "16px solid #f3f3f3",
      borderRadius: "50%",
      borderTop: `16px solid ${theme.palette.primary.main}`,
      animation: "$spin 2s linear infinite",
    },
    "@keyframes spin": {
      "0%": { transform: "rotate(0deg)" },
      "100%": { transform: "rotate(360deg)" },
    },
  };
});

export interface LoaderProps {}

export const Loader: React.FC<LoaderProps> = () => {
  let classes = useStyles();
  return <div className={classes.loader} role="progressbar"></div>;
};
