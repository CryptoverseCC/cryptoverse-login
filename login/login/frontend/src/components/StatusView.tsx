import React, { useEffect, useRef } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { keyframes } from "@mui/material/styles";
import { monoFontFamily } from "../theme";
import { PageShell } from "./PageShell";

// The signature status choreography (spec §"Signature element"). One reusable
// surface backs every transient state of the flow — connecting, signing,
// redirecting, and a real terminal error — so the user always knows what is
// happening and what to do next.
//
// A lock/seal motif sits at the top: a vault shield with a padlock whose shackle
// is open while we wait, closes once a signature is requested, and shows a check
// (sealed) on redirect. Motion is purely decorative: the title, subtext and seal
// SHAPE always carry the meaning, so the calm pulse is the only thing gated
// behind `prefers-reduced-motion`.

export type StatusKind =
  | "loading"
  | "connecting"
  | "signing"
  | "redirecting"
  | "error";

export interface StatusViewProps {
  kind: StatusKind;
  title: string;
  subtext?: React.ReactNode;
  /** Mono detail line, e.g. "no transaction · no gas". */
  detail?: React.ReactNode;
  /** Optional action (e.g. "Try again") — rendered as a focusable button. */
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}

const pulse = keyframes({
  "0%, 100%": { transform: "scale(1)", opacity: 1 },
  "50%": { transform: "scale(1.04)", opacity: 0.85 },
});

const accentByKind: Record<StatusKind, "primary" | "success" | "error"> = {
  loading: "primary",
  connecting: "primary",
  signing: "primary",
  redirecting: "success",
  error: "error",
};

// The seal artwork. `color` is "currentColor" so it inherits the themed accent
// set on the wrapper; shape changes encode state (no reliance on motion).
const Seal: React.FC<{ kind: StatusKind }> = ({ kind }) => {
  const closed = kind === "signing" || kind === "redirecting";
  const sealed = kind === "redirecting";
  const shackle = closed
    ? "M22 30 V24 a10 10 0 0 1 20 0 V30"
    : "M22 30 V24 a10 10 0 0 1 20 0 V20";
  return (
    <svg
      width={88}
      height={88}
      viewBox="0 0 64 70"
      fill="none"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      {/* Vault shield */}
      <path
        d="M32 3 L57 12 V34 C57 50 46 60 32 66 C18 60 7 50 7 34 V12 Z"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        fill="rgba(124,108,240,0.06)"
      />
      {/* Padlock shackle */}
      <path
        d={shackle}
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        fill="none"
      />
      {/* Padlock body */}
      <rect
        x="20"
        y="30"
        width="24"
        height="18"
        rx="4"
        fill="currentColor"
        fillOpacity={sealed ? 0.95 : 0.85}
      />
      {/* Keyhole, or a check once sealed */}
      {sealed ? (
        <path
          d="M27 39 L31 43 L38 35"
          stroke="#08130E"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      ) : (
        <>
          <circle cx="32" cy="38" r="2.5" fill="#0B1020" />
          <rect x="31" y="38" width="2" height="6" rx="1" fill="#0B1020" />
        </>
      )}
    </svg>
  );
};

export const StatusView: React.FC<StatusViewProps> = ({
  kind,
  title,
  subtext,
  detail,
  actionLabel,
  onAction,
  className,
}) => {
  const accentKey = accentByKind[kind];
  const animate = kind !== "error" && kind !== "redirecting";
  const liveStatus = kind === "error" ? "assertive" : "polite";

  // On a terminal error, move keyboard focus to the action ("Try again") button
  // so the recovery path is immediately reachable without hunting for it.
  const actionRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (kind === "error") actionRef.current?.focus();
  }, [kind]);

  return (
    <PageShell align="center" className={className}>
      <Box
        role="status"
        aria-live={liveStatus}
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          gap: 2,
          px: { xs: 3, sm: 5 },
          py: 6,
        }}
      >
      <Box
        sx={(theme) => ({
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 132,
          height: 132,
          borderRadius: "50%",
          color:
            accentKey === "success"
              ? theme.palette.success.main
              : accentKey === "error"
              ? theme.palette.error.main
              : theme.palette.primary.main,
          // A soft radial glow behind the seal — the one flourish.
          background: `radial-gradient(circle at 50% 45%, ${theme.palette.vault.glow} 0%, transparent 70%)`,
          "& svg": {
            display: "block",
            animation: animate ? `${pulse} 2.4s ease-in-out infinite` : "none",
          },
          "@media (prefers-reduced-motion: reduce)": {
            "& svg": { animation: "none" },
          },
        })}
      >
        <Seal kind={kind} />
      </Box>

      <Typography
        variant="h2"
        component="h1"
        sx={{ color: "text.primary", maxWidth: 380 }}
      >
        {title}
      </Typography>

      {subtext && (
        <Typography
          variant="body1"
          sx={{ color: "text.secondary", maxWidth: 380 }}
        >
          {subtext}
        </Typography>
      )}

      {detail && (
        <Typography
          component="p"
          sx={{
            fontFamily: monoFontFamily,
            color: "text.disabled",
            fontSize: "0.75rem",
            letterSpacing: "0.04em",
          }}
        >
          {detail}
        </Typography>
      )}

      {actionLabel && onAction && (
        <Button
          ref={actionRef}
          variant="contained"
          color="primary"
          onClick={onAction}
          sx={{ mt: 1 }}
        >
          {actionLabel}
        </Button>
      )}
      </Box>
    </PageShell>
  );
};

export default StatusView;
