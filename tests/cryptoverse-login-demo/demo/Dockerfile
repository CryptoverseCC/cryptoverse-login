FROM python:3-alpine as base

FROM base as builder

RUN apk add --no-cache build-base libffi-dev python3-dev musl-dev openssl-dev rust cargo
# postgresql-dev gcc

RUN python -m venv /opt/venv
# Make sure we use the virtualenv:
ENV PATH="/opt/venv/bin:$PATH"

RUN pip install Django
RUN pip install gunicorn
RUN pip install mozilla-django-oidc
RUN pip install django-request-logging
RUN pip install django-prometheus
RUN pip install jwt

FROM base as devcontainer

RUN pip install black

FROM base as runner

COPY --from=builder /opt/venv /opt/venv
# Make sure we use the virtualenv:
ENV PATH="/opt/venv/bin:$PATH"

FROM runner

COPY src/ /app/
WORKDIR /app/
CMD [ "./run.sh" ]
