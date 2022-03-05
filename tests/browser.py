import logging
import os
import profile
import time
import unittest
from urllib.parse import urlparse

from selenium import webdriver
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.common.by import By
from selenium.webdriver.remote.webelement import WebElement

import metamask

logging.basicConfig(level=logging.INFO)

HUB_PORT = os.getenv("HUB_PORT")
DRIVER_URL = f"https://localhost:{HUB_PORT}/wd/hub"


def get_driver(options):
    return webdriver.Remote(command_executor=DRIVER_URL, options=options)


class Utils:
    def tearDown(self) -> None:
        self.driver.quit()
        return super().tearDown()

    def switch_to(self, title):
        for handle in self.driver.window_handles:
            self.driver.switch_to.window(handle)
            if self.driver.title == title:
                break

    def get_current_domain(self) -> str:
        url = self.driver.current_url
        return urlparse(url).netloc

    def click(self, xpath):
        button: WebElement = self.driver.find_element(by=By.XPATH, value=xpath)
        button.click()


class Base(Utils):
    def test_initial(self):
        self.driver.get("https://login-demo.cryptoverse.cc")

        self.click('//*[text()="Login with Ethereum Wallet"]')

        assert self.get_current_domain() == "login.cryptoverse.cc"

        auth_frame = self.driver.find_element_by_css_selector("body>iframe")
        self.driver.switch_to.frame(auth_frame)

        self.click('//*[text()="MetaMask"]')

        time.sleep(0.1)

        self.switch_to("MetaMask Notification")

        self.click('//button[text()="Next"]')

        self.click('//button[text()="Connect"]')

        self.switch_to("Cryptoverse Login")

        auth_frame = self.driver.find_element_by_css_selector("body>iframe")
        self.driver.switch_to.frame(auth_frame)

        self.click('//*[text()="0xae89b4e1b97661dab58bee7771e95ec58fc6a94b"]')

        self.switch_to("MetaMask Notification")

        self.click('//button[text()="Sign"]')

        self.switch_to("Cryptoverse Login")

        # Check if we logged in successfully
        self.driver.find_element(
            by=By.XPATH,
            value='//pre[text()="0xae89b4e1b97661dab58bee7771e95ec58fc6a94b"]',
        )


class TestFirefox(Base, unittest.TestCase):
    def setUp(self):
        from selenium.webdriver.firefox.options import Options

        currentdir = os.path.dirname(os.path.abspath(__file__))
        metamask_path = os.path.join(currentdir, "extensions/metamask-firefox-9.1.0")
        logging.info(metamask_path)

        profile = webdriver.FirefoxProfile()
        profile.add_extension(metamask_path)

        options = webdriver.FirefoxOptions()
        options.profile = profile

        self.driver = get_driver(options)
        self.driver.install_addon(metamask_path)
        self.driver.implicitly_wait(10)

        metamask.init(self.driver)


class TestChrome(Base, unittest.TestCase):
    def setUp(self):
        currentdir = os.path.dirname(__file__)
        metamask_path = os.path.join(currentdir, "extensions/metamask-chrome-9.1.0.zip")

        options = ChromeOptions()
        options.add_extension(extension=metamask_path)

        self.driver = get_driver(options)
        self.driver.implicitly_wait(10)

        metamask.init(self.driver)


if __name__ == "__main__":
    unittest.main()
