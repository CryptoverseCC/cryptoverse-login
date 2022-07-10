# Cryptoverse Login - Python/Django Demo Application

## Env

Change `.env` file and point it to your docker images repository

## Build

```bash
$ ./docker-build
...
```

## Deploy to K8s cluster

```bash
helm install --upgrade cryptoverse-login-demo ./charts/demo/
```
