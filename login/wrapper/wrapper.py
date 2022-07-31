from os import environ
from urllib.parse import parse_qs, urlparse

import sentry_sdk
from flask import Flask, render_template, request
from sentry_sdk.integrations.flask import FlaskIntegration

app = Flask(__name__)

VERSION = environ["VERSION"]
SENTRY_ENV = environ["SENTRY_ENV"]
SENTRY_DSN = environ["SENTRY_DSN"]


sentry_sdk.init(
    dsn=SENTRY_DSN,
    integrations=[
        FlaskIntegration(),
    ],
    environment=SENTRY_ENV,

    # Set traces_sample_rate to 1.0 to capture 100%
    # of transactions for performance monitoring.
    # We recommend adjusting this value in production.
    traces_sample_rate=1.0,

    # By default the SDK will try to use the SENTRY_RELEASE
    # environment variable, or infer a git commit
    # SHA as release, however you may want to set
    # something more human-readable.
    release=VERSION,
)


@app.route("/oauth2/auth", methods=["GET"])
def embed():
    url = request.url.replace("/oauth2/auth", "/oauth2/inner").replace(
        "http://", "https://", 1
    )
    parts = urlparse(url)
    params = parse_qs(parts.query)
    return render_template(
        "embed.html", url=url, params=params, version=VERSION, sentry_dsn=SENTRY_DSN, sentry_env=SENTRY_ENV,
    )


@app.route("/oauth2/final", methods=["GET"])
def final():
    app.logger.info(repr(request.query_string))
    url = request.query_string[4:]
    url = url.decode("utf8")
    url = urlparse(url).geturl()  # make sure we deal with url
    app.logger.info(url)
    return render_template(
        "final.html", url=url, version=VERSION, sentry_env=SENTRY_ENV, sentry_dsn=SENTRY_DSN,
    )
