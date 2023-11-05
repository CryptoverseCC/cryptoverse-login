# Cryptoverse Login

## Build
Use github actions - builds on PRs

## Release
Use github actions - releases on tags

## Build & run application on local microk8s

```bash
$ ./setup.sh
```

## Run selenium tests locally

```bash
$ cd tests
$ source .venv/bin/activate.fish
$ pip install -r requirements.txt --upgrade
$ pytest test_full.py --verbose --log-level=INFO --capture=no --log-cli-level=INFO
```
