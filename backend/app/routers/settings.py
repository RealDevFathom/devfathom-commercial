from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncConnection

from ..config import Settings, get_settings
from ..database import connection
from ..security import bearer
from ..services.settings_bootstrap import load_settings_bootstrap_for_credentials

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("/bootstrap")
async def get_settings_bootstrap(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: AsyncConnection = Depends(connection),
    settings: Settings = Depends(get_settings),
) -> dict:
    if not credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Bearer token required",
        )
    return await load_settings_bootstrap_for_credentials(credentials.credentials, db, settings)
