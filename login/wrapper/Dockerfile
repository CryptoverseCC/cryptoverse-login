FROM python:3-alpine

RUN pip install Flask
RUN pip install waitress

COPY wrapper.py /app/wrapper.py
COPY templates /app/templates

WORKDIR /app

CMD waitress-serve --listen "0.0.0.0:$PORT" wrapper:app
