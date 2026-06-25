import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@mui/material/styles";

import App from "../App";
import theme from "../theme";
import { makeMockLoginProvider } from "./mockLoginProvider";
import { wallets } from "./fixtures";
import type { ILoginProvider } from "../services/loginProvider";

// Render App under the app's MUI theme (tss-react/MUI components read the Vault
// theme from context — without it, theme.palette.vault.* is undefined), mirroring
// the Storybook preview decorator.
const renderApp = (provider: ILoginProvider) =>
  render(
    <ThemeProvider theme={theme}>
      <App loginProvider={provider} />
    </ThemeProvider>
  );

// Interaction tests for the highest-value gaps the mount-only story render test
// can't cover: the distinct sign-failure states (user-rejection vs a genuine
// error) and the empty-identities-on-connect case. These drive the real App flow
// (init → pick wallet → connect → pick address → sign) against a mock provider.

afterEach(() => cleanup());

const user = userEvent.setup();

// Walk the flow up to the address picker: wait for init, click the first wallet,
// then wait for the LoginPage (the "Choose an address" heading) to appear.
async function connectAndReachAddressPicker(provider: ILoginProvider) {
  renderApp(provider);

  // The first wallet tile (MetaMask) is a real button (ButtonBase) now.
  const walletTile = await screen.findByRole("button", {
    name: `Connect with ${wallets[0].name}`,
  });
  await user.click(walletTile);

  // After a successful connect we land on the address picker.
  await screen.findByText("Choose an address");
}

// Click the first (active) identity card to trigger the sign step. The active
// Identity card is now a real button labelled "Sign in with <ens|short>".
async function signWithFirstIdentity() {
  const cards = await screen.findAllByRole("button", { name: /Sign in with/ });
  await user.click(cards[0]);
}

describe("App sign-rejection flow", () => {
  beforeEach(() => cleanup());

  it("shows a recoverable inline error and stays on the address picker when the user cancels signing", async () => {
    const provider = makeMockLoginProvider({
      login: async () => ({
        ok: false as const,
        cancelled: true,
        error: "Signing was cancelled.",
      }),
    });

    await connectAndReachAddressPicker(provider);
    await signWithFirstIdentity();

    // Recoverable: we are back on the address picker with an inline warning,
    // NOT on the terminal error surface (no "Try again" action button).
    await waitFor(() =>
      expect(
        screen.getByText(/Signing was cancelled\. Choose an address to try again\./)
      ).toBeInTheDocument()
    );
    expect(screen.getByText("Choose an address")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Try again" })
    ).not.toBeInTheDocument();
  });

  it("shows the terminal error surface (not 'cancelled') for a genuine signing failure", async () => {
    const provider = makeMockLoginProvider({
      login: async () => ({
        ok: false as const,
        cancelled: false,
        error: "Your wallet is locked. Unlock it and try again.",
      }),
    });

    await connectAndReachAddressPicker(provider);
    await signWithFirstIdentity();

    // Terminal: the StatusView error surface with a Try again action and the
    // wallet's real message — crucially NOT the misleading "cancelled" copy.
    await screen.findByRole("button", { name: "Try again" });
    expect(
      screen.getByText("Your wallet is locked. Unlock it and try again.")
    ).toBeInTheDocument();
    expect(screen.getByText("We couldn't sign you in")).toBeInTheDocument();
    expect(screen.queryByText("Choose an address")).not.toBeInTheDocument();
  });
});

describe("App empty-identities-on-connect", () => {
  beforeEach(() => cleanup());

  it("surfaces 'No accounts were shared' and stays on the wallet picker", async () => {
    const provider = makeMockLoginProvider({
      connect: async () => ({ identities: [] }),
    });

    renderApp(provider);
    const walletTile = await screen.findByRole("button", {
      name: `Connect with ${wallets[0].name}`,
    });
    await user.click(walletTile);

    // Recoverable inline error; we remain on the wallet picker (still showing
    // the "Sign in to <origin>" heading), not the address picker.
    await waitFor(() =>
      expect(
        screen.getByText("No accounts were shared by the wallet.")
      ).toBeInTheDocument()
    );
    expect(screen.queryByText("Choose an address")).not.toBeInTheDocument();
  });
});
