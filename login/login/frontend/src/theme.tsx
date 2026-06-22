import { createTheme } from "@mui/material/styles";

// ---------------------------------------------------------------------------
// Cryptoverse Login — "Vault" theme (dark, calm, institutional-modern).
//
// Single source of truth for palette / type / shape. Colors come verbatim from
// the shared design spec; do not improvise tokens here. Components consume them
// via the MUI ThemeProvider (tss-react `makeStyles` reads the same context), so
// custom tokens are exposed through module augmentation as first-class palette
// keys (e.g. `theme.palette.surface.main`, `theme.palette.hairline.main`).
// ---------------------------------------------------------------------------

// Raw Vault color tokens (spec §"Color tokens"). Kept as a named export so code
// that needs a literal (e.g. inline SVG fills, gradients) can reference them
// without reaching through the MUI palette.
export const vault = {
  base: "#0B1020",
  baseDeep: "#0E1426",
  surface: "#141A2E",
  surfaceRaised: "#1B2236",
  hairline: "#232B42",
  primary: "#7C6CF0",
  primaryHover: "#6A57EE",
  primaryLight: "#9A8DF5",
  glow: "rgba(124,108,240,0.18)",
  textPrimary: "#E8EAF2",
  textSecondary: "#8A92A6",
  textDisabled: "#565E73",
  success: "#34D399",
  warning: "#F5B544",
  error: "#F2545B",
  infoTint: "rgba(124,108,240,0.12)",
} as const;

// Shared mono stack for addresses / technical strings. `<Mono>` and any
// component that renders hashes/addresses should use this.
export const monoFontFamily =
  '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, "SFMono-Regular", "Menlo", "Consolas", monospace';

const displayFontFamily = '"Space Grotesk Variable", "Space Grotesk", "Inter Variable", system-ui, sans-serif';
const bodyFontFamily =
  '"Inter Variable", "Inter", system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

// The signature body background: subtle vertical gradient base -> baseDeep.
const bodyBackground = `linear-gradient(180deg, ${vault.base} 0%, ${vault.baseDeep} 100%)`;
const softShadow = "0 1px 2px rgba(0,0,0,0.45)";

// --- MUI type augmentation: register the extra Vault palette tokens. ---------
declare module "@mui/material/styles" {
  interface Palette {
    surface: Palette["primary"];
    surfaceRaised: Palette["primary"];
    hairline: Palette["primary"];
  }
  interface PaletteOptions {
    surface?: PaletteOptions["primary"];
    surfaceRaised?: PaletteOptions["primary"];
    hairline?: PaletteOptions["primary"];
  }
  // Extra single-value tokens that don't fit the {main, light, dark} shape
  // live under `palette.vault.*` (the one canonical access path).
  interface Palette {
    vault: {
      base: string;
      baseDeep: string;
      glow: string;
      infoTint: string;
      bodyBackground: string;
      softShadow: string;
    };
  }
  interface PaletteOptions {
    vault?: {
      base: string;
      baseDeep: string;
      glow: string;
      infoTint: string;
      bodyBackground: string;
      softShadow: string;
    };
  }
}

