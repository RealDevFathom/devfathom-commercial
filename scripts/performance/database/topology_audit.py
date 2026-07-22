#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import http.client
import json
import os
import signal
import socket
import ssl
import struct
import subprocess
import sys
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import asyncpg
from dotenv import dotenv_values
from sqlalchemy import make_url, text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from metrics import (
    application_region,
    classify_database_endpoint,
    estimate_distance,
    redact_text,
    summarize,
)


POSTGRES_SSL_REQUEST_CODE = 80_877_103
READ_ONLY_STATEMENT = "SELECT 1"


class AuditFailure(RuntimeError):
    pass


@dataclass(frozen=True)
class ConnectionSettings:
    database_url: str
    hostname: str
    port: int
    username: str | None
    password: str | None
    database: str | None
    ssl_mode: str | None
    ssl_context: ssl.SSLContext | None
    sqlalchemy_url: Any
    sqlalchemy_connect_args: dict[str, Any]

    @property
    def secrets(self) -> tuple[str, ...]:
        return tuple(
            value
            for value in (
                self.database_url,
                self.hostname,
                self.username,
                self.password,
                self.database,
            )
            if value
        )


def milliseconds_since(started_at: float) -> float:
    return (time.perf_counter() - started_at) * 1_000


def ssl_context_for_mode(ssl_mode: str | None) -> ssl.SSLContext | None:
    if ssl_mode == "disable":
        return None
    if ssl_mode is None:
        return None
    context = ssl.create_default_context()
    if ssl_mode in {"allow", "prefer", "require"}:
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    elif ssl_mode == "verify-ca":
        context.check_hostname = False
    return context


def unverified_probe_context() -> ssl.SSLContext:
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


def connection_settings(database_url: str) -> ConnectionSettings:
    parsed = make_url(database_url)
    if not parsed.host:
        raise AuditFailure("database endpoint is missing")
    if not parsed.drivername.startswith("postgres"):
        raise AuditFailure("database endpoint is not PostgreSQL")

    query = dict(parsed.query)
    ssl_mode = query.pop("sslmode", None)
    query.pop("channel_binding", None)
    context = ssl_context_for_mode(ssl_mode)
    sqlalchemy_url = parsed.set(drivername="postgresql+asyncpg", query=query)
    sqlalchemy_connect_args: dict[str, Any] = {}
    if context is not None:
        sqlalchemy_connect_args["ssl"] = context
    return ConnectionSettings(
        database_url=database_url,
        hostname=parsed.host,
        port=parsed.port or 5432,
        username=parsed.username,
        password=parsed.password,
        database=parsed.database,
        ssl_mode=ssl_mode,
        ssl_context=context,
        sqlalchemy_url=sqlalchemy_url,
        sqlalchemy_connect_args=sqlalchemy_connect_args,
    )


def load_environment(env_file: Path | None) -> dict[str, str]:
    merged = dict(os.environ)
    if env_file is not None:
        loaded = dotenv_values(env_file)
        merged.update(
            {key: value for key, value in loaded.items() if value is not None}
        )
    return merged


def resolve_endpoint(
    hostname: str, port: int
) -> tuple[list[tuple[int, int, int, tuple[Any, ...]]], float]:
    started_at = time.perf_counter()
    records = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    elapsed_ms = milliseconds_since(started_at)
    unique: list[tuple[int, int, int, tuple[Any, ...]]] = []
    seen: set[tuple[int, int, int, tuple[Any, ...]]] = set()
    for family, socktype, protocol, _canonical_name, address in records:
        item = (family, socktype, protocol, address)
        if item not in seen:
            seen.add(item)
            unique.append(item)
    if not unique:
        raise AuditFailure("database endpoint did not resolve")
    return unique, elapsed_ms


def tcp_connect(
    addresses: Iterable[tuple[int, int, int, tuple[Any, ...]]], timeout: float
) -> float:
    started_at = time.perf_counter()
    for family, socktype, protocol, address in addresses:
        connection = socket.socket(family, socktype, protocol)
        connection.settimeout(timeout)
        try:
            connection.connect(address)
        except OSError:
            connection.close()
            continue
        connection.close()
        return milliseconds_since(started_at)
    raise AuditFailure("TCP connection could not be established")


