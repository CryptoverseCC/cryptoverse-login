#!/bin/bash
BASEDIR=$(dirname "$0")
PASS=$1
echo "${PASS}" | gpg --batch --symmetric --cipher-algo AES256 --passphrase-fd 0 ${BASEDIR}/values.prod.yaml
