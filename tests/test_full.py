import json
import logging
import os
import time
from pathlib import Path
from typing import Generator, TypeAlias, Any
from unittest import TestCase
from urllib.parse import urlparse

import metamask
import pytest
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver import FirefoxOptions
from selenium.webdriver.firefox.service import Service as FirefoxService
from selenium.webdriver.remote.webelement import WebElement

Domain: TypeAlias = str
IDToken: TypeAlias = dict[str, Any]

logging.basicConfig(level=logging.DEBUG)

AUTH_DOMAIN = os.getenv("DOMAIN_LOGIN", "login.cryptoverse.cc")
DEMO_APP_DOMAIN = os.getenv("DOMAIN_DEMO_APP", "login-demo.cryptoverse.cc")
ASSETS_PATH = os.getenv("ASSETS_PATH", "./assets")

os.makedirs(ASSETS_PATH, exist_ok=True)


class MissingWindow(Exception):
    pass


def switch_to(driver: webdriver.Firefox, title: str) -> None:
    time.sleep(10)
    for handle in driver.window_handles:
        driver.switch_to.window(handle)
        logging.info(driver.title)
        if title in driver.title:
            logging.info("Switching to: %s", driver.title)
            return

    logging.error("Couldn't find window with title: %s", title)
    snap(driver, f"switch_fail - {title}")
    raise MissingWindow(f"Couldn't find window with title: {title}")


def focus_on_auth_frame(driver: webdriver.Firefox) -> None:
    auth_frame = driver.find_element(by=By.XPATH, value="//body/iframe")
    driver.switch_to.frame(auth_frame)


def get_current_domain(driver: webdriver.Firefox) -> Domain:
    url = driver.current_url
    return urlparse(url).netloc


def click(driver: webdriver.Firefox, xpath: str) -> None:
    button: WebElement = driver.find_element(by=By.XPATH, value=xpath)
    button.click()


snap_counter = 0
def snap(driver: webdriver.Firefox, name: str) -> None:
    global snap_counter
    snap_counter += 1
    path = Path(ASSETS_PATH) / f"{snap_counter}_{name}.png"
    if driver.save_screenshot(str(path)):
        logging.info("Screenshot saved to %s", path)
    else:
        logging.error("Screenshot saving failed")


