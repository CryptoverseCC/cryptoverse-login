import pytest

import _lib


@pytest.fixture
def http():
    """A fresh HTTP client (own cookie jar) per test."""
    return _lib.Http()


@pytest.fixture
def basic_client():
    """An unrestricted OAuth2 client, cleaned up after the test."""
    client = _lib.create_client()
    yield client
    _lib.delete_client(client[0])
