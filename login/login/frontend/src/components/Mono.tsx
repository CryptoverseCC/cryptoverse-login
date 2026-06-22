import React from "react";
import { styled } from "@mui/material/styles";
import { monoFontFamily } from "../theme";

// `<Mono>` renders technical strings (Ethereum addresses, hashes, the
// "gas: none / tx: none" status detail) in the shared JetBrains Mono stack so
// the address — which IS the identity — gets typographic care across the app.
const Mono = styled("span")(() => ({
  fontFamily: monoFontFamily,
  fontFeatureSettings: '"tnum" 1, "zero" 1',
  letterSpacing: "0.01em",
}));

export default Mono;

// Truncate a 0x address to the tidy seal form `0x6b9f…a3e2`.
//   head: hex chars kept after `0x` (default 4)
//   tail: hex chars kept at the end (default 4)
// Uses a real ellipsis (U+2026). Non-address / short input is returned as-is.
export function truncateAddress(
  address: string | null | undefined,
  head = 4,
  tail = 4
): string {
  if (!address) return "";
  const value = address.trim();
  // Only truncate things that look like a 0x-prefixed hex address and are
  // long enough that truncation actually shortens them.
  if (!/^0x[0-9a-fA-F]+$/.test(value)) return value;
  if (value.length <= 2 + head + tail + 1) return value;
  return `${value.slice(0, 2 + head)}…${value.slice(-tail)}`;
}