async def test_initial(drvr: webdriver.Firefox) -> None:
    assert AUTH_DOMAIN is not None
    assert DEMO_APP_DOMAIN is not None

    # Setup Metamask
    metamask.init(drvr)

    # Load Initial Page
    drvr.get("https://{}?auth_domain={}".format(DEMO_APP_DOMAIN, AUTH_DOMAIN))
    snap(drvr, "demo_app_loaded")

    # Start Authentication Flow
    click(drvr, '//*[text()="Login with Ethereum Wallet"]')
    assert get_current_domain(drvr) == AUTH_DOMAIN
    snap(drvr, "login_page_loaded")

    # Select Wallet Type
    focus_on_auth_frame(drvr)
    click(drvr, '//*[text()="Ethereum Wallet"]')
    snap(drvr, "after_wallet_select")

    # Select Wallet Provider
    click(drvr, '//*[text()="MetaMask"]')
    snap(drvr, "after_metamask_selected")

    switch_to(drvr, "MetaMask Notification")

    click(drvr, '//button[text()="Next"]')
    click(drvr, '//button[text()="Connect"]')
    switch_to(drvr, "Login with Ethereum Wallet")
    snap(drvr, "after_wallet_connected")

    # Use specific address for login
    focus_on_auth_frame(drvr)
    click(drvr, '//*[text()="0xae89b4e1b97661dab58bee7771e95ec58fc6a94b"]')
    switch_to(drvr, "MetaMask Notification")

    click(drvr, '//button[text()="Sign"]')
    # switching to final page since switch_to waits 10s before
    # checking available windows and it has time to load
    switch_to(drvr, "Cryptoverse Login - Demo - Success")
    snap(drvr, "after_wallet_sign_2")

    # Wait for login redirects and final page
    snap(drvr, "final_page_loaded")
    # Check if we logged in successfully
    element = drvr.find_element(
        by=By.XPATH,
        value='//span[text()="0xae89b4e1b97661dab58bee7771e95ec58fc6a94b"]',
    )
    logging.info("Login successful for: %s", element.text)

    element = drvr.find_element(
        by=By.CLASS_NAME,
        value='data',
    )

    id_token: IDToken = json.loads(element.text)

    TestCase().assertDictContainsSubset({
        "address": {
            "country": "Cryptoverse",
            "region": "Ethereum"
        },
        "birthdate": "",
        "email": "0xae89b4e1b97661dab58bee7771e95ec58fc6a94b@ethmail.cc",
        "email_verified": True,
        "emails": {
            "all": [
                "0xae89b4e1b97661dab58bee7771e95ec58fc6a94b@ethmail.cc",
            ],
            "default": "0xae89b4e1b97661dab58bee7771e95ec58fc6a94b@ethmail.cc",
            "ens": {
                "all": [],
                "default": None
            },
            "unstoppabledomains": {
                "all": [],
                "default": None
            }
        },
        "family_name": "Ethereum",
        "gender": "ethereum-address",
        "given_name": "0xae89b4e1b97661dab58bee7771e95ec58fc6a94b",
        "locale": "",
        "middle_name": "",
        "name": "0xae89b4e1b97661dab58bee7771e95ec58fc6a94b",
        "names": {
            "all": [
                "0xae89b4e1b97661dab58bee7771e95ec58fc6a94b",
            ],
            "default": "0xae89b4e1b97661dab58bee7771e95ec58fc6a94b",
            "ens": {
                "all": [],
                "default": None
            },
            "unstoppabledomains": {
                "all": [],
                "default": None
            }
        },
        "nickname": None,
        "phone_number": "",
        "phone_number_verified": False,
        "picture": "https://cryptoverse.cc/0xae89b4e1b97661dab58bee7771e95ec58fc6a94b.png",
        "preferred_username": "0xae89b4e1b97661dab58bee7771e95ec58fc6a94b",
        "profile": "https://cryptoverse.cc/0xae89b4e1b97661dab58bee7771e95ec58fc6a94b",
        "sub": "0xae89b4e1b97661dab58bee7771e95ec58fc6a94b",
        "website": "https://0xae89b4e1b97661dab58bee7771e95ec58fc6a94b.cryptoverse.cc/",
        "zoneinfo": ""
    }, id_token)


    logging.info("Test Finished")


@pytest.fixture()
def drvr() -> Generator[webdriver.Firefox, None, None]:
    currentdir = os.path.dirname(os.path.abspath(__file__))
    driverpath = os.path.join(currentdir, "tools/geckodriver")
    metamask_path = os.path.join(
        currentdir, "extensions/metamask-firefox-9.1.0.zip"
    )
    logging.info(metamask_path)

    options = FirefoxOptions()
    options.set_capability("se:recordVideo", True)
    options.set_capability("moz:debuggerAddress", True)
    options.add_argument("-headless")

    driver = webdriver.Firefox(
        service=FirefoxService(driverpath), options=options
    )
    driver.install_addon(metamask_path, temporary=True)
    driver.implicitly_wait(60)

    yield driver

    driver.quit()


# @pytest.fixture()
# def driver():
#     currentdir = os.path.dirname(__file__)
#     driverpath = os.path.join(currentdir, "tools/chromedriver")
#     metamask_path = os.path.join(currentdir, "extensions/metamask-chrome-9.1.0.zip")

#     options = webdriver.ChromeOptions()
#     # Chrome does NOT work with extensions in headless mode :(((
#     # options.add_argument("--headless")
#     # options.add_argument("--no-sandbox")
#     options.add_extension(metamask_path)

#     driver = webdriver.Chrome(service=ChromeService(driverpath), options=options)
#     driver.implicitly_wait(10)

#     yield driver

#     driver.quit()
