import logging
import os
import time
from pathlib import Path
from urllib.parse import urlparse

import pytest
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.webdriver import Service as FirefoxService
from selenium.webdriver.remote.webelement import WebElement

import metamask

logging.basicConfig(level=logging.INFO)

AUTH_DOMAIN = os.getenv("DOMAIN_LOGIN", "login.cryptoverse.cc")
DEMO_APP_DOMAIN = os.getenv("DOMAIN_DEMO_APP", "login-demo.cryptoverse.cc")
ASSETS_PATH = os.getenv("ASSETS_PATH", "./assets")

os.makedirs(ASSETS_PATH, exist_ok=True)

def switch_to(driver, title):
    for handle in driver.window_handles:
        driver.switch_to.window(handle)
        logging.info("Switching to: {}".format(driver.title))
        if driver.title == title:
            break


def focus_on_auth_frame(driver):
    auth_frame = driver.find_element(by=By.XPATH, value="//body/iframe")
    driver.switch_to.frame(auth_frame)


def get_current_domain(driver) -> str:
    url = driver.current_url
    return urlparse(url).netloc


def click(driver, xpath):
    button: WebElement = driver.find_element(by=By.XPATH, value=xpath)
    button.click()
    time.sleep(2)


snap_counter = 0
def snap(driver, name):
    global snap_counter
    snap_counter += 1
    path = Path(ASSETS_PATH) / "{}_{}.png".format(snap_counter, name)
    if driver.save_screenshot(str(path)):
        logging.info("Screenshot saved to {}".format(path))
    else:
        logging.error("Screenshot saving failed")


async def test_initial(driver):
    assert AUTH_DOMAIN is not None
    assert DEMO_APP_DOMAIN is not None

    # Setup Metamask
    metamask.init(driver)

    # Load Initial Page
    driver.get("https://{}?auth_domain={}".format(DEMO_APP_DOMAIN, AUTH_DOMAIN))
    snap(driver, "demo_app_loaded")

    # Start Authentication Flow
    click(driver, '//*[text()="Login with Ethereum Wallet"]')
    assert get_current_domain(driver) == AUTH_DOMAIN
    time.sleep(20)
    snap(driver, "login_page_loaded")

    # Select Wallet Type
    focus_on_auth_frame(driver)
    click(driver, '//*[text()="Ethereum Wallet"]')
    time.sleep(1)
    snap(driver, "after_wallet_select")

    # Select Wallet Provider
    click(driver, '//*[text()="MetaMask"]')
    time.sleep(1)
    snap(driver, "after_metamask_selected")
    switch_to(driver, "MetaMask Notification")
    click(driver, '//button[text()="Next"]')
    click(driver, '//button[text()="Connect"]')
    time.sleep(5)
    switch_to(driver, "login-demo.cryptoverse.cc - Login with Ethereum Wallet")
    time.sleep(5)
    snap(driver, "after_wallet_connected")

    # Use specific address for login
    focus_on_auth_frame(driver)
    click(driver, '//*[text()="0xae89b4e1b97661dab58bee7771e95ec58fc6a94b"]')
    switch_to(driver, "MetaMask Notification")
    click(driver, '//button[text()="Sign"]')
    switch_to(driver, "login-demo.cryptoverse.cc - Login with Ethereum Wallet")
    snap(driver, "after_wallet_sign")

    # Wait for login redirects and final page
    time.sleep(20)
    snap(driver, "final_page_loaded")
    # Check if we logged in successfully
    element = driver.find_element(
        by=By.XPATH,
        value='//pre[text()="0xae89b4e1b97661dab58bee7771e95ec58fc6a94b"]',
    )
    logging.info("Login successful for: {}".format(element.text))
    logging.info("Test Finished")


@pytest.fixture()
def driver():
    from selenium.webdriver.firefox.options import Options

    currentdir = os.path.dirname(os.path.abspath(__file__))
    driverpath = os.path.join(currentdir, "tools/geckodriver")
    metamask_path = os.path.join(
        currentdir, "extensions/metamask-firefox-9.1.0.zip"
    )
    logging.info(metamask_path)

    options = Options()
    options.set_capability("se:recordVideo", True)
    options.set_capability("moz:debuggerAddress", True)
    options.log.level = "debug"
    options.headless = True

    driver = webdriver.Firefox(
        service=FirefoxService(driverpath), options=options
    )
    driver.install_addon(metamask_path, temporary=True)
    driver.implicitly_wait(10)

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
