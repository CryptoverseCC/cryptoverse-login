# Setup tests environment

## Download drivers

Put driver executables in `tools` directory

- [Firefox](https://github.com/mozilla/geckodriver/releases)
- [Chrome](https://sites.google.com/a/chromium.org/chromedriver/downloads)
- [Opera](https://github.com/operasoftware/operachromiumdriver/releases)

## Create python virtualenv

virtualenv directory should be cryptoverse-login/tests/.venv

```bash
$ cd tests
$ python3 -m venv .venv
$ source .venv/bin/activte.fish
$ pip install selenium
...
```

## Run tests

In activated virtualenv:

```bash
$ cd tests
$ python browser.py
...
```
