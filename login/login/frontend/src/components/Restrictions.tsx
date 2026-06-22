import React from "react";

import { Theme } from "@mui/material/styles";
import { makeStyles } from "tss-react/mui";
import { Alert, AlertTitle } from "@mui/material";

import { TRestriction, TRestrictions } from "../services/loginProvider";
import Mono, { truncateAddress } from "./Mono";

const useStyles = makeStyles()((theme: Theme) => {
  return {
    root: {
      display: "flex",
      flexDirection: "column",
      gap: theme.spacing(1.5),
      width: "100%",
    },
  };
});

// Shared copy for the generated (no custom `message`) requirement sentence,
// split around the token address. The banner renders the address in <Mono>;
// the Identity card inlines it as plain text — but both compose the same
// wording from these pieces, so the card and the banner never diverge.
const GENERATED_REASON_PREFIX = "This app is open to holders of token ";
const GENERATED_REASON_SUFFIX =
  ". Connect a wallet that meets the requirement to sign in.";

// Concise fallback for the Identity card when an app gates with several
// (messageless) requirements at once — the banner still lists each in full.
const MULTIPLE_REQUIREMENTS_REASON =
  "Doesn't meet this app's requirements.";

// The on-voice requirement sentence for a single restriction, as plain text:
// the client's custom `message` verbatim, else the generated sentence with the
// token address truncated to its seal form. Used by the Identity card.
function singleRestrictionReason(restriction: TRestriction): string {
  return (
    restriction.message ||
    `${GENERATED_REASON_PREFIX}${truncateAddress(
      restriction.tokenAddress
    )}${GENERATED_REASON_SUFFIX}`
  );
}

/**
 * Derive a single per-app reason string for an inactive (token-gated) identity,
 * agreeing with the {@link Restrictions} banner. Priority:
 *  - a custom `message` (the first one present), used verbatim;
 *  - otherwise, for one restriction, the generated requirement sentence;
 *  - for several messageless requirements, a concise generic line.
 * Returns `undefined` when there are no restrictions so callers fall back to
 * their own default copy.
 */
export function restrictionReason(
  restrictions: TRestrictions | undefined
): string | undefined {
  if (!restrictions || restrictions.length === 0) return undefined;
  const withMessage = restrictions.find((r) => r.message);
  if (withMessage) return withMessage.message;
  if (restrictions.length === 1) return singleRestrictionReason(restrictions[0]);
  return MULTIPLE_REQUIREMENTS_REASON;
}

export interface RestrictionsProps {
  restrictions: TRestrictions;
}

export const Restrictions: React.FC<RestrictionsProps> = ({ restrictions }) => {
  const { classes } = useStyles();
  return (
    <div className={classes.root}>
      {restrictions.map((restriction, i) => (
        <Alert
          key={`${restriction.tokenAddress}-${restriction.condition}-${i}`}
          severity="info"
          icon={false}
        >
          <AlertTitle>Token-gated app</AlertTitle>
          {restriction.message || (
            <>
              {GENERATED_REASON_PREFIX}
              <Mono>{truncateAddress(restriction.tokenAddress)}</Mono>
              {GENERATED_REASON_SUFFIX}
            </>
          )}
        </Alert>
      ))}
    </div>
  );
};

export default Restrictions;
