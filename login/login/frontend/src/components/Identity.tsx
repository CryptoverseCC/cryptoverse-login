import React from "react";

import { Theme } from "@mui/material/styles";
import { makeStyles } from "tss-react/mui";
import Typography from "@mui/material/Typography";

import { Box, Button, ButtonBase, Chip, Tooltip } from "@mui/material";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import { useId } from "react";

import { IIdentity } from "../services/loginProvider";
import Mono, { truncateAddress } from "./Mono";
import { vault } from "../theme";

// A deterministic, dependency-free gradient avatar derived from the address —
// always renders (unlike the old my.cryptoverse.cc profile URL, which 404s for
// most addresses) and is visually unique per account. The raw address bytes
// pick three hues which we blend with the Vault accent so every avatar reads as
// part of the same palette rather than arbitrary web colors.
function gradientAvatar(address: string): string {
  const a = address.toLowerCase().replace(/^0x/, "").padEnd(40, "0");
  const hue = (slice: string) => parseInt(slice || "0", 16) % 360;
  const h1 = hue(a.slice(0, 4));
  const h2 = (h1 + 40 + hue(a.slice(8, 12)) / 6) % 360;
  // Muted, slightly desaturated tones so the chip sits calmly in the dark UI.
  const c1 = `hsl(${h1}, 55%, 52%)`;
  const c2 = `hsl(${h2}, 50%, 42%)`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="${c1}"/>` +
    `<stop offset="100%" stop-color="${c2}"/></linearGradient>` +
    `<radialGradient id="s" cx="0.3" cy="0.25" r="0.9">` +
    `<stop offset="0%" stop-color="${vault.primaryLight}" stop-opacity="0.35"/>` +
    `<stop offset="100%" stop-color="${vault.primary}" stop-opacity="0"/>` +
    `</radialGradient></defs>` +
    `<rect width="80" height="80" rx="16" fill="url(#g)"/>` +
    `<rect width="80" height="80" rx="16" fill="url(#s)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const useStyles = makeStyles()((theme: Theme) => {
  return {
    // Self-sizing flex cell: sits directly inside the screen's plain
    // `display:flex; flexWrap:wrap` row (no Grid container / negative margins).
    // The padding is the gutter; `box-sizing: border-box` keeps the declared
    // flex-basis honest. The screen now lives inside a narrow, centred PageShell
    // column (≈480px) at every viewport width, so each identity gets its own
    // full-width row — legible, with room for the ENS name, address chip and
    // CTA — rather than collapsing to a cramped fraction at desktop widths.
    cell: {
      boxSizing: "border-box",
      padding: theme.spacing(1),
      flexGrow: 0,
      flexShrink: 0,
      flexBasis: "100%",
      maxWidth: "100%",
    },
    card: {
      width: "100%",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: theme.spacing(1.5),
      padding: theme.spacing(3, 2),
      borderRadius: theme.shape.borderRadius,
      backgroundColor: theme.palette.surface.main,
      border: `1px solid ${theme.palette.hairline.main}`,
      boxShadow: theme.palette.vault.softShadow,
      textAlign: "center",
      transition: theme.transitions.create(
        ["border-color", "background-color", "transform"],
        { duration: 180 }
      ),
      "@media (prefers-reduced-motion: reduce)": {
        transition: "none",
        "&:hover": { transform: "none" },
      },
    },
    cardActive: {
      cursor: "pointer",
      "&:hover": {
        borderColor: theme.palette.primary.main,
        backgroundColor: theme.palette.surfaceRaised.main,
        transform: "translateY(-2px)",
      },
      "&:focus-visible": {
        outline: "none",
        borderColor: theme.palette.primary.main,
        boxShadow: `0 0 0 2px ${theme.palette.primary.main}`,
      },
    },
    // Inactive (token-gated) cards stay fully legible — no 0.2 opacity wash.
    // Muted via text.disabled + hairline, with an explicit lock + reason.
    cardInactive: {
      cursor: "not-allowed",
      borderStyle: "dashed",
      color: theme.palette.text.disabled,
    },
    avatarWrap: {
      position: "relative",
      width: theme.spacing(8),
      height: theme.spacing(8),
    },
    avatar: {
      width: "100%",
      height: "100%",
      borderRadius: theme.shape.borderRadius,
      display: "block",
    },
    avatarMuted: {
      filter: "grayscale(0.7)",
      opacity: 0.6,
    },
    lockBadge: {
      position: "absolute",
      right: -6,
      bottom: -6,
      width: theme.spacing(3),
      height: theme.spacing(3),
      borderRadius: "50%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.palette.surfaceRaised.main,
      border: `1px solid ${theme.palette.hairline.main}`,
      color: theme.palette.text.secondary,
    },
    lockIcon: {
      fontSize: 14,
    },
    ens: {
      fontWeight: 600,
      wordBreak: "break-word",
    },
    addressChip: {
      maxWidth: "100%",
    },
    reason: {
      marginTop: theme.spacing(0.5),
    },
  };
});

