import { OAuth2LoginRequest } from "@ory/client";
import { AxiosResponse } from "axios";
import csrf from "csurf";
import { ethers } from "ethers";
import { Router } from "express";

const promClient = require('prom-client');
import fetch from 'node-fetch';
import hydra from "../services/hydra";
import { checkRestrictions, getRestrictions, TCheckResults, TRestrictions } from "./restrictions";

// native prom-client metric (no prefix)
const loginStatus = new promClient.Counter({
    name: 'login_status',
    help: 'Cryptoverse Login Status',
    labelNames: ['status', 'client']
});

// @ts-ignore
global.fetch = fetch;

export const router = Router();

type TMetadata = {
    app?: string
    restrictions?: TRestrictions
}

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


    let hydraRequest: AxiosResponse<OAuth2LoginRequest>;

    try {
        hydraRequest = await hydra.getOAuth2LoginRequest({ loginChallenge: challenge })
    } catch (error) {
        console.error(error);
        loginStatus.labels('error-during-init-error', 'unknown').inc(1);
        next(error);
        return;
    }

    const clientId = hydraRequest.data.client.client_id;
    const metadata = hydraRequest.data.client.metadata as TMetadata;

    const title = metadata.app || clientId
    const restrictions = await getRestrictions(hydraRequest.data.client, next);

    const renderData = {
        sourceId: "default",
        clientId: clientId,
        csrfToken: req.csrfToken(),
        challenge: challenge,
        restrictions: JSON.stringify(restrictions),
        metadata: JSON.stringify(metadata),
        title: title,
        layout: false
    };

    const initialURL: string = hydraRequest.data.request_url;

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

    let hydraRequest;

    try {
        hydraRequest = await hydra.getOAuth2LoginRequest({
            loginChallenge: challenge,
        });
    } catch (error) {
        console.log("Hydra error")
        console.error(error)
        loginStatus.labels('error-retrieving-hydra-request', 'unknown').inc(1);
        next(error);
        return;
    }

    const clientId = hydraRequest.data.client.client_id;

    loginStatus.labels('login-start', clientId).inc(1);

    const data = {
        address: loginData.address,
        msg: `Cryptoverse Login - auth.cryptoverse.cc|${loginData._csrf}|${loginData.challenge}`,
        sig: loginData.signature
    };

    const digest = ethers.getBytes(
        ethers.hashMessage(data.msg)
    );
    let recoveredAddress = await ethers.recoverAddress(
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
            .acceptOAuth2LoginRequest({
                loginChallenge: challenge,
                acceptOAuth2LoginRequest: {
                    subject: `${recoveredAddress}`
                }
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
        hydraRequest.data.client,
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
