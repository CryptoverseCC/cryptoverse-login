import React from "react";
import { render, screen, act } from "@testing-library/react";
import { App } from "./App";
import {
  ILoginProvider,
  TConnectRequest,
  TLoginRequest,
} from "./services/loginProvider";

const OperaETHAddress = "0x6be450972b30891b16c8588dcbc10c8c2aef04da";

const OperaLoginProvider: ILoginProvider = {
  loginData: {
    csrf: "csrf",
    challenge: "challange",
    sourceId: "default",
    clientId: "test-source.com",
    restrictions: [],
  },
  init: async () => ({ name: "Opera" }),
  identities: async () => ({
    identities: [
      {
        name: OperaETHAddress,
        ens: "xunkulapchvatal.eth",
        active: true,
      },
    ],
  }),
  connect: async ({ name }: TConnectRequest) => {
    return {
      identities: [
        {
          name: OperaETHAddress,
          ens: "xunkulapchvatal.eth",
          active: true,
        },
      ],
    };
  },
  login: async ({ address }: TLoginRequest) => {
    return {
      signature: "fake-signature",
      csrf: "fake-csrf",
      challenge: "fake-challenge",
      address: address,
    };
  },
};

const MissingLoginProvider: ILoginProvider = {
  loginData: {
    csrf: "csrf",
    challenge: "challange",
    sourceId: "default",
    clientId: "test-source.com",
    restrictions: [],
  },
  init: async () => ({ name: null }),
  identities: async () => ({
    identities: [
      {
        name: "0x6be450972b30891b16c8588dcbc10c8c2aef04da",
        ens: null,
        active: true,
      },
    ],
  }),
  connect: async ({ name }: TConnectRequest) => {
    return {
      identities: [
        {
          name: "0x6be450972b30891b16c8588dcbc10c8c2aef04da",
          ens: null,
          active: true,
        },
      ],
    };
  },
  login: async ({ address }: TLoginRequest) => ({
    signature: "fake-signature",
    csrf: "fake-csrf",
    challenge: "fake-challenge",
    address: address,
  }),
};

test("App renders wallet if found", async () => {
  const loginProvider = OperaLoginProvider;
  function sleep(period: number) {
    return new Promise((resolve) => setTimeout(resolve, period));
  }

  act(() => {
    render(<App loginProvider={loginProvider} walletProviders={[]} />);
  });

  /// Check for progress bar
  expect(screen.getByRole("progressbar")).toBeInTheDocument();

  await act(async () => {
    await sleep(1100); // wait *just* a little longer than the timeout in the component
  });

  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  /// Check no progress bar, check rendered injected wallet provider

  const Opera = screen.getByText(/Opera/i);
  expect(Opera).toBeInTheDocument();
});

test("App renders missing wallet", async () => {
  const loginProvider = MissingLoginProvider;
  function sleep(period: number) {
    return new Promise((resolve) => setTimeout(resolve, period));
  }

  act(() => {
    render(<App loginProvider={loginProvider} walletProviders={[]} />);
  });

  /// Check for progress bar
  expect(screen.getByRole("progressbar")).toBeInTheDocument();

  await act(async () => {
    await sleep(1100); // wait *just* a little longer than the timeout in the component
  });

  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  /// Check no progress bar, check rendered injected wallet provider

  const Opera = screen.getByText(/Wallet Not Detected/i);
  expect(Opera).toBeInTheDocument();
});

test("App is able to login", async () => {
  const loginProvider = OperaLoginProvider;
  function sleep(period: number) {
    return new Promise((resolve) => setTimeout(resolve, period));
  }

  act(() => {
    render(<App loginProvider={loginProvider} walletProviders={[]} />);
  });

  await act(async () => {
    await sleep(1100); // wait *just* a little longer than the timeout in the component
  });

  const Opera = screen.getByText(/Opera/i);

  await act(async () => {
    Opera.click();
  });

  const BreadcrumbsOpera = screen.getByText(/Login with Opera/i);
  expect(BreadcrumbsOpera).toBeInTheDocument();

  const LoginCardText = screen.getByText(OperaETHAddress);
  expect(LoginCardText).toBeInTheDocument();

  await act(async () => {
    LoginCardText.click();
  });
});
