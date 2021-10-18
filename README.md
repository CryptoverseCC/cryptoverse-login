# Cryptoverse Login

## Build

```bash
$ ./docker-build [version]
...
```

## Release

```bash
$ helm upgrade cryptoverse-login ./charts/login/ -f charts/login/values.prod.yaml -n cryptoverse-login --install
...
```
