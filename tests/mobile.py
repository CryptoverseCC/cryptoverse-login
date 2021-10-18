import unittest
import time
import logging
from appium import webdriver
from appium.webdriver.webelement import WebElement

desired_caps = dict(platformName="Android", automationName="uiautomator2")


logging.basicConfig(level=logging.INFO)


class Utils:
    def find_button(self, text) -> WebElement:

        return self.driver.find_element_by_xpath(
            f'//android.widget.Button[@text="{text}"]'
        )


class Tests(Utils):
    def test_login(self):
        web_login_button = self.driver.find_element_by_xpath(
            '//*[@text="Login with Ethereum Wallet"]'
        )
        web_login_button.click()
        web_wallet_button = self.driver.find_element_by_xpath(
            f'//*[@text="{self.NAME}"]'
        )
        web_wallet_button.click()
        web_select_button = self.driver.find_element_by_xpath('//*[@text="SELECT"]')
        web_select_button.click()

        sign: WebElement = self.driver.find_element_by_id("org.toshi:id/signButton")
        sign.click()


class TestCoinbase(unittest.TestCase, Tests):
    NAME = "Coinbase"

    def setUp(self):
        self.driver = webdriver.Remote("http://localhost:4723/wd/hub", desired_caps)
        self.driver.implicitly_wait(10)
        self.load_login_demo()

    def load_login_demo(self):
        self.driver.activate_app("org.toshi")
        self.find_button("Later").click()
        self.driver.find_element_by_id("org.toshi:id/action_dapps").click()
        address_bar: WebElement = self.driver.find_element_by_id("org.toshi:id/address")
        address_bar.click()
        input: WebElement = self.driver.find_element_by_id("org.toshi:id/userInput")
        time.sleep(1)
        input.send_keys(r"https://login-demo.cryptoverse.cc/\n")
        logging.info(self.driver.contexts)
        self.driver.switch_to.context(self.driver.contexts[-1])


class TestCoinomi(unittest.TestCase, Tests):
    NAME = "Web3"

    def setUp(self):
        self.driver = webdriver.Remote("http://localhost:4723/wd/hub", desired_caps)
        self.driver.implicitly_wait(10)
        self.load_login_demo()

    def load_login_demo(self):
        self.driver.activate_app("com.coinomi.wallet")
        self.find_button("Later").click()
        self.driver.find_element_by_id("org.toshi:id/action_dapps").click()
        address_bar: WebElement = self.driver.find_element_by_id("org.toshi:id/address")
        address_bar.click()
        input: WebElement = self.driver.find_element_by_id("org.toshi:id/userInput")
        time.sleep(1)
        input.send_keys(r"https://login-demo.cryptoverse.cc/\n")
        logging.info(self.driver.contexts)
        self.driver.switch_to.context(self.driver.contexts[-1])


if __name__ == "__main__":
    unittest.main()
