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
    snap_counter = 0

    def tearDown(self) -> None:
        self.driver.quit()
        return super().tearDown()

    def switch_to(self, title):
        for handle in self.driver.window_handles:
            self.driver.switch_to.window(handle)
            print(self.driver.title)
            if self.driver.title == title:
                break

    def focus_on_auth_frame(self):
        auth_frame = self.driver.find_element(by=By.XPATH, value="//body/iframe")
        self.driver.switch_to.frame(auth_frame)

    def get_current_domain(self) -> str:
        url = self.driver.current_url
        return urlparse(url).netloc

    def click(self, xpath):
        button: WebElement = self.driver.find_element(by=By.XPATH, value=xpath)
        button.click()
        time.sleep(2)

    def snap(self, name):
        self.snap_counter += 1
        self.driver.save_screenshot("/tmp/screenshots/{}_{}.png".format(self.snap_counter, name))


class Base(Utils):
    AUTH_DOMAIN = None
    DEMO_APP_DOMAIN = None

    def test_initial(self):
        assert self.AUTH_DOMAIN is not None
        assert self.DEMO_APP_DOMAIN is not None

        self.driver.get(
            "https://{}?auth_domain={}".format(self.DEMO_APP_DOMAIN, self.AUTH_DOMAIN)
        )

        self.snap("demo_app_loaded")

        self.click('//*[text()="Login with Ethereum Wallet"]')

        assert self.get_current_domain() == self.AUTH_DOMAIN

        time.sleep(2)

        self.snap("login_page_loaded")

        self.focus_on_auth_frame()

        self.click('//*[text()="Ethereum Wallet"]')

        self.snap("after_wallet_select")

        self.click('//*[text()="MetaMask"]')

        self.snap("after_metamask_select")

        self.switch_to("MetaMask Notification")

        self.click('//button[text()="Next"]')

        self.click('//button[text()="Connect"]')

        time.sleep(5)

        self.switch_to("login-demo.cryptoverse.cc - Login with Ethereum Wallet")

        time.sleep(5)

        self.focus_on_auth_frame()

        time.sleep(5)

        self.snap("after_wallet_connect")

        self.click('//*[text()="0xae89b4e1b97661dab58bee7771e95ec58fc6a94b"]')

        self.switch_to("MetaMask Notification")

        self.click('//button[text()="Sign"]')

        self.switch_to("login-demo.cryptoverse.cc - Login with Ethereum Wallet")

        time.sleep(5)

        self.snap("after_wallet_sign")

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
    auth_domain = os.getenv("DOMAIN_LOGIN", "login.cryptoverse.cc")
    demo_app_domain = os.getenv("DOMAIN_DEMO_APP", "login-demo.cryptoverse.cc")

    TestChrome.DEMO_APP_DOMAIN = demo_app_domain
    TestChrome.AUTH_DOMAIN = auth_domain

    TestFirefox.DEMO_APP_DOMAIN = demo_app_domain
    TestFirefox.AUTH_DOMAIN = auth_domain

    unittest.main()
