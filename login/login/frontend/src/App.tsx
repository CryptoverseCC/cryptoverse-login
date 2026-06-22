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

let identitiesInterval: number | null = null;

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
  const fail = (title: string, subtext: string, err?: unknown) => {
    capture(err);
    setFlow({ kind: "error", title, subtext });
  };

  // Try again from a terminal error: drop the selected wallet and go back to
  // the wallet picker so the user can start over cleanly.
  const onRetry = () => {
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
      if (!resp) {
        window.clearTimeout(guard);
        setPageError("Signing was cancelled. Choose an address to try again.");
        setFlow({ kind: "idle" });
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

      if (identitiesInterval) {
        clearInterval(identitiesInterval);
      }
      identitiesInterval = window.setInterval(async () => {
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
        const resp = await loginProvider.init({});
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
