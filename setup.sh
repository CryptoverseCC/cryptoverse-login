#!/bin/bash
set -e
set -o xtrace

DOMAIN_LOGIN=login.cryptoverse.dev
DOMAIN_DEMO=login-demo.cryptoverse.dev

echo "Enable DNS"
microk8s enable dns


echo "Enable prometheus"
microk8s enable prometheus

sleep 10s

echo "Enable storage"
microk8s enable hostpath-storage

sleep 10s

echo "Enable ingress"
microk8s enable ingress

sleep 10s

echo "Enable registry"
microk8s enable registry

sleep 10s

echo "Install postgress"
microk8s helm upgrade --install postgres bitnami/postgresql \
    --set auth.database=cryptoverse-login,auth.username=cryptoverse,auth.password=cryptopass \
    --version 12.4.3 \
    --wait=true

sleep 10s

echo "Create namesapces"
microk8s kubectl create namespace cryptoverse-login || true
microk8s kubectl create namespace cryptoverse-login-demo || true

echo "Generate certificates"
microk8s kubectl delete secret cryptoverse-login -n cryptoverse-login --ignore-not-found --wait=true

openssl req -x509 -nodes -days 1 -newkey rsa:2048 \
    -out local.crt \
    -keyout local.key \
    -subj "/CN=${DOMAIN_LOGIN}/O=Cryptoverse OU"

microk8s kubectl create secret tls cryptoverse-login \
    --namespace cryptoverse-login \
    --key local.key \
    --cert local.crt

microk8s kubectl delete secret login-demo-tls -n cryptoverse-login-demo --ignore-not-found --wait=true

openssl req -x509 -nodes -days 1 -newkey rsa:2048 \
    -out local-demo.crt \
    -keyout local-demo.key \
    -subj "/CN=${DOMAIN_DEMO}/O=Cryptoverse OU"

microk8s kubectl create secret tls login-demo-tls \
    --namespace cryptoverse-login-demo \
    --key local-demo.key \
    --cert local-demo.crt


echo "Build the application"
export COMPOSE_DOCKER_CLI_BUILD=1
export DOCKER_BUILDKIT=1
export PROJECT=cryptoverse-login
export REGISTRY=localhost:32000/cryptoverse
TAG="v$(date '+%Y%m%d_%H%M%S')"
export TAG

docker-compose -f docker-compose.build.yml build --pull #--parallel
docker-compose -f docker-compose.build.yml push

echo "Install Cryptoverse Login"
microk8s helm3 upgrade cryptoverse-login ./charts/login/ \
    --install \
    --namespace cryptoverse-login \
    --values charts/login/values.yaml \
    --values charts/login/values.local.yaml \
    --set version="$TAG" \
    --debug



echo "Build Demo App"
docker-compose -f tests/cryptoverse-login-demo/docker-compose.build.yml build --pull #--parallel
docker-compose -f tests/cryptoverse-login-demo/docker-compose.build.yml push


echo "Install demo app"
microk8s helm3 upgrade cryptoverse-login-demo ./tests/cryptoverse-login-demo/charts/demo/ \
    --install \
    --namespace cryptoverse-login-demo \
    --values ./tests/cryptoverse-login-demo/charts/demo/values.yaml \
    --values ./tests/cryptoverse-login-demo/charts/demo/values.local.yaml \
    --set version="$TAG" \
    --set tlsSecretName=login-demo-tls \
    --set demo.oidc.jwksEndpoint=http://cryptoverse-login-hydra-public.cryptoverse-login:4444/.well-known/jwks.json \
    --set demo.oidc.tokenEndpoint=http://cryptoverse-login-hydra-public.cryptoverse-login:4444/oauth2/token \
    --set demo.oidc.userEndpoint=http://cryptoverse-login-hydra-public.cryptoverse-login:4444/userinfo \
    --debug


dig login.cryptoverse.dev
dig login-demo.cryptoverse.dev
