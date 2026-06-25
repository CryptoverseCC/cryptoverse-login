import React, { useEffect, useRef, useState } from "react";
import {
  ILoginProvider,
  IIdentity,
  TLoginRequest,
  TWalletInfo,
} from "./services/loginProvider";
import {
  ConnectWalletPage,
  Modes as ConnectWalletPageModes,
} from "./components/ConnectWalletPage";

import { LoginPage, Modes as LoginPageModes } from "./components/LoginPage";
import { Loader } from "./components/Loader";
import { StatusView } from "./components/StatusView";
import { CssBaseline } from "@mui/material";
import Box from "@mui/material/Box";

interface Window {
  Sentry: any;
}

// If a wallet prompt never resolves (extension hung, popup dismissed without an
// event), don't sit on a spinner forever — surface a clear terminal state with
// a retry after this long.
const HANG_MS = 60 * 1000;

// The transient, full-surface states of the flow. `idle` means "show a page"
// (wallet picker or identity list); the others render the StatusView
// choreography. `error` is a real terminal state with a Try-again action.
type Flow =
  | { kind: "init" }
  | { kind: "idle" }
  | { kind: "connecting"; wallet: string }
  | { kind: "signing"; wallet: string }
  | { kind: "redirecting" }
  | { kind: "error"; title: string; subtext: string };

export interface AppProps {
  loginProvider: ILoginProvider;
  className?: string;
}