export interface IdentityProps {
  identity: IIdentity;
  onClick: () => void;
  /**
   * Why an inactive identity can't be used. Shown inline on token-gated cards.
   * Optional — defaults to a plain, app-agnostic explanation so existing
   * callers keep working without passing it.
   */
  restrictionReason?: string;
}

const DEFAULT_RESTRICTION_REASON =
  "Doesn't meet this app's token requirement.";

export const Identity: React.FC<IdentityProps> = ({
  identity,
  onClick,
  restrictionReason = DEFAULT_RESTRICTION_REASON,
}) => {
  const { classes, cx } = useStyles();
  const active = identity.active;
  const ens = identity.ens || (identity.name.endsWith(".eth") ? identity.name : null);
  const address = identity.name;
  const short = truncateAddress(address);
  const label = ens || short;
  // Stable id so an inactive (token-gated) card's reason text can be associated
  // with the card via aria-describedby (the card itself carries the aria-label).
  const reasonId = useId();
  const select = () => {
    if (active) onClick();
  };

  const avatar = (
    <Box className={classes.avatarWrap}>
      <img
        src={gradientAvatar(address)}
        alt=""
        aria-hidden
        className={cx(classes.avatar, !active && classes.avatarMuted)}
      />
      {!active && (
        <Box className={classes.lockBadge} aria-hidden>
          <LockOutlinedIcon className={classes.lockIcon} />
        </Box>
      )}
    </Box>
  );

  const cardContent = (
    <>
      {avatar}

      {ens && (
        <Typography
          variant="subtitle1"
          className={classes.ens}
          color={active ? "text.primary" : "text.disabled"}
        >
          {ens}
        </Typography>
      )}

      <Chip
        size="small"
        variant="outlined"
        className={classes.addressChip}
        label={<Mono>{short}</Mono>}
        sx={{
          color: active ? "text.secondary" : "text.disabled",
          borderColor: "hairline.main",
        }}
      />

      {active ? (
        <Button
          variant="contained"
          color="primary"
          size="small"
          component="span"
          tabIndex={-1}
        >
          Sign in
        </Button>
      ) : (
        <Typography
          id={reasonId}
          variant="caption"
          color="text.disabled"
          className={classes.reason}
        >
          {restrictionReason}
        </Typography>
      )}
    </>
  );

  // Active: a real interactive element (ButtonBase → native <button>), so it is
  // keyboard/AT-focusable without a hand-rolled role/tabIndex/onKeyDown.
  // Inactive (token-gated): a non-interactive group that still announces what it
  // is (aria-label) and *why* it can't be used (aria-describedby → the reason).
  const card = active ? (
    <ButtonBase
      className={cx(classes.card, classes.cardActive)}
      aria-label={`Sign in with ${label}`}
      onClick={select}
      focusRipple
    >
      {cardContent}
    </ButtonBase>
  ) : (
    <div
      className={cx(classes.card, classes.cardInactive)}
      role="group"
      aria-disabled
      aria-label={`${label} — unavailable`}
      aria-describedby={reasonId}
    >
      {cardContent}
    </div>
  );

  return (
    <div className={classes.cell}>
      {active ? (
        <Tooltip title={`Sign in with ${label}`} arrow>
          {card}
        </Tooltip>
      ) : (
        card
      )}
    </div>
  );
};

export default Identity;
