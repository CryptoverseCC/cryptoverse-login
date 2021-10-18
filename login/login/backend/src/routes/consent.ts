import csrf from "csurf";
import { Router } from "express";
import url from "url";
import hydra from "../services/hydra";
import { getData } from "./userData";

const csrfProtection = csrf({ cookie: true });
export const router = Router();


router.get("/", csrfProtection, async function (req, res, next) {
  const query = url.parse(req.url, true).query;
  const challenge = String(query.consent_challenge);
  if (!challenge) {
    next(new Error('Expected a consent challenge to be set but received none.'))
    return
  }

  let response;

  try {
    response = await hydra.getConsentRequest(challenge);
  } catch (error) {
    console.error(error);
    next(error);
    return;
  }

  let userData;

  try {
    userData = await getData(response.data);
  } catch (error) {
    console.error(error);
    next(error)
    return;
  }

  let resp;

  try {
    resp = await hydra.acceptConsentRequest(challenge, {
      grant_scope: response.data.requested_scope,
      grant_access_token_audience: response.requested_access_token_audience,
      session: { id_token: userData }
    });
  } catch (error) {
    console.error(error);
    next(error)
    return;
  }

  res.redirect(String(resp.data.redirect_to));

  return;
});
