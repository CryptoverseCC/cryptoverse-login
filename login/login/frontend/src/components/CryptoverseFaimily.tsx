import React from "react";

import { Theme } from "@mui/material/styles";
import { makeStyles } from "tss-react/mui";
import Typography from "@mui/material/Typography";
import { Box, Divider, Link, Stack } from "@mui/material";

const useStyles = makeStyles()((theme: Theme) => ({
  root: {
    width: "100%",
  },
  divider: {
    marginTop: theme.spacing(2),
    marginBottom: theme.spacing(2),
  },
  footer: {
    [theme.breakpoints.up("sm")]: {
      padding: theme.spacing(3),
    },
    [theme.breakpoints.down("sm")]: {
      padding: theme.spacing(2),
    },
  },
  heading: {
    marginBottom: theme.spacing(1.5),
  },
  list: {
    margin: 0,
    paddingLeft: theme.spacing(2),
    listStyle: "none",
  },
  item: {
    "& + &": {
      marginTop: theme.spacing(1),
    },
  },
}));

const FAMILY = [
  {
    name: "ETHMail.cc",
    href: "https://ethmail.cc/",
    desc: "Email for the Ethereum community.",
  },
  {
    name: "CallETH.me",
    href: "https://calleth.me/",
    desc: "Voice, video, and messaging for the Ethereum community.",
  },
];

export interface CryptoverseFamilyProps {}

export const CryptoverseFamily: React.FC<CryptoverseFamilyProps> = () => {
  const { classes } = useStyles();
  return (
    <Box className={classes.root}>
      <Box className={classes.divider}>
        <Divider />
      </Box>
      <Box className={classes.footer}>
        <Stack spacing={1.5}>
          <Typography
            variant="subtitle2"
            color="text.secondary"
            className={classes.heading}
          >
            Part of the{" "}
            <Link
              href="https://cryptoverse.cc/"
              target="_blank"
              rel="noreferrer"
            >
              Cryptoverse Family
            </Link>{" "}
            — along with{" "}
            <Link
              href="https://cryptoauth.io/"
              target="_blank"
              rel="noreferrer"
            >
              Cryptoauth.io
            </Link>
            .
          </Typography>
          <ul className={classes.list}>
            {FAMILY.map((entry) => (
              <li key={entry.name} className={classes.item}>
                <Typography variant="body2" component="span">
                  <Link href={entry.href} target="_blank" rel="noreferrer">
                    {entry.name}
                  </Link>{" "}
                  <Typography
                    component="span"
                    variant="body2"
                    color="text.secondary"
                  >
                    — {entry.desc}
                  </Typography>
                </Typography>
              </li>
            ))}
          </ul>
        </Stack>
      </Box>
    </Box>
  );
};

export default CryptoverseFamily;