def postgres_tls_handshake(
    addresses: Iterable[tuple[int, int, int, tuple[Any, ...]]],
    hostname: str,
    timeout: float,
) -> tuple[float, float]:
    started_at = time.perf_counter()
    for family, socktype, protocol, address in addresses:
        connection = socket.socket(family, socktype, protocol)
        connection.settimeout(timeout)
        try:
            connection.connect(address)
        except OSError:
            connection.close()
            continue
        tcp_ms = milliseconds_since(started_at)
        handshake_started_at = time.perf_counter()
        try:
            connection.sendall(struct.pack("!II", 8, POSTGRES_SSL_REQUEST_CODE))
            if connection.recv(1) != b"S":
                raise AuditFailure("PostgreSQL endpoint did not accept TLS")
            tls_connection = unverified_probe_context().wrap_socket(
                connection, server_hostname=hostname
            )
            tls_connection.close()
        except Exception:
            connection.close()
            raise
        return tcp_ms, milliseconds_since(handshake_started_at)
    raise AuditFailure("TLS probe could not establish TCP")


async def sample_sync_phase(function: Callable[[], float], samples: int) -> list[float]:
    return [await asyncio.to_thread(function) for _ in range(samples)]


async def measure_network(
    settings: ConnectionSettings,
    warm_samples: int,
    timeout: float,
) -> tuple[dict[str, Any], list[tuple[int, int, int, tuple[Any, ...]]]]:
    dns_values: list[float] = []
    addresses: list[tuple[int, int, int, tuple[Any, ...]]] = []
    for _ in range(warm_samples + 1):
        resolved, elapsed_ms = await asyncio.to_thread(
            resolve_endpoint, settings.hostname, settings.port
        )
        addresses = resolved
        dns_values.append(elapsed_ms)

    tcp_values = await sample_sync_phase(
        lambda: tcp_connect(addresses, timeout), warm_samples + 1
    )
    tls_values: list[float] = []
    if settings.ssl_mode != "disable":
        for _ in range(warm_samples + 1):
            _tcp_ms, tls_ms = await asyncio.to_thread(
                postgres_tls_handshake,
                addresses,
                settings.hostname,
                timeout,
            )
            tls_values.append(tls_ms)

    return (
        {
            "dns_lookup": {
                "cold_ms": round(dns_values[0], 2),
                "warm": summarize(dns_values[1:]),
            },
            "tcp_connection": {
                "cold_ms": round(tcp_values[0], 2),
                "warm": summarize(tcp_values[1:]),
            },
            "postgres_tls_handshake": {
                "cold_ms": round(tls_values[0], 2) if tls_values else None,
                "warm": summarize(tls_values[1:]),
                "status": "measured" if tls_values else "not applicable (TLS disabled)",
            },
        },
        addresses,
    )


def asyncpg_connect_arguments(
    settings: ConnectionSettings, timeout: float
) -> dict[str, Any]:
    arguments: dict[str, Any] = {
        "host": settings.hostname,
        "port": settings.port,
        "timeout": timeout,
    }
    for key, value in (
        ("user", settings.username),
        ("password", settings.password),
        ("database", settings.database),
    ):
        if value is not None:
            arguments[key] = value
    if settings.ssl_context is not None:
        arguments["ssl"] = settings.ssl_context
    return arguments


async def measure_asyncpg(
    settings: ConnectionSettings,
    warm_samples: int,
    timeout: float,
) -> dict[str, Any]:
    connect_started_at = time.perf_counter()
    connection = await asyncpg.connect(**asyncpg_connect_arguments(settings, timeout))
    connect_ms = milliseconds_since(connect_started_at)
    try:
        first_query_started_at = time.perf_counter()
        await connection.fetchval(READ_ONLY_STATEMENT)
        first_query_ms = milliseconds_since(first_query_started_at)
        repeated_query_values: list[float] = []
        for _ in range(warm_samples):
            query_started_at = time.perf_counter()
            await connection.fetchval(READ_ONLY_STATEMENT)
            repeated_query_values.append(milliseconds_since(query_started_at))
    finally:
        await connection.close(timeout=timeout)

    return {
        "new_connection": {
            "connection_establishment_ms": round(connect_ms, 2),
            "first_select_1_ms": round(first_query_ms, 2),
        },
        "reused_connection": {"select_1": summarize(repeated_query_values)},
    }


