import { LoginRequest } from "@ory/hydra-client";
import { AxiosResponse } from "axios";
import csrf from "csurf";
import { ethers } from "ethers";
import { Router } from "express";

const promClient = require('prom-client');
import fetch from 'node-fetch';
import hydra from "../services/hydra";
import { checkRestrictions, getRestrictions, TCheckResults } from "./restrictions";

// native prom-client metric (no prefix)
const loginStatus = new promClient.Counter({
  name: 'login_status',
  help: 'Cryptoverse Login Status',
  labelNames: ['status', 'client']
});

// @ts-ignore
global.fetch = fetch;

export const router = Router();

// Sets up csrf protection
const csrfProtection = csrf({ cookie: true });

router.get("/", csrfProtection, async function (req, res, next) {
  // Parses the URL query
  const query = (req.query as unknown) as {
    login_challenge: string;
  };

  loginStatus.labels('login-init', 'unknown').inc(1);

  // The challenge is used to fetch information about the login request from ORY Hydra.
  const challenge = query.login_challenge;

  if (!challenge) {
    res.status(400).send('Missing Param');
    loginStatus.labels('error-bad-request-login-init', 'unknown').inc(1);
    return;
  }


  let hydraReqeust: AxiosResponse<LoginRequest>;

  try {
    hydraReqeust = await hydra.getLoginRequest(challenge)
  } catch (error) {
    console.error(error);
    loginStatus.labels('error-during-init-error', 'unknown').inc(1);
    next(error);
    return;
  }

  const clientId = hydraReqeust.data.client.client_id;

  const restrictions = await getRestrictions(hydraReqeust.data.client, next);

  const renderData = {
    sourceId: "default",
    clientId: clientId,
    csrfToken: req.csrfToken(),
    challenge: challenge,
    restrictions: JSON.stringify(restrictions),
    layout: false
  };

  const initialURL: string = hydraReqeust.data.request_url;

  if (initialURL) {
    const url = new URL(initialURL);
    renderData.sourceId = url.searchParams.get("ac") || renderData.sourceId;
  }

  loginStatus.labels('login-init-response', clientId).inc(1);

  res.render("index.html", renderData);
});

router.post("/process", csrfProtection, async function (req, res, next) {
  // The challenge is now a hidden input field, so let's take it from the request body instead
  const loginData = req.body; // POST
  //const loginData = req.query; // GET

  const challenge = loginData.challenge;

  if (!challenge) {
    res.status(400).send('Missing Param');
    loginStatus.labels('error-missing-challenge', 'unknown').inc(1);
    return;
  }

  let hydraReqeust;

  try {
    hydraReqeust = await hydra.getLoginRequest(challenge);
  } catch (error) {
    loginStatus.labels('error-retrieving-hydra-request', 'unknown').inc(1);
    next(error);
    return;
  }

  const clientId = hydraReqeust.data.client.client_id;

  loginStatus.labels('login-start', clientId).inc(1);

  const data = {
    address: loginData.address,
    msg: `Cryptoverse Login - auth.cryptoverse.cc|${loginData._csrf}|${loginData.challenge}`,
    sig: loginData.signature
  };

  const digest = ethers.utils.arrayify(
    ethers.utils.hashMessage(data.msg)
  );
  let recoveredAddress = await ethers.utils.recoverAddress(
    digest,
    data.sig
  );

  recoveredAddress = recoveredAddress.toLowerCase();

  console.log("Recovered Address: ", recoveredAddress, typeof recoveredAddress);

  if (recoveredAddress != loginData.address.toLowerCase()) {
    // Looks like the user provided invalid credentials, let's show the ui again...

    res.render("error.html", {
      csrfToken: req.csrfToken(),

      challenge: challenge,

      error: "Login error: address mismatch."
    });
    loginStatus.labels('error-address-mismatch', clientId).inc(1);
    return;
  }

  const allow = (clientId: string) => {
    // Seems like the user authenticated! Let's tell hydra...
    hydra
      .acceptLoginRequest(challenge, {
        subject: `${recoveredAddress}`
      })
      .then(function (response) {
        // All we need to do now is to redirect the user back to hydra!
        console.info(
          `LOGIN ${new Date().toISOString()} ${clientId} ${recoveredAddress}`
        );
        if (loginData.response == "api") {
          res.send({ redirect: response.data.redirect_to });
        } else {
          res.redirect(response.data.redirect_to);
        }
        loginStatus.labels('success', clientId).inc(1);
      })
      // This will handle any error that happens when making HTTP calls to hydra
      .catch(function (error) {
        loginStatus.labels('error-unknown', clientId).inc(1);
        next(error);
      });
  };

  const clientRestrictions = await getRestrictions(
    hydraReqeust.data.client,
    next
  );

  if (!clientRestrictions) {
    // No Token restrictions flow, allow everyone.
    allow(clientId);
    return;
  }

  let allChecks: TCheckResults;

  try {
    allChecks = await checkRestrictions(clientRestrictions, recoveredAddress);
  } catch (error) {
    loginStatus.labels('error-unknown', clientId).inc(1);
    next(error);
    return;
  }

  if (allChecks.every(check => check.result)) {
    allow(clientId)
  } else {
    console.error(`Restriction checks failure: ${JSON.stringify(allChecks)}`)
    loginStatus.labels('error-restricted', clientId).inc(1);
    next(
      new Error(
        `Your address fails conditions: ${JSON.stringify(allChecks, null, 2)}`
      )
    );
  }
});
