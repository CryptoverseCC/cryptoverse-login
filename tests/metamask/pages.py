import time

from selenium.webdriver.common.by import By
from selenium.webdriver.remote.webelement import WebElement


class BasePage(object):
    def __init__(self, driver):
        self.driver = driver

    def click(self, button_text):
        button: WebElement = self.driver.find_element(
            by=By.XPATH, value='//button[text()="{}"]'.format(button_text)
        )
        button.click()


class GetStarted(BasePage):
    def next(self):
        self.click("Get Started")


class WalletChoice(BasePage):
    def import_wallet(self):
        self.click("Import wallet")


class ToS(BasePage):
    def next(self):
        time.sleep(10)
        self.click("I Agree")
        time.sleep(10)


class ImportForm(BasePage):
    def fill_field(self, by, by_value, value):
        input: WebElement = self.driver.find_element(by=by, value=by_value)
        input.send_keys(value)

    def next(self):
        pas = "selenium_tests"

        self.driver.save_screenshot("screenshots/password.png")

        self.fill_field(
            By.XPATH,
            '//input[@type="password"]',
            "elephant frog rib donate live collect uniform lamp inch urge dish wash",
        )
        self.fill_field(By.ID, "password", pas)
        self.fill_field(By.ID, "confirm-password", pas)

        self.driver.find_element(
            by=By.CLASS_NAME, value="first-time-flow__terms"
        ).click()

        self.click("Import")


class AllDone(BasePage):
    def next(self):
        self.click("All Done")
