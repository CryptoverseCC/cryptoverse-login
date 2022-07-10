#!/bin/sh
set -e
python manage.py migrate
echo "Running server on PORT $PORT"
#python manage.py runserver 0.0.0.0:$PORT
gunicorn -b 0.0.0.0:$PORT -w 2 manager.wsgi
