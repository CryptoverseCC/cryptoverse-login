FROM python:3-alpine

ENV VERSION 0.0.1

RUN apk add --no-cache build-base libffi-dev openssl-dev
RUN pip install Django==3
RUN pip install gunicorn
RUN pip install web3==5.8.0
RUN pip install django-extensions
RUN pip install django-request-logging

COPY src/ /app/

WORKDIR /app/

CMD [ "./run.sh" ]
