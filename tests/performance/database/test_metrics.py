import math

import pytest

from scripts.performance.database.metrics import (
    classify_database_endpoint,
    estimate_distance,
    percentile,
    redact_text,
    summarize,
)


def test_percentile_uses_linear_interpolation() -> None:
    values = [1, 2, 3, 4, 5]

    assert percentile(values, 0.5) == 3
    assert percentile(values, 0.95) == pytest.approx(4.8)


def test_summary_filters_non_finite_values_and_reports_p50_and_p95() -> None:
    result = summarize([5, 1, 4, math.nan, 2, math.inf, 3])

    assert result == {
        "samples": 5,
        "values_ms": [1.0, 2.0, 3.0, 4.0, 5.0],
        "min_ms": 1.0,
        "max_ms": 5.0,
        "mean_ms": 3.0,
        "p50_ms": 3.0,
        "p95_ms": 4.8,
    }


def test_redaction_removes_database_urls_hosts_ips_and_identifiers() -> None:
    password = "fake-password-for-redaction"
    value = (
        "DATABASE_URL=postgresql://user:fake-password-for-redaction@"
        "ep-fake-project-pooler.us-east-2.aws.neon.tech/db "
        "hostname=ep-fake-project-pooler.us-east-2.aws.neon.tech "
        "project_id=fake-project account_id=fake-account token=fake-token "
        "ip=192.0.2.10 Authorization: Bearer fake.jwt.token"
    )

    redacted = redact_text(value, [password])

    for secret in (
        password,
        "fake-project",
        "fake-account",
        "fake-token",
        "ep-fake-project-pooler.us-east-2.aws.neon.tech",
        "192.0.2.10",
    ):
        assert secret not in redacted
    assert "[DATABASE_URL REDACTED]" in redacted


def test_provider_classification_returns_categories_without_endpoint_identifier() -> (
    None
):
    endpoint = "ep-fake-project-pooler.us-east-2.aws.neon.tech"

    result = classify_database_endpoint(endpoint)

    assert result == {
        "provider_category": "Neon",
        "endpoint_category": "provider pooled/proxy endpoint",
        "region_code": "us-east-2",
        "region_category": "US East (AWS us-east-2)",
    }
    assert "fake-project" not in repr(result)


def test_distance_classifies_same_metro_and_intercontinental_topologies() -> None:
    assert estimate_distance("sin1", "ap-southeast-1") == {
        "estimated_distance_km": 0,
        "condition": "co-located metro/region",
    }

    intercontinental = estimate_distance("sin1", "us-east-2")

    assert intercontinental["estimated_distance_km"] > 10_000
    assert intercontinental["condition"] == "intercontinental cross-region"


def test_distance_does_not_guess_when_region_is_undisclosed() -> None:
    assert estimate_distance("sin1", "undisclosed") == {
        "estimated_distance_km": None,
        "condition": "region relationship not safely discoverable",
    }
