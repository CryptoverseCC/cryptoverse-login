from select import select
import time

from selenium import webdriver
from .pages import *


def start(driver: webdriver.Firefox) -> None:
    time.sleep(2)
    for handle in driver.window_handles:
        driver.switch_to.window(handle)
        if driver.title == "MetaMask":
            break


def finish(driver: webdriver.Firefox) -> None:
    time.sleep(2)
    for handle in driver.window_handles:
        driver.switch_to.window(handle)
        if not driver.title == "MetaMask":
            break


def init(driver: webdriver.Firefox) -> None:
    start(driver)
    GetStarted(driver).next()
    WalletChoice(driver).import_wallet()
    time.sleep(10)
    ToS(driver).next()
    time.sleep(10)
    ImportForm(driver).next()
    AllDone(driver).next()
    finish(driver)
