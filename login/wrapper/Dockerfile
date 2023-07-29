FROM python:3.11-slim-bullseye

RUN pip install Flask
RUN pip install waitress
RUN pip install sentry-sdk[flask]

COPY wrapper.py /app/wrapper.py
COPY templates /app/templates

WORKDIR /app

CMD waitress-serve --listen "0.0.0.0:$PORT" wrapper:app
