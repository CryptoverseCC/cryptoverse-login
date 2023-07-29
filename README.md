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

## Run (and build) application on local microk8s

```bash
$ ./setup.sh
```

## Run selenium tests locally

```bash
$ cd tests
$ source .venv/bin/activate.fish
$ pip install -r requirements.txt --upgrade
$ python browser.py -k TestFirefox
```
