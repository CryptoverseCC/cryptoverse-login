#!/bin/sh
set -e
echo "Running server on PORT $PORT"
#python manage.py runserver 0.0.0.0:$PORT
gunicorn -b 0.0.0.0:$PORT -w 24 register.wsgi
