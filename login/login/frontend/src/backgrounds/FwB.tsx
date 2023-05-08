import React, { useState, lazy, Suspense } from "react";
import { makeStyles, Theme } from "@material-ui/core/styles";
import { ILoginProvider } from "../services/loginProvider";
import { ProviderList } from "../components/ConnectWalletPage";
import { Loader } from "../components/Loader";

const App = lazy(
  () => import(/* webpackPreload: true, webpackChunkName: "app" */ "../App")
);

const useStyles = makeStyles((theme: Theme) => ({
  app: {
    position: "absolute",
    top: 0,
    left: 0,
  },
}));

export interface BackgroundProps {
  loginProvider: ILoginProvider;
  walletProviders: ProviderList;
}

export const Background: React.FC<BackgroundProps> = ({
  loginProvider,
  walletProviders,
}) => {
  const classes = useStyles();
  const [open, setOpen] = useState(false);
  return (
    <Suspense fallback={<Loader />}>
      <style>
        {`
        /*
        * By The Temporary State
        * temporarystate.net
        */
          @font-face {
            font-display: block;
            font-family: "Wremena";
            src: url("https://type.cargo.site/files/Wremena-Light.woff")
              format("woff");
            font-style: normal;
            font-weight: 200;
            unicode-range: U+0000-DFFF, U+F900-FFFD;
          }
          /*
        * By The Temporary State
        * temporarystate.net
        */
          @font-face {
            font-display: block;
            font-family: "Wremena";
            src: url("https://type.cargo.site/files/Wremena-Regular.woff")
              format("woff");
            font-style: normal;
            font-weight: normal;
            unicode-range: U+0000-DFFF, U+F900-FFFD;
          }
          /*
        * By The Temporary State
        * temporarystate.net
        */
          @font-face {
            font-display: block;
            font-family: "Wremena";
            src: url("https://type.cargo.site/files/Wremena-Bold.woff") format("woff");
            font-style: normal;
            font-weight: bold;
            unicode-range: U+0000-DFFF, U+F900-FFFD;
          }

          body {
            background-color: #f8f2f2;
            font-family: "Helvetica Neue", Helvetica, sans-serif, "Helvetica Roman",
              Icons;
            font-size: 18px;
          }

          .heading {
            max-width: 600px;
            font-family: Wremena, Icons;
            font-style: normal;
            font-weight: 200;
            padding: 0;
            margin: 0;
            color: rgba(0, 0, 0, 0.85);
            font-size: 50px;
            line-height: 0.9;
          }

          .fwb-logo {
            position: absolute;
            bottom: 20px;
            right: 20px;
            max-width: 300px;
            width: 30vw;
            height: auto;
          }

          form {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            max-width: 500px;
            width: 90vw;
          }

          form h3 {
            font-size: 28px;
            font-weight: normal;
          }

          p a {
            color: rgba(0, 0, 0, 0.85);
            background-color: white;
            padding-bottom: 0.1em;
            border-bottom: 0em solid rgba(127, 127, 127, 0.2);
            text-decoration: none;
          }

          button {
            background: white;
            border: 1px solid black;
            box-shadow: none;
            font-size: 22px;
            margin-top: 12px;
            outline: none;
            cursor: pointer;
            padding: 0.5rem 1rem;
          }

          .kaomoji {
            white-space: pre;
          }

          @media (max-width: 400px) {
            body {
              font-size: 16px;
            }
            form h3 {
              font-size: 22px;
            }
            .heading {
              font-size: 30px;
            }
          }`}
      </style>
      <h2 className="heading">
        <b>Friends With Benefits</b>
        <br />
        Tokenized Community
      </h2>
      <form>
        <h3>
          Discourse Login <span className="kaomoji">(づ ◕‿◕ )づ</span>
        </h3>
        <p>
          In order to access the Discourse, you must have at least 100 FWB
          tokens, which can be bought
          <a href="https://app.uniswap.org/#/swap?outputCurrency=0x7d91e637589EC3Bb54D8213a9e92Dc6E8D12da91">
            on Uniswap
          </a>
          .
        </p>
        <button type="button" onClick={() => setOpen(true)}>
          login
        </button>
      </form>
      <img
        alt="fwb"
        className="fwb-logo"
        width="1000"
        height="931"
        src="https://freight.cargo.site/w/750/i/05fa11c73bebaec7407875332dc2c3bbe92a26f8a13f53af3cea7fd0230bd755/1082919_SMPNG_776241850T539131C.png"
      />
      {open && (
        <App
          className={classes.app}
          loginProvider={loginProvider}
          walletProviders={walletProviders}
        />
      )}
    </Suspense>
  );
};