const theme = createTheme({
  palette: {
    mode: "dark",
    primary: {
      main: vault.primary,
      light: vault.primaryLight,
      dark: vault.primaryHover,
      contrastText: "#FFFFFF",
    },
    // Kept for back-compat: `backgrounds/Default.tsx` (agent C) reads
    // `palette.secondary.main`. Map it to the accent so nothing reads as stray.
    secondary: {
      main: vault.primaryLight,
      contrastText: "#FFFFFF",
    },
    success: { main: vault.success, contrastText: "#08130E" },
    warning: { main: vault.warning, contrastText: "#1A1206" },
    error: { main: vault.error, contrastText: "#1A0708" },
    info: { main: vault.primary, contrastText: "#FFFFFF" },
    surface: { main: vault.surface, light: vault.surfaceRaised, dark: vault.base },
    surfaceRaised: { main: vault.surfaceRaised },
    hairline: { main: vault.hairline },
    background: {
      default: vault.base,
      paper: vault.surface,
    },
    text: {
      primary: vault.textPrimary,
      secondary: vault.textSecondary,
      disabled: vault.textDisabled,
    },
    divider: vault.hairline,
    vault: {
      base: vault.base,
      baseDeep: vault.baseDeep,
      glow: vault.glow,
      infoTint: vault.infoTint,
      bodyBackground,
      softShadow,
    },
  },

  shape: {
    borderRadius: 12,
  },

  typography: {
    fontFamily: bodyFontFamily,
    h1: {
      fontFamily: displayFontFamily,
      fontSize: "1.5rem",
      fontWeight: 700,
      lineHeight: 1.25,
      letterSpacing: "-0.01em",
    },
    h2: {
      fontFamily: displayFontFamily,
      fontSize: "1.25rem",
      fontWeight: 600,
      lineHeight: 1.3,
      letterSpacing: "-0.01em",
    },
    h3: {
      fontFamily: displayFontFamily,
      fontSize: "1.125rem",
      fontWeight: 600,
      lineHeight: 1.35,
      letterSpacing: "-0.01em",
    },
    subtitle1: {
      fontFamily: bodyFontFamily,
      fontSize: "1rem",
      fontWeight: 600,
      lineHeight: 1.5,
    },
    subtitle2: {
      fontFamily: bodyFontFamily,
      fontSize: "0.875rem",
      fontWeight: 600,
      lineHeight: 1.5,
    },
    body1: {
      fontSize: "1rem",
      fontWeight: 400,
      lineHeight: 1.6,
    },
    body2: {
      fontSize: "0.875rem",
      fontWeight: 400,
      lineHeight: 1.55,
    },
    caption: {
      fontSize: "0.75rem",
      fontWeight: 400,
      lineHeight: 1.5,
      color: vault.textSecondary,
    },
    button: {
      fontFamily: bodyFontFamily,
      fontWeight: 600,
      textTransform: "none",
      letterSpacing: 0,
    },
  },

  components: {
    MuiCssBaseline: {
      styleOverrides: {
        ":root": {
          colorScheme: "dark",
        },
        body: {
          background: bodyBackground,
          backgroundAttachment: "fixed",
          color: vault.textPrimary,
          minHeight: "100vh",
          WebkitFontSmoothing: "antialiased",
          MozOsxFontSmoothing: "grayscale",
          textRendering: "optimizeLegibility",
        },
        // Selection picks up the accent.
        "::selection": {
          backgroundColor: "rgba(124,108,240,0.35)",
        },
      },
    },

    MuiPaper: {
      defaultProps: {
        // Avoid muddy dark-mode elevation overlays: lean on borders + a soft
        // shadow instead. Components should NOT pass `elevation`.
        elevation: 0,
      },
      styleOverrides: {
        root: {
          backgroundImage: "none",
          backgroundColor: vault.surface,
          border: `1px solid ${vault.hairline}`,
          boxShadow: softShadow,
        },
        // Disable the elevation-overlay brightening entirely.
        outlined: {
          border: `1px solid ${vault.hairline}`,
        },
      },
    },

    MuiButton: {
      defaultProps: {
        disableElevation: true,
      },
      styleOverrides: {
        root: {
          borderRadius: 10,
          textTransform: "none",
          fontWeight: 600,
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 16,
          paddingRight: 16,
        },
        containedPrimary: {
          backgroundColor: vault.primary,
          color: "#FFFFFF",
          "&:hover": {
            backgroundColor: vault.primaryHover,
          },
          "&.Mui-disabled": {
            backgroundColor: vault.surfaceRaised,
            color: vault.textDisabled,
          },
        },
        outlined: {
          borderColor: vault.hairline,
          color: vault.textPrimary,
          "&:hover": {
            borderColor: vault.primary,
            backgroundColor: "rgba(124,108,240,0.08)",
          },
        },
        text: {
          "&:hover": {
            backgroundColor: "rgba(124,108,240,0.08)",
          },
        },
      },
    },

    MuiAlert: {
      styleOverrides: {
        root: {
          borderRadius: 10,
          border: `1px solid ${vault.hairline}`,
          alignItems: "center",
        },
        // info => violet tint per spec (used for restriction / info alerts).
        standardInfo: {
          backgroundColor: vault.infoTint,
          border: `1px solid ${vault.hairline}`,
          color: vault.textPrimary,
        },
        standardWarning: {
          backgroundColor: "rgba(245,181,68,0.12)",
          border: "1px solid rgba(245,181,68,0.35)",
          color: vault.warning,
        },
        standardError: {
          backgroundColor: "rgba(242,84,91,0.12)",
          border: "1px solid rgba(242,84,91,0.35)",
          color: vault.error,
        },
        standardSuccess: {
          backgroundColor: "rgba(52,211,153,0.12)",
          border: "1px solid rgba(52,211,153,0.35)",
          color: vault.success,
        },
        icon: {
          alignItems: "center",
        },
      },
    },

    MuiAppBar: {
      defaultProps: {
        elevation: 0,
        color: "transparent",
      },
      styleOverrides: {
        root: {
          backgroundColor: vault.surface,
          backgroundImage: "none",
          borderBottom: `1px solid ${vault.hairline}`,
          boxShadow: "none",
          color: vault.textPrimary,
        },
      },
    },

    MuiToolbar: {
      styleOverrides: {
        root: {
          backgroundColor: vault.surface,
        },
      },
    },

    MuiIconButton: {
      styleOverrides: {
        root: {
          borderRadius: 10,
          color: vault.textSecondary,
          "&:hover": {
            backgroundColor: "rgba(124,108,240,0.10)",
            color: vault.textPrimary,
          },
        },
      },
    },

    MuiCircularProgress: {
      defaultProps: {
        color: "primary",
      },
      styleOverrides: {
        colorPrimary: {
          color: vault.primary,
        },
      },
    },

    MuiLink: {
      defaultProps: {
        underline: "hover",
      },
      styleOverrides: {
        root: {
          color: vault.primary,
          textDecorationColor: "rgba(124,108,240,0.4)",
          "&:hover": {
            color: vault.primaryLight,
          },
        },
      },
    },

    MuiDivider: {
      styleOverrides: {
        root: {
          borderColor: vault.hairline,
        },
      },
    },

    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 10,
        },
      },
    },
  },
});

export default theme;
