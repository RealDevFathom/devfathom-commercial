from __future__ import annotations

import math
import re
from collections.abc import Iterable, Sequence
from typing import Any


REGION_COORDINATES: dict[str, tuple[float, float, str]] = {
    "ap-southeast-1": (1.3521, 103.8198, "Singapore (AWS ap-southeast-1)"),
    "ap-southeast-2": (-33.8688, 151.2093, "Sydney (AWS ap-southeast-2)"),
    "ap-south-1": (19.076, 72.8777, "Mumbai (AWS ap-south-1)"),
    "eu-central-1": (50.1109, 8.6821, "Frankfurt (AWS eu-central-1)"),
    "eu-west-1": (53.3498, -6.2603, "Dublin (AWS eu-west-1)"),
    "us-east-1": (39.0438, -77.4874, "US East (AWS us-east-1)"),
    "us-east-2": (39.9612, -82.9988, "US East (AWS us-east-2)"),
    "us-west-1": (37.7749, -122.4194, "US West (AWS us-west-1)"),
    "us-west-2": (45.5152, -122.6784, "US West (AWS us-west-2)"),
    "sin1": (1.3521, 103.8198, "Singapore (Vercel sin1)"),
    "bom1": (19.076, 72.8777, "Mumbai (Vercel bom1)"),
    "fra1": (50.1109, 8.6821, "Frankfurt (Vercel fra1)"),
    "iad1": (39.0438, -77.4874, "US East (Vercel iad1)"),
    "pdx1": (45.5152, -122.6784, "US West (Vercel pdx1)"),
    "sfo1": (37.7749, -122.4194, "US West (Vercel sfo1)"),
    "syd1": (-33.8688, 151.2093, "Sydney (Vercel syd1)"),
}

_REGION_PATTERN = re.compile(
    r"\b(?:af|ap|ca|eu|me|sa|us)-(?:central|east|north|northeast|northwest|south|southeast|southwest|west)-\d\b"
)
_DATABASE_URL_PATTERN = re.compile(
    r"(?i)\b(?:postgres(?:ql)?(?:\+asyncpg)?|mysql|mongodb(?:\+srv)?):\/\/[^\s\"'<>]+"
)
_SENSITIVE_FIELD_PATTERN = re.compile(
    r"(?i)\b(host(?:name)?|project(?:_id)?|account(?:_id)?|password|token|authorization)"
    r"\s*[:=]\s*([^\s,;]+)"
)
_DATABASE_FIELD_PATTERN = re.compile(
    r"(?i)\bdatabase_url\s*[:=]\s*(?!\[DATABASE_URL REDACTED\])[^\s,;]+"
)
_HOST_PATTERN = re.compile(r"(?i)\b(?:[a-z0-9-]+\.){2,}[a-z]{2,}\b")
_IPV4_PATTERN = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_BEARER_PATTERN = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")


def percentile(values: Sequence[float], quantile: float) -> float:
    if not values:
        raise ValueError("percentile requires at least one value")
    if not 0 <= quantile <= 1:
        raise ValueError("quantile must be between zero and one")
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def summarize(values: Iterable[float]) -> dict[str, Any]:
    ordered = sorted(
        round(float(value), 2) for value in values if math.isfinite(float(value))
    )
    if not ordered:
        return {
            "samples": 0,
            "values_ms": [],
            "min_ms": None,
            "max_ms": None,
            "mean_ms": None,
            "p50_ms": None,
            "p95_ms": None,
        }
    return {
        "samples": len(ordered),
        "values_ms": ordered,
        "min_ms": ordered[0],
        "max_ms": ordered[-1],
        "mean_ms": round(sum(ordered) / len(ordered), 2),
        "p50_ms": round(percentile(ordered, 0.5), 2),
        "p95_ms": round(percentile(ordered, 0.95), 2),
    }


def redact_text(value: str, secrets: Iterable[str] = ()) -> str:
    redacted = value
    for secret in secrets:
        if secret:
            redacted = redacted.replace(secret, "[REDACTED]")
    redacted = _DATABASE_URL_PATTERN.sub("[DATABASE_URL REDACTED]", redacted)
    redacted = _DATABASE_FIELD_PATTERN.sub(
        "DATABASE_URL=[DATABASE_URL REDACTED]", redacted
    )
    redacted = _BEARER_PATTERN.sub("Bearer [REDACTED]", redacted)
    redacted = _SENSITIVE_FIELD_PATTERN.sub(
        lambda match: f"{match.group(1)}=[REDACTED]", redacted
    )
    redacted = _HOST_PATTERN.sub("[HOST REDACTED]", redacted)
    return _IPV4_PATTERN.sub("[IP REDACTED]", redacted)[:1_000]


def classify_database_endpoint(hostname: str) -> dict[str, str]:
    host = hostname.casefold().rstrip(".")
    if host.endswith(".neon.tech"):
        provider = "Neon"
    elif "supabase" in host:
        provider = "Supabase"
    elif "aivencloud.com" in host:
        provider = "Aiven"
    elif "render.com" in host or "render-postgres.com" in host:
        provider = "Render"
    elif "railway" in host:
        provider = "Railway"
    else:
        provider = "Unclassified managed PostgreSQL"

    if "pooler" in host or "pgbouncer" in host:
        endpoint_category = "provider pooled/proxy endpoint"
    else:
        endpoint_category = "direct or unclassified endpoint"

    region_match = _REGION_PATTERN.search(host)
    region_code = region_match.group(0) if region_match else "undisclosed"
    region_category = REGION_COORDINATES.get(region_code, (0.0, 0.0, region_code))[2]
    if region_code == "undisclosed":
        region_category = "not safely discoverable from endpoint metadata"

    return {
        "provider_category": provider,
        "endpoint_category": endpoint_category,
        "region_code": region_code,
        "region_category": region_category,
    }


def application_region(region_code: str | None) -> dict[str, str]:
    normalized = (region_code or "").casefold()
    if normalized in REGION_COORDINATES:
        return {
            "region_code": normalized,
            "region_category": REGION_COORDINATES[normalized][2],
        }
    return {
        "region_code": "undisclosed",
        "region_category": "not safely discoverable in this process",
    }


def estimate_distance(application_code: str, database_code: str) -> dict[str, Any]:
    if (
        application_code not in REGION_COORDINATES
        or database_code not in REGION_COORDINATES
    ):
        return {
            "estimated_distance_km": None,
            "condition": "region relationship not safely discoverable",
        }

    app_lat, app_lon, _ = REGION_COORDINATES[application_code]
    db_lat, db_lon, _ = REGION_COORDINATES[database_code]
    earth_radius_km = 6_371.0
    latitude_delta = math.radians(db_lat - app_lat)
    longitude_delta = math.radians(db_lon - app_lon)
    haversine = (
        math.sin(latitude_delta / 2) ** 2
        + math.cos(math.radians(app_lat))
        * math.cos(math.radians(db_lat))
        * math.sin(longitude_delta / 2) ** 2
    )
    distance = round(2 * earth_radius_km * math.asin(math.sqrt(haversine)))
    if distance < 100:
        condition = "co-located metro/region"
    elif distance < 1_000:
        condition = "nearby cross-region"
    elif distance < 5_000:
        condition = "cross-region"
    else:
        condition = "intercontinental cross-region"
    return {"estimated_distance_km": distance, "condition": condition}
