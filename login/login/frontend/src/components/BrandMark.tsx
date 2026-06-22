import React from "react";
import Box from "@mui/material/Box";
import { vault } from "../theme";

export type BrandMarkVariant = "full" | "mark";

export interface BrandMarkProps {
  /** Glyph height in px (the wordmark scales relative to it). Default 28. */
  size?: number;
  /** "full" = diamond glyph + "Cryptoverse" wordmark; "mark" = glyph only. */
  variant?: BrandMarkVariant;
  /** Accent color for the diamond glyph. Defaults to the Vault accent. */
  color?: string;
  className?: string;
}

// The Vault brand: a ◈ diamond glyph in the accent + a "Cryptoverse" wordmark
// set in Space Grotesk. Pure inline SVG + text — no binary asset.
const BrandMark: React.FC<BrandMarkProps> = ({
  size = 28,
  variant = "full",
  color = vault.primary,
  className,
}) => {
  const glyph = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label="Cryptoverse"
      focusable="false"
    >
      {/* Outer diamond outline */}
      <path
        d="M12 2 L22 12 L12 22 L2 12 Z"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        fill="none"
      />
      {/* Inner facet — the ◈ "vault" mark */}
      <path
        d="M12 7 L17 12 L12 17 L7 12 Z"
        fill={color}
        fillOpacity={0.9}
      />
    </svg>
  );

  if (variant === "mark") {
    return (
      <Box
        component="span"
        className={className}
        sx={{ display: "inline-flex", alignItems: "center", lineHeight: 0 }}
      >
        {glyph}
      </Box>
    );
  }

  return (
    <Box
      component="span"
      className={className}
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: `${Math.round(size * 0.32)}px`,
        lineHeight: 1,
      }}
    >
      {glyph}
      <Box
        component="span"
        sx={(theme) => ({
          fontFamily: theme.typography.h1.fontFamily,
          fontWeight: 700,
          fontSize: `${Math.round(size * 0.7)}px`,
          letterSpacing: "-0.01em",
          color: theme.palette.text.primary,
        })}
      >
        Cryptoverse
      </Box>
    </Box>
  );
};

export default BrandMark;