async def measure_sqlalchemy_pool(
    settings: ConnectionSettings,
    warm_samples: int,
) -> dict[str, Any]:
    engine: AsyncEngine = create_async_engine(
        settings.sqlalchemy_url,
        connect_args=settings.sqlalchemy_connect_args,
        pool_pre_ping=True,
        pool_recycle=1_800,
        pool_size=1,
        max_overflow=0,
    )
    ping_values: list[float] = []
    original_do_ping = engine.sync_engine.dialect.do_ping

    def timed_do_ping(connection: Any) -> bool:
        started_at = time.perf_counter()
        try:
            return original_do_ping(connection)
        finally:
            ping_values.append(milliseconds_since(started_at))

    engine.sync_engine.dialect.do_ping = timed_do_ping
    try:
        checkout_started_at = time.perf_counter()
        connection = await engine.connect()
        cold_checkout_ms = milliseconds_since(checkout_started_at)
        query_started_at = time.perf_counter()
        await connection.execute(text(READ_ONLY_STATEMENT))
        cold_query_ms = milliseconds_since(query_started_at)
        return_started_at = time.perf_counter()
        await connection.close()
        cold_return_ms = milliseconds_since(return_started_at)

        warm_checkout_values: list[float] = []
        warm_query_values: list[float] = []
        checkout_overhead_values: list[float] = []
        return_reset_values: list[float] = []
        for _ in range(warm_samples):
            ping_count_before = len(ping_values)
            checkout_started_at = time.perf_counter()
            connection = await engine.connect()
            checkout_ms = milliseconds_since(checkout_started_at)
            warm_checkout_values.append(checkout_ms)
            ping_ms = ping_values[-1] if len(ping_values) > ping_count_before else 0.0
            checkout_overhead_values.append(max(0.0, checkout_ms - ping_ms))
            query_started_at = time.perf_counter()
            await connection.execute(text(READ_ONLY_STATEMENT))
            warm_query_values.append(milliseconds_since(query_started_at))
            return_started_at = time.perf_counter()
            await connection.close()
            return_reset_values.append(milliseconds_since(return_started_at))
    finally:
        await engine.dispose()

    return {
        "cold": {
            "checkout_and_connection_establishment_ms": round(cold_checkout_ms, 2),
            "first_select_1_ms": round(cold_query_ms, 2),
            "return_and_transaction_reset_ms": round(cold_return_ms, 2),
        },
        "warm": {
            "checkout_total_including_pre_ping": summarize(warm_checkout_values),
            "pool_pre_ping": summarize(ping_values),
            "checkout_overhead_excluding_pre_ping": summarize(checkout_overhead_values),
            "visible_select_1": summarize(warm_query_values),
            "return_and_transaction_reset": summarize(return_reset_values),
        },
    }


def get_free_port() -> int:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    listener.close()
    return int(port)


def wait_for_process_port(
    process: subprocess.Popen[bytes], port: int, timeout: float
) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise AuditFailure("FastAPI process exited before becoming ready")
        connection = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        connection.settimeout(0.25)
        try:
            connection.connect(("127.0.0.1", port))
        except OSError:
            time.sleep(0.05)
        else:
            connection.close()
            return
        finally:
            connection.close()
    raise AuditFailure("FastAPI process did not become ready")


def health_request(connection: http.client.HTTPConnection) -> dict[str, Any]:
    started_at = time.perf_counter()
    connection.request(
        "GET",
        "/health",
        headers={"Accept": "application/json", "Connection": "keep-alive"},
    )
    response = connection.getresponse()
    ttfb_ms = milliseconds_since(started_at)
    body = response.read()
    total_ms = milliseconds_since(started_at)
    try:
        payload = json.loads(body)
    except (TypeError, ValueError):
        payload = {}
    service_status = (
        payload.get("status")
        if payload.get("status") in {"ok", "degraded"}
        else "unknown"
    )
    database_status = (
        payload.get("database")
        if payload.get("database") in {"connected", "not configured", "unavailable"}
        else "unknown"
    )
    return {
        "ttfb_ms": ttfb_ms,
        "total_ms": total_ms,
        "http_status": response.status,
        "service_status": service_status,
        "database_status": database_status,
    }


