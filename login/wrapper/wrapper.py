from flask import Flask, request, render_template
from urllib.parse import parse_qs, urlparse
from os import environ

app = Flask(__name__)

VERSION = environ["VERSION"]
SENTRY_DSN = environ["SENTRY_DSN"]


@app.route("/oauth2/auth", methods=["GET"])
def embed():
    url = request.url.replace("/oauth2/auth", "/oauth2/inner").replace(
        "http://", "https://", 1
    )
    parts = urlparse(url)
    params = parse_qs(parts.query)
    return render_template(
        "embed.html", url=url, params=params, version=VERSION, sentry_dsn=SENTRY_DSN,
    )


@app.route("/oauth2/final", methods=["GET"])
def final():
    app.logger.info(repr(request.query_string))
    url = request.query_string[4:]
    url = url.decode("utf8")
    url = urlparse(url).geturl()  # make sure we deal with url
    app.logger.info(url)
    return render_template(
        "final.html", url=url, version=VERSION, sentry_dsn=SENTRY_DSN,
    )
