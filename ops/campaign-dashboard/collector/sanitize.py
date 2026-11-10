"""Payload sanitizer shared by the collectors and the dashboard server.

This file is intentionally duplicated byte-for-byte at server/sanitize.py so each
component can be deployed on its own; tests/test_sanitize.py asserts the copies match.

Rules:
  * drop any dict key that looks sensitive (tokens, secrets, contact data, IPs, hosts, URLs)
  * redact strings that look like IPv4/IPv6 addresses, e-mails, GitHub/OpenAI/Slack tokens, JWTs
  * strip absolute paths down to the part after /workspace/jobs/
"""

import re

SENSITIVE_KEY = re.compile(
    r"token|secret|password|passwd|apikey|api_key|authorization|cookie|credential"
    r"|private|email|phone|ip(v4|v6)?$|host$|url$",
    re.IGNORECASE,
)

_IPV4 = r"(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])"
_H = r"[0-9A-Fa-f]{1,4}"
_IPV6 = (
    r"(?<![0-9A-Fa-f:])(?:"
    rf"(?:{_H}:){{7}}{_H}"  # full form
    rf"|(?:{_H}:){{1,7}}:(?:{_H}(?::{_H}){{0,6}})?"  # compressed with leading groups
    rf"|::(?:{_H}(?::{_H}){{0,6}})?"  # compressed with leading ::
    r")(?:%[0-9A-Za-z]+)?(?![0-9A-Fa-f:])"
)
_EMAIL = r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"
_TOKENS = (
    r"\bgh[pousr]_[A-Za-z0-9]{16,}"
    r"|\bgithub_pat_[A-Za-z0-9_]{20,}"
    r"|\bsk-[A-Za-z0-9_\-]{12,}"
    r"|\bxox[abposr]-[A-Za-z0-9\-]{8,}"
    r"|\blin_api_[A-Za-z0-9]{16,}"
    r"|\beyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}"
)
REDACT = re.compile(rf"{_TOKENS}|{_EMAIL}|{_IPV4}|{_IPV6}")
JOBS_PREFIX = re.compile(r"(?:[A-Za-z]:)?[^\s\"'=:]*?/workspace/jobs/")

MAX_DEPTH = 40
MAX_STRING = 4000


def scrub_string(value):
    """Redact sensitive-looking substrings and shorten /workspace/jobs/ paths."""
    if not isinstance(value, str):
        return value
    if len(value) > MAX_STRING:
        value = value[:MAX_STRING] + "…"
    value = JOBS_PREFIX.sub("", value)
    return REDACT.sub("[redacted]", value)


def is_sensitive_key(key):
    return isinstance(key, str) and bool(SENSITIVE_KEY.search(key))


def sanitize(obj, _depth=0):
    """Return a sanitized deep copy of a JSON-like value."""
    if _depth > MAX_DEPTH:
        return None
    if isinstance(obj, dict):
        out = {}
        for key, val in obj.items():
            skey = str(key)
            if is_sensitive_key(skey):
                continue
            out[scrub_string(skey)] = sanitize(val, _depth + 1)
        return out
    if isinstance(obj, (list, tuple)):
        return [sanitize(v, _depth + 1) for v in obj]
    if isinstance(obj, str):
        return scrub_string(obj)
    if isinstance(obj, (bool, int, float)) or obj is None:
        return obj
    return scrub_string(str(obj))