def stop_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)


async def measure_fastapi_health(
    repository_root: Path,
    environment: dict[str, str],
    warm_samples: int,
    timeout: float,
) -> dict[str, Any]:
    port = get_free_port()
    process_environment = dict(environment)
    process_environment["PYTHONPATH"] = str(repository_root)
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "backend.app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--no-access-log",
            "--log-level",
            "critical",
        ],
        cwd=repository_root,
        env=process_environment,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        await asyncio.to_thread(wait_for_process_port, process, port, timeout)
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
        try:
            cold = await asyncio.to_thread(health_request, connection)
            warm = [
                await asyncio.to_thread(health_request, connection)
                for _ in range(warm_samples)
            ]
        finally:
            connection.close()
    finally:
        await asyncio.to_thread(stop_process, process)

    return {
        "cold": {
            "ttfb_ms": round(cold["ttfb_ms"], 2),
            "total_ms": round(cold["total_ms"], 2),
            "http_status": cold["http_status"],
            "service_status": cold["service_status"],
            "database_status": cold["database_status"],
        },
        "warm": {
            "ttfb": summarize(sample["ttfb_ms"] for sample in warm),
            "total": summarize(sample["total_ms"] for sample in warm),
            "http_statuses": sorted({sample["http_status"] for sample in warm}),
            "service_statuses": sorted({sample["service_status"] for sample in warm}),
            "database_statuses": sorted({sample["database_status"] for sample in warm}),
        },
        "lifecycle": "local HTTP client to isolated FastAPI process using the configured PostgreSQL endpoint",
    }


def warm_p50(measurement: dict[str, Any], *path: str) -> float:
    current: Any = measurement
    for key in path:
        current = current[key]
    return float(current.get("p50_ms") or 0.0)


def component_analysis(
    network: dict[str, Any],
    asyncpg_measurement: dict[str, Any],
    pool: dict[str, Any],
    health: dict[str, Any],
    distance: dict[str, Any],
) -> dict[str, Any]:
    dns_ms = warm_p50(network, "dns_lookup", "warm")
    tcp_ms = warm_p50(network, "tcp_connection", "warm")
    tls_ms = warm_p50(network, "postgres_tls_handshake", "warm")
    connection_ms = float(
        asyncpg_measurement["new_connection"]["connection_establishment_ms"]
    )
    authentication_residual_ms = max(0.0, connection_ms - dns_ms - tcp_ms - tls_ms)

    pre_ping_ms = warm_p50(pool, "warm", "pool_pre_ping")
    query_ms = warm_p50(pool, "warm", "visible_select_1")
    return_reset_ms = warm_p50(pool, "warm", "return_and_transaction_reset")
    checkout_overhead_ms = warm_p50(
        pool, "warm", "checkout_overhead_excluding_pre_ping"
    )
    component_sum_ms = pre_ping_ms + query_ms + return_reset_ms + checkout_overhead_ms
    health_ms = warm_p50(health, "warm", "ttfb")
    repeated_query_ms = warm_p50(asyncpg_measurement, "reused_connection", "select_1")
    query_p95_ms = float(
        asyncpg_measurement["reused_connection"]["select_1"].get("p95_ms") or 0.0
    )

    if (
        distance["condition"] in {"cross-region", "intercontinental cross-region"}
        and repeated_query_ms >= 100
    ):
        principal_cause = "geographic distance on the API-to-database path"
    elif repeated_query_ms >= 100:
        principal_cause = "remote provider network/proxy path; database region relationship needs provider confirmation"
    else:
        principal_cause = "connection and pool lifecycle overhead"

    saturation = (
        "not indicated by stable repeated SELECT 1 samples"
        if repeated_query_ms and query_p95_ms / repeated_query_ms < 1.75
        else "not proven; variance merits provider-side capacity verification"
    )
    return {
        "connection_establishment_breakdown_estimate_ms": {
            "dns_lookup_p50": round(dns_ms, 2),
            "tcp_connection_p50": round(tcp_ms, 2),
            "postgres_tls_handshake_p50": round(tls_ms, 2),
            "authentication_and_provider_routing_residual": round(
                authentication_residual_ms, 2
            ),
            "measured_asyncpg_connection_total": round(connection_ms, 2),
            "note": "Residual is total connection time minus independently sampled DNS, TCP, and TLS phases.",
        },
        "warm_health_breakdown_ms": {
            "pool_checkout_overhead_p50": round(checkout_overhead_ms, 2),
            "pool_pre_ping_p50": round(pre_ping_ms, 2),
            "visible_select_1_p50": round(query_ms, 2),
            "pool_return_and_transaction_reset_p50": round(return_reset_ms, 2),
            "component_sum": round(component_sum_ms, 2),
            "measured_fastapi_health_ttfb_p50": round(health_ms, 2),
            "unattributed_http_and_application_overhead": round(
                max(0.0, health_ms - component_sum_ms), 2
            ),
        },
        "principal_cause": principal_cause,
        "pool_behavior": "pool_pre_ping adds one full database round trip before the health route's SELECT 1",
        "database_saturation_evidence": saturation,
    }