const App: React.FC<AppProps> = ({ loginProvider, className }) => {
  const [wallets, setWallets] = useState([] as TWalletInfo[]);
  const [currentWallet, setCurrentWallet] = useState(null as TWalletInfo | null);
  const [identities, setIdentities] = useState([] as IIdentity[]);
  const [flow, setFlow] = useState<Flow>({ kind: "init" });
  // Recoverable, in-page error shown as an inline Alert on a page (the user can
  // pick another wallet / address). Terminal dead-ends use `flow.kind: "error"`.
  const [pageError, setPageError] = useState(null as string | null);
  // Guards against re-entrant connect/login (a wallet handles one prompt at a
  // time); a second trigger while one is busy is ignored with a message.
  const busy = useRef(false);
  // The live identities poll (started on connect; runs only while the user is on
  // the address-picker idle page). Held in a ref so the unmount cleanup and the
  // flow transitions can clear it — a previous module-level interval leaked,
  // ticking through signing/redirect/error and across remounts.
  const identitiesInterval = useRef<number | null>(null);
  const stopIdentitiesPoll = () => {
    if (identitiesInterval.current !== null) {
      window.clearInterval(identitiesInterval.current);
      identitiesInterval.current = null;
    }
  };
  const [walletPageMode, setWalletPageMode] = useState(
    ConnectWalletPageModes.SELECT
  );
  const [loginPageMode, setLoginPageMode] = useState(LoginPageModes.SELECT);

  const capture = (err?: unknown) => {
    if (err) {
      const sentry = (window as unknown as Window).Sentry;
      sentry?.captureException?.(err);
    }
  };

  // Move to the terminal error surface (Try again resets to the wallet picker).
  // Leaving the idle page also stops the identities poll.
  const fail = (title: string, subtext: string, err?: unknown) => {
    capture(err);
    stopIdentitiesPoll();
    setFlow({ kind: "error", title, subtext });
  };

  // Try again from a terminal error: drop the selected wallet and go back to
  // the wallet picker so the user can start over cleanly.
  const onRetry = () => {
    stopIdentitiesPoll();
    setPageError(null);
    setCurrentWallet(null);
    setFlow({ kind: "idle" });
  };

  const onLogin = async (request: TLoginRequest) => {
    if (busy.current) {
      setPageError(
        "A wallet request is already in progress — check your wallet."
      );
      return;
    }
    busy.current = true;
    setPageError(null);
    // Leaving the idle page for the signing choreography — stop polling identities.
    stopIdentitiesPoll();
    setFlow({ kind: "signing", wallet: currentWallet?.name ?? "your wallet" });
    // The hang guard: if the wallet never responds, dead-end into a retry state.
    const guard = window.setTimeout(
      () =>
        fail(
          "This is taking longer than expected",
          "We didn't hear back from your wallet. Open it to finish, or try again."
        ),
      HANG_MS
    );

    try {
      const resp = await loginProvider.login(request);
      if (!resp.ok) {
        window.clearTimeout(guard);
        if (resp.cancelled) {
          // User dismissed the prompt — recoverable, stay on the page.
          setPageError(`${resp.error} Choose an address to try again.`);
          setFlow({ kind: "idle" });
        } else {
          // A genuine signing failure (locked wallet, connector/RPC error):
          // surface its real message instead of the misleading "cancelled".
          fail("We couldn't sign you in", resp.error);
        }
        return;
      }

      const { message, signature, challenge } = resp;
      // Post as URLSearchParams (not a <form>/FormData) so the SIWE message's LF
      // line endings survive — the backend parses EIP-4361 over the signed LF form.
      const body = new URLSearchParams();
      body.set("challenge", challenge);
      body.set("message", message);
      body.set("signature", signature);
      body.set("response", "api");

      const loginResponse = await fetch("/login/process", {
        method: "POST",
        body,
      });
      if (!loginResponse.ok) {
        throw new Error(`/login/process responded ${loginResponse.status}`);
      }
      const data = await loginResponse.json();
      if (!data?.redirect) {
        throw new Error("login response did not include a redirect");
      }
      window.clearTimeout(guard);
      // Show the success seal while the browser navigates away.
      setFlow({ kind: "redirecting" });
      window.location.assign(data.redirect);
    } catch (err) {
      window.clearTimeout(guard);
      fail(
        "We couldn't complete your sign-in",
        "Something went wrong after signing. Try again.",
        err
      );
    } finally {
      busy.current = false;
    }
  };

  const onConnect = async (wallet: TWalletInfo) => {
    if (busy.current) {
      setPageError(
        "A wallet request is already in progress — check your wallet."
      );
      return;
    }
    busy.current = true;
    setPageError(null);
    setFlow({ kind: "connecting", wallet: wallet.name });
    const guard = window.setTimeout(
      () =>
        fail(
          "This is taking longer than expected",
          "We didn't hear back from your wallet. Open it to finish, or try again."
        ),
      HANG_MS
    );

    try {
      const response = await loginProvider.connect({ id: wallet.id });
      window.clearTimeout(guard);
      if (response.error) {
        // Recoverable: back to the picker so the user can retry / switch wallet.
        setPageError(response.error);
        setFlow({ kind: "idle" });
        return;
      }
      if (response.identities.length === 0) {
        setPageError("No accounts were shared by the wallet.");
        setFlow({ kind: "idle" });
        return;
      }

      setIdentities(response.identities);
      setCurrentWallet(wallet);
      setFlow({ kind: "idle" });

      // Poll for account changes while the user is on the address picker. Don't
      // double-start; the unmount cleanup and every flow transition out of idle
      // (sign/redirect/error/back) clear it via stopIdentitiesPoll.
      stopIdentitiesPoll();
      identitiesInterval.current = window.setInterval(async () => {
        const resp = await loginProvider.identities({});
        if (resp) {
          setIdentities(resp.identities);
        }
      }, 1000);
    } catch (err) {
      window.clearTimeout(guard);
      fail(
        "We couldn't connect to your wallet",
        "Check that your wallet is unlocked, then try again.",
        err
      );
    } finally {
      busy.current = false;
    }
  };

  const onBackToSelectWallet = () => {
    // Back to the wallet picker — the address poll no longer applies.
    stopIdentitiesPoll();
    setPageError(null);
    setCurrentWallet(null);
    setFlow({ kind: "idle" });
  };

  useEffect(() => {
    let cancelled = false;
    const guard = window.setTimeout(
      () =>
        fail(
          "This is taking longer than expected",
          "We couldn't load your wallets. Check your connection and try again."
        ),
      HANG_MS
    );
    (async () => {
      try {
        // Pass a live-update callback so wallets that announce (EIP-6963) after
        // the initial snapshot still appear in the picker. The embed pushes the
        // refreshed list across the Comlink boundary as connectors arrive/leave;
        // we replace the wallet-list state with each push. (`cancelled` guards
        // against late callbacks after unmount.)
        const resp = await loginProvider.init({
          onWalletsChanged: (updated: TWalletInfo[]) => {
            if (!cancelled) setWallets(updated);
          },
        });
        if (!cancelled) {
          window.clearTimeout(guard);
          setWallets(resp.wallets);
          setFlow({ kind: "idle" });
        }
      } catch (err) {
        if (!cancelled) {
          window.clearTimeout(guard);
          fail(
            "We couldn't load your wallets",
            "Check your connection and try again.",
            err
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(guard);
    };
  }, [loginProvider]);

  // Stop the identities poll when App unmounts so the interval never outlives
  // the component (it previously leaked via a module-level variable, surviving
  // remounts). Empty deps: this runs once on mount and its cleanup on unmount.
  useEffect(() => () => stopIdentitiesPoll(), []);

  const clientId = loginProvider.loginData.clientId;
  const metadata = loginProvider.loginData.metadata;
  const restrictions = loginProvider.loginData.restrictions;
  const origin = metadata?.app || clientId;

  const renderBody = () => {
    switch (flow.kind) {
      case "init":
        return <Loader />;
      case "connecting":
        return (
          <StatusView
            kind="connecting"
            title={`Opening ${flow.wallet}…`}
            subtext="Check your wallet to continue."
          />
        );
      case "signing":
        return (
          <StatusView
            kind="signing"
            title={`Confirm the signature in ${flow.wallet}`}
            subtext="This proves you own the address — no transaction, no fee."
            detail="no transaction · no gas"
          />
        );
      case "redirecting":
        return (
          <StatusView
            kind="redirecting"
            title="Signed in"
            subtext={`Taking you to ${origin}…`}
          />
        );
      case "error":
        return (
          <StatusView
            kind="error"
            title={flow.title}
            subtext={flow.subtext}
            actionLabel="Try again"
            onAction={onRetry}
          />
        );
      case "idle":
      default:
        return currentWallet ? (
          <LoginPage
            origin={origin}
            identities={identities}
            restrictions={restrictions}
            wallet={currentWallet}
            error={pageError}
            onLogin={onLogin}
            onSelectWallet={onBackToSelectWallet}
            mode={loginPageMode}
            switchMode={setLoginPageMode}
          />
        ) : (
          <ConnectWalletPage
            origin={origin}
            onConnect={onConnect}
            wallets={wallets}
            restrictions={restrictions}
            error={pageError}
            mode={walletPageMode}
            switchMode={setWalletPageMode}
          />
        );
    }
  };

  // Each rendered body owns its own PageShell (the centred, max-width column on
  // the full-bleed gradient) so it is correct both here and in isolation — the
  // pages top-align their AppBar, the StatusView states centre their seal. App
  // is just the full-bleed host.
  return (
    <Box
      component="main"
      className={className}
      sx={{ flexGrow: 1, minHeight: "100vh", width: "100%" }}
    >
      <CssBaseline />
      {renderBody()}
    </Box>
  );
};

export default App;
