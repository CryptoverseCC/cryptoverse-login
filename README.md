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

## Run selenium tests locally

```bash
$ cd tests
$ source .venv/bin/activate.fish
$ pip install -r requirements.txt --upgrade
$ python browser.py -k TestFirefox
```
