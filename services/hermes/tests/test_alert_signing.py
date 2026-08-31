"""
The alert webhook's authentication.

`send_alert` posted a bare unsigned body until the Hermes route existed to
receive it. Against a Slack-style URL that is correct -- the URL is the
credential. Against a Hermes generic-webhook route it is a guaranteed
`401 {"error": "Invalid signature"}`, which is what the production health
alert would have hit had it ever been configured.

These pin the V2 contract from the Hermes webhook documentation, because the
gateway selects V2 on the presence of the signature header and rejects it
outright when the timestamp is missing -- so "signed, but subtly wrong" and
"not signed at all" fail identically, and only a test tells them apart.
"""

import hashlib
import hmac
import json

from hermes import health


def test_signature_covers_timestamp_dot_body():
    secret = "s" * 64
    body = b'{"status":"degraded"}'

    headers = health.sign_alert(secret, body)

    expected = hmac.new(
        secret.encode(),
        headers["X-Webhook-Timestamp"].encode() + b"." + body,
        hashlib.sha256,
    ).hexdigest()

    assert headers["X-Webhook-Signature-V2"] == expected


def test_timestamp_is_unix_seconds_not_milliseconds():
    # A millisecond timestamp reads as a date tens of thousands of years out and
    # is rejected by any replay window -- with the same 401 a wrong digest gives.
    headers = health.sign_alert("k" * 64, b"{}")
    assert 1_000_000_000 < int(headers["X-Webhook-Timestamp"]) < 10_000_000_000


def test_both_v2_headers_are_sent_together():
    # The gateway rejects a V2 signature that arrives without its timestamp
    # rather than falling back, so neither header is optional.
    headers = health.sign_alert("k" * 64, b"{}")
    assert "X-Webhook-Signature-V2" in headers
    assert "X-Webhook-Timestamp" in headers


def test_unsigned_when_no_secret(monkeypatch):
    """A Slack-style URL is authenticated by being secret. Do not sign it."""
    sent = {}

    class Response:
        status_code = 200

    def fake_post(url, content=None, headers=None, timeout=None):
        sent["headers"] = headers
        return Response()

    import httpx

    monkeypatch.setattr(httpx, "post", fake_post)
    assert health.send_alert("https://hooks.example/x", {"a": 1}, secret="") is True
    assert "X-Webhook-Signature-V2" not in sent["headers"]


def test_body_signed_is_body_sent(monkeypatch):
    """
    The digest covers exact bytes. Serialising twice could reorder keys and
    invalidate a signature that was correct when it was computed.
    """
    sent = {}

    class Response:
        status_code = 200

    def fake_post(url, content=None, headers=None, timeout=None):
        sent["body"] = content
        sent["headers"] = headers
        return Response()

    import httpx

    monkeypatch.setattr(httpx, "post", fake_post)
    secret = "z" * 64
    health.send_alert("http://gw/webhooks/x", {"b": 2, "a": 1}, secret=secret)

    expected = hmac.new(
        secret.encode(),
        sent["headers"]["X-Webhook-Timestamp"].encode() + b"." + sent["body"],
        hashlib.sha256,
    ).hexdigest()
    assert sent["headers"]["X-Webhook-Signature-V2"] == expected
    assert json.loads(sent["body"]) == {"a": 1, "b": 2}


def test_delivery_failure_is_never_fatal(monkeypatch):
    """An unreachable alert endpoint must cost a log line, not an accountant's job."""
    import httpx

    def explode(*a, **k):
        raise httpx.ConnectError("no route to host")

    monkeypatch.setattr(httpx, "post", explode)
    assert health.send_alert("http://gw/webhooks/x", {"a": 1}, secret="k" * 64) is False
