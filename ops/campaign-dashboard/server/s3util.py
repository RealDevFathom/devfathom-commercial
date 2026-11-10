"""Minimal S3 get/put with stdlib + task-role credentials (no boto3).

Used to persist dashboard ingest and the last AI analysis across Fargate deploys.
Never logs credentials, request signatures, or object bodies.
"""
from __future__ import annotations

import datetime
import hashlib
import hmac
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def log(msg):
    print(f"[s3] {msg}", file=sys.stderr, flush=True)


def _env(name, default=""):
    return (os.environ.get(name) or default).strip()


def creds_from_env():
    key, secret = _env("AWS_ACCESS_KEY_ID"), _env("AWS_SECRET_ACCESS_KEY")
    if not key or not secret:
        return None
    return {"access": key, "secret": secret, "token": _env("AWS_SESSION_TOKEN") or None}


def creds_from_ecs():
    rel = _env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")
    full = _env("AWS_CONTAINER_CREDENTIALS_FULL_URI")
    url = full or (f"http://169.254.170.2{rel}" if rel else "")
    if not url:
        return None
    headers = {}
    auth = _env("AWS_CONTAINER_AUTHORIZATION_TOKEN")
    if auth:
        headers["Authorization"] = auth
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read().decode())
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return None
    key, secret = data.get("AccessKeyId"), data.get("SecretAccessKey")
    if not key or not secret:
        return None
    return {"access": key, "secret": secret, "token": data.get("Token")}


def load_creds():
    return creds_from_env() or creds_from_ecs()


def _sign(key, msg):
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _sigv4_key(secret, datestamp, region, service):
    k = _sign(("AWS4" + secret).encode("utf-8"), datestamp)
    k = hmac.new(k, region.encode(), hashlib.sha256).digest()
    k = hmac.new(k, service.encode(), hashlib.sha256).digest()
    return hmac.new(k, b"aws4_request", hashlib.sha256).digest()


def _host(bucket, region):
    if region == "us-east-1":
        return f"{bucket}.s3.amazonaws.com"
    return f"{bucket}.s3.{region}.amazonaws.com"


def request(method, bucket, key, body=None, region=None, content_type="application/json"):
    region = region or _env("AWS_REGION") or _env("AWS_DEFAULT_REGION") or "ap-southeast-1"
    creds = load_creds()
    if not creds:
        return None, "no-credentials"
    host = _host(bucket, region)
    path = "/" + "/".join(urllib.parse.quote(p, safe="-._~") for p in key.split("/") if p)
    now = datetime.datetime.utcnow()
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    datestamp = now.strftime("%Y%m%d")
    payload = body if body is not None else b""
    if isinstance(payload, str):
        payload = payload.encode()
    payload_hash = hashlib.sha256(payload).hexdigest()
    headers = {
        "host": host,
        "x-amz-date": amz_date,
        "x-amz-content-sha256": payload_hash,
        "content-type": content_type,
    }
    if creds.get("token"):
        headers["x-amz-security-token"] = creds["token"]
    if method in ("PUT", "POST"):
        headers["content-length"] = str(len(payload))
    signed_header_names = ";".join(sorted(headers))
    canonical_headers = "".join(f"{k}:{headers[k]}\n" for k in sorted(headers))
    canonical = f"{method}\n{path}\n\n{canonical_headers}\n{signed_header_names}\n{payload_hash}"
    scope = f"{datestamp}/{region}/s3/aws4_request"
    string_to_sign = f"AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}"
    signature = hmac.new(_sigv4_key(creds["secret"], datestamp, region, "s3"),
                         string_to_sign.encode(), hashlib.sha256).hexdigest()
    headers["Authorization"] = (
        f"AWS4-HMAC-SHA256 Credential={creds['access']}/{scope}, "
        f"SignedHeaders={signed_header_names}, Signature={signature}"
    )
    url = f"https://{host}{path}"
    req = urllib.request.Request(url, data=payload if method in ("PUT", "POST") else None, method=method)
    for k, v in headers.items():
        if k == "host":
            continue
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.read(), None
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None, "not-found"
        return None, f"http-{exc.code}"
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return None, type(exc).__name__


class S3Backup:
    """Best-effort durable copy of DATA_DIR JSON files."""

    def __init__(self, env=None):
        env = env if env is not None else os.environ
        self.bucket = (env.get("OPS_STATE_S3_BUCKET") or "").strip()
        self.prefix = (env.get("OPS_STATE_S3_PREFIX") or "ops-dashboard/state").strip().strip("/")
        self.region = (env.get("AWS_REGION") or env.get("AWS_DEFAULT_REGION") or "ap-southeast-1").strip()
        self.enabled = bool(self.bucket)

    def key(self, name):
        return f"{self.prefix}/{name}"

    def get_json(self, name):
        if not self.enabled:
            return None
        body, err = request("GET", self.bucket, self.key(name), region=self.region)
        if err or not body:
            if err and err not in ("not-found", "no-credentials"):
                log(f"get {name} failed: {err}")
            return None
        try:
            data = json.loads(body.decode())
        except ValueError:
            log(f"get {name} returned invalid JSON")
            return None
        return data if isinstance(data, dict) else None

    def put_json(self, name, obj):
        if not self.enabled:
            return False
        body = json.dumps(obj, separators=(",", ":")).encode()
        _, err = request("PUT", self.bucket, self.key(name), body=body, region=self.region)
        if err:
            log(f"put {name} failed: {err}")
            return False
        return True