def sanitize_tree(value: Any, secrets: Iterable[str]) -> Any:
    if isinstance(value, dict):
        return {key: sanitize_tree(item, secrets) for key, item in value.items()}
    if isinstance(value, list):
        return [sanitize_tree(item, secrets) for item in value]
    if isinstance(value, str):
        return redact_text(value, secrets)
    return value


async def run_audit(arguments: argparse.Namespace) -> dict[str, Any]:
    repository_root = Path(__file__).resolve().parents[3]
    environment = load_environment(arguments.env_file)
    database_url = environment.get("DATABASE_URL", "")
    if not database_url:
        raise AuditFailure("DATABASE_URL is not configured")
    settings = connection_settings(database_url)

    network, _addresses = await measure_network(
        settings, arguments.warm_samples, arguments.timeout
    )
    asyncpg_measurement = await measure_asyncpg(
        settings, arguments.warm_samples, arguments.timeout
    )
    pool = await measure_sqlalchemy_pool(settings, arguments.warm_samples)
    health = await measure_fastapi_health(
        repository_root,
        environment,
        arguments.warm_samples,
        arguments.timeout,
    )

    app = application_region(
        arguments.application_region or environment.get("VERCEL_REGION")
    )
    database = classify_database_endpoint(settings.hostname)
    distance = estimate_distance(app["region_code"], database["region_code"])
    report = {
        "metadata": {
            "generated_at": datetime.now(UTC).isoformat(),
            "warm_samples": arguments.warm_samples,
            "cold_samples": 1,
            "safety": "Only connection checks and SELECT 1 were executed; identifiers and secrets are omitted.",
        },
        "topology": {
            "application_process": app,
            "database": database,
            "relationship": distance,
        },
        "measurements": {
            **network,
            "direct_asyncpg": asyncpg_measurement,
            "sqlalchemy_pool": pool,
            "fastapi_health": health,
        },
        "analysis": component_analysis(
            network, asyncpg_measurement, pool, health, distance
        ),
    }
    return sanitize_tree(report, settings.secrets)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a redacted, SELECT-1-only PostgreSQL topology audit."
    )
    parser.add_argument(
        "--env-file",
        type=Path,
        help="Environment file to load without copying or printing it.",
    )
    parser.add_argument(
        "--application-region", help="Generic deployment region code, for example sin1."
    )
    parser.add_argument("--warm-samples", type=int, default=20)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument(
        "--output", type=Path, default=Path(".perf/database/latest.json")
    )
    arguments = parser.parse_args()
    if arguments.warm_samples < 20:
        parser.error("--warm-samples must be at least 20")
    if arguments.timeout <= 0:
        parser.error("--timeout must be positive")
    return arguments


def main() -> int:
    arguments = parse_arguments()
    try:
        report = asyncio.run(run_audit(arguments))
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(
            json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
    except Exception as error:
        error_name = type(error).__name__
        sys.stderr.write(
            f"Database topology audit failed safely ({error_name}); no endpoint details were printed.\n"
        )
        return 1
    print(
        "Database topology audit complete; sanitized measurements were written under the ignored .perf directory."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
