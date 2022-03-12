import os
import time
import unittest
import logging
import metamask
from urllib.parse import urlparse

from selenium import webdriver
from selenium.webdriver.firefox.webdriver import Service as FirefoxService
from selenium.webdriver.chrome.webdriver import Service as ChromeService
from selenium.webdriver.common.by import By

from selenium.webdriver.remote.webelement import WebElement

logging.basicConfig(level=logging.INFO)


class Utils:
    def tearDown(self) -> None:
        self.driver.quit()
        return super().tearDown()

    def switch_to(self, title):
        for handle in self.driver.window_handles:
            self.driver.switch_to.window(handle)
            print(self.driver.title)
            if self.driver.title == title:
                break

    def get_current_domain(self) -> str:
        url = self.driver.current_url
        return urlparse(url).netloc

    def click(self, xpath):
        button: WebElement = self.driver.find_element(by=By.XPATH, value=xpath)
        button.click()
        time.sleep(2)


class Base(Utils):
    def test_initial(self):
        self.driver.get("https://login-demo.cryptoverse.cc")

        self.click('//*[text()="Login with Ethereum Wallet"]')

        assert self.get_current_domain() == "login.cryptoverse.cc"

        auth_frame = self.driver.find_element_by_css_selector("body>iframe")
        self.driver.switch_to.frame(auth_frame)

        self.driver.save_screenshot("ala.kota.png")

        self.click('//*[text()="Ethereum Wallet"]')

        self.click('//*[text()="MetaMask"]')

        self.switch_to("MetaMask Notification")

        self.click('//button[text()="Next"]')

        self.click('//button[text()="Connect"]')

        time.sleep(5)

        self.switch_to("login-demo.cryptoverse.cc - Login with Ethereum Wallet")

        time.sleep(5)

        auth_frame = self.driver.find_element_by_css_selector("body>iframe")
        self.driver.switch_to.frame(auth_frame)

        time.sleep(5)

        self.click('//*[text()="0xae89b4e1b97661dab58bee7771e95ec58fc6a94b"]')

        self.switch_to("MetaMask Notification")

        self.click('//button[text()="Sign"]')

        self.switch_to("login-demo.cryptoverse.cc - Login with Ethereum Wallet")

        # Check if we logged in successfully
        self.driver.find_element(
            by=By.XPATH,
            value='//pre[text()="0xae89b4e1b97661dab58bee7771e95ec58fc6a94b"]',
        )


class TestFirefox(Base, unittest.TestCase):
    def setUp(self):
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

        self.driver = webdriver.Firefox(
            service=FirefoxService(driverpath), options=options
        )
        self.driver.install_addon(metamask_path, temporary=True)
        self.driver.implicitly_wait(10)

        metamask.init(self.driver)


class TestChrome(Base, unittest.TestCase):
    def setUp(self):
        currentdir = os.path.dirname(__file__)
        driverpath = os.path.join(currentdir, "tools/chromedriver")
        metamask_path = os.path.join(currentdir, "extensions/metamask-chrome-9.1.0.zip")

        self.driver = webdriver.Chrome(service=ChromeService(driverpath))
        self.driver.install_addon(metamask_path, temporary=True)
        self.driver.implicitly_wait(10)

        metamask.init(self.driver)


if __name__ == "__main__":
    unittest.main()
