import time

from selenium.webdriver.remote.webdriver import WebDriver
from .pages import *


def start(driver: WebDriver):
    time.sleep(2)
    for handle in driver.window_handles:
        driver.switch_to.window(handle)
        if driver.title == "MetaMask":
            break


def finish(driver):
    time.sleep(2)
    for handle in driver.window_handles:
        driver.switch_to.window(handle)
        if not driver.title == "MetaMask":
            break


def init(driver):
    start(driver)
    GetStarted(driver).next()
    WalletChoice(driver).import_wallet()
    ToS(driver).next()
    ImportForm(driver).next()
    AllDone(driver).next()
    finish(driver)
