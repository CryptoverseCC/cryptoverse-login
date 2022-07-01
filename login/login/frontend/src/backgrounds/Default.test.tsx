import { render, screen } from "@testing-library/react";
import { Background } from "./Default";
import {ILoginProvider, TConnectRequest, TLoginRequest} from "../services/loginProvider";

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

test("renders additional login button if login history is not empty", ()=> {
  const loginHistory = [
    {
      address: "000-123-007-asd",
      wallet: "Opera"
    }
  ]
  const App = () => null
  render(<Background
    loginHistory={loginHistory}
    AppComponent={App}
    loginProvider={OperaLoginProvider}
    walletProviders={[]} />)

  const button = screen.getByText('000-123-007-asd');

  expect(button).toBeInTheDocument();
});


