import pytest
from backend.app import database
from backend.app.config import Settings
from pydantic import ValidationError
from sqlalchemy.pool import NullPool

POOL_ENVIRONMENT_VARIABLES = (
    "DATABASE_POOL_MODE",
    "DATABASE_POOL_SIZE",
    "DATABASE_POOL_MAX_OVERFLOW",
    "DATABASE_POOL_RECYCLE_SECONDS",
    "DATABASE_POOL_PRE_PING",
)


@pytest.fixture(autouse=True)
def clear_pool_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for variable in POOL_ENVIRONMENT_VARIABLES:
        monkeypatch.delenv(variable, raising=False)


def test_persistent_service_uses_bounded_pool_by_default() -> None:
    settings = Settings(_env_file=None)

    assert database._pool_options(settings) == {
        "pool_pre_ping": True,
        "pool_recycle": 1800,
        "pool_size": 5,
        "max_overflow": 5,
    }


def test_null_pool_omits_queue_pool_only_options() -> None:
    settings = Settings(_env_file=None, database_pool_mode="null")

    assert database._pool_options(settings) == {"poolclass": NullPool}


def test_environment_can_select_null_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_POOL_MODE", "null")

    settings = Settings(_env_file=None)

    assert database._pool_options(settings) == {"poolclass": NullPool}


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("database_pool_mode", "unbounded"),
        ("database_pool_size", 0),
        ("database_pool_max_overflow", -1),
        ("database_pool_recycle_seconds", 0),
        ("database_pool_pre_ping", "sometimes"),
    ],
)
def test_invalid_pool_settings_fail_validation(field: str, value: object) -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **{field: value})


def test_absent_database_url_does_not_create_engine(monkeypatch: pytest.MonkeyPatch) -> None:
    def unexpected_engine_creation(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("engine creation should be skipped")

    monkeypatch.setattr(database, "create_async_engine", unexpected_engine_creation)

    assert database._create_engine(Settings(_env_file=None, database_url="")) is None


@pytest.mark.asyncio
async def test_engine_disposal_closes_pooled_connections(monkeypatch: pytest.MonkeyPatch) -> None:
    class Engine:
        disposed = False

        async def dispose(self) -> None:
            self.disposed = True

    engine = Engine()
    monkeypatch.setattr(database, "engine", engine)

    await database.dispose_engine()

    assert engine.disposed is True
