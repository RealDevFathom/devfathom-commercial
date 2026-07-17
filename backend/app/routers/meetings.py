import os
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncConnection

from ..collaboration_schemas import MeetingCreate, MeetingUpdate
from ..database import connection, row_dict, statement
from ..security import Principal, current_principal
from .collaboration_common import (
    collaboration_audit_event,
    fetch_all,
    fetch_one,
    insert_activity,
    json_text,
    new_id,
    require_meeting_access,
    require_scope,
    utcnow,
)

router = APIRouter(prefix="/api/v1/meetings", tags=["meetings"])


def _database_datetime(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(UTC).replace(tzinfo=None)


def _api_datetime(value: datetime) -> datetime:
    """Expose Prisma's naive UTC timestamps as unambiguous API datetimes."""
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _add_occurrence(value: datetime, recurrence: str) -> datetime:
    if recurrence == "daily":
        return value + timedelta(days=1)
    if recurrence == "weekly":
        return value + timedelta(days=7)
    if recurrence == "biweekly":
        return value + timedelta(days=14)
    if recurrence == "monthly":
        year = value.year + (value.month // 12)
        month = value.month % 12 + 1
        # JavaScript Date.setMonth overflows short months (Jan 31 -> Mar 3),
        # which is the recurrence behavior the legacy router persisted.
        first = value.replace(year=year, month=month, day=1)
        return first + timedelta(days=value.day - 1)
    return value


def find_relevant_occurrence(
    original_start: datetime, original_end: datetime, recurrence: str | None, now: datetime
) -> dict[str, datetime]:
    if not recurrence:
        return {"start": original_start, "end": original_end}
    duration = original_end - original_start
    current = original_start
    previous: dict[str, datetime] | None = None
    for _ in range(5000):
        occurrence = {"start": current, "end": current + duration}
        if occurrence["start"] <= now < occurrence["end"]:
            return occurrence
        if occurrence["start"] > now:
            return previous or occurrence
        previous = occurrence
        next_value = _add_occurrence(current, recurrence)
        if next_value == current:
            return {"start": original_start, "end": original_end}
        current = next_value
    return previous or {"start": original_start, "end": original_end}


def get_next_occurrence(
    original_start: datetime, original_end: datetime, recurrence: str, after: datetime
) -> dict[str, datetime] | None:
    duration = original_end - original_start
    current = original_start
    for _ in range(365):
        end = current + duration
        if end > after:
            return {"start": current, "end": end}
        next_value = _add_occurrence(current, recurrence)
        if next_value == current:
            return None
        current = next_value
    return None


def punctuality_label(start: datetime, joined: datetime) -> str:
    minutes = round((joined - start).total_seconds() / 60)
    if minutes < -1:
        return f"{abs(minutes)} min early"
    if minutes <= 10:
        return "on time"
    return f"{minutes} min late"


async def _meeting_row(db: AsyncConnection, meeting_id: str) -> dict[str, Any]:
    row = await fetch_one(
        db,
        'SELECT id, title, description, "startTime", "endTime", location, recurrence, '
        '"createdById", "createdAt", "updatedAt" FROM meetings WHERE id = :id',
        {"id": meeting_id},
    )
    if not row:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return row


async def _meeting_outs(
    db: AsyncConnection,
    meetings: list[tuple[dict[str, Any], dict[str, datetime] | None]],
) -> list[dict[str, Any]]:
    if not meetings:
        return []
    resolved = [
        (
            meeting,
            occurrence
            or {
                "start": meeting["startTime"],
                "end": meeting["endTime"],
            },
        )
        for meeting, occurrence in meetings
    ]
    attendees = await fetch_all(
        db,
        "WITH requested AS (SELECT * FROM jsonb_to_recordset(CAST(:requests AS jsonb)) "
        "AS item(id text, occurrence timestamp)) "
        'SELECT ma."meetingId", ma.id, ma."userId", l."joinedAt", '
        "jsonb_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar, 'title', u.title) AS user "
        'FROM requested JOIN meeting_attendees ma ON ma."meetingId" = requested.id '
        'JOIN users u ON u.id = ma."userId" '
        'LEFT JOIN meeting_attendance_log l ON l."meetingId" = ma."meetingId" '
        'AND l."userId" = ma."userId" AND l."occurrenceStart" = requested.occurrence '
        'ORDER BY ma."meetingId", ma.id',
        {
            "requests": json_text(
                [{"id": meeting["id"], "occurrence": occurrence["start"]} for meeting, occurrence in resolved]
            )
        },
    )
    attendees_by_id: dict[str, list[dict[str, Any]]] = {}
    for attendee in attendees:
        attendees_by_id.setdefault(attendee.pop("meetingId"), []).append(attendee)
    return [
        dict(
            meeting,
            startTime=_api_datetime(occurrence["start"]),
            endTime=_api_datetime(occurrence["end"]),
            attendees=attendees_by_id.get(meeting["id"], []),
        )
        for meeting, occurrence in resolved
    ]


async def _meeting_out(
    db: AsyncConnection, meeting: dict[str, Any], occurrence: dict[str, datetime] | None = None
) -> dict[str, Any]:
    return (await _meeting_outs(db, [(meeting, occurrence)]))[0]


@router.get("/upcoming")
async def get_upcoming(
    principal: Principal = Depends(current_principal), db: AsyncConnection = Depends(connection)
) -> list[dict[str, Any]]:
    await require_scope(principal, "meetings:read")
    now = utcnow()
    meetings = await fetch_all(
        db,
        'SELECT DISTINCT m.id, m.title, m.description, m."startTime", m."endTime", m.location, '
        'm.recurrence, m."createdById", m."createdAt", m."updatedAt" FROM meetings m '
        'JOIN meeting_attendees ma ON ma."meetingId" = m.id WHERE ma."userId" = :user_id '
        'AND (m."endTime" >= :now OR m.recurrence IS NOT NULL)',
        {"user_id": principal.id, "now": now},
    )
    resolved: list[tuple[dict[str, Any], dict[str, datetime]]] = []
    for meeting in meetings:
        if meeting["recurrence"]:
            occurrence = get_next_occurrence(meeting["startTime"], meeting["endTime"], meeting["recurrence"], now)
            if occurrence:
                resolved.append((meeting, occurrence))
        else:
            resolved.append((meeting, {"start": meeting["startTime"], "end": meeting["endTime"]}))
    resolved.sort(key=lambda item: item[1]["start"])
    return await _meeting_outs(db, resolved[:50])


@router.get("")
async def get_all(
    limit: int | None = Query(None, ge=1, le=1000),
    cursor: str | None = None,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> list[dict[str, Any]]:
    await require_scope(principal, "meetings:read")
    params: dict[str, Any] = {"user_id": principal.id}
    cursor_clause = ""
    if cursor:
        cursor_clause = ' AND (m."startTime", m.id) < (SELECT "startTime", id FROM meetings WHERE id = :cursor)'
        params["cursor"] = cursor
    sql = (
        'SELECT m.id, m.title, m.description, m."startTime", m."endTime", m.location, '
        'm.recurrence, m."createdById", m."createdAt", m."updatedAt" FROM meetings m '
        'WHERE EXISTS(SELECT 1 FROM meeting_attendees ma WHERE ma."meetingId" = m.id '
        'AND ma."userId" = :user_id)' + cursor_clause + ' ORDER BY m."startTime" DESC, m.id DESC'
    )
    if limit is not None:
        sql += " LIMIT :limit"
        params["limit"] = limit
    meetings = await fetch_all(db, sql, params)
    now = utcnow()
    return await _meeting_outs(
        db,
        [
            (
                meeting,
                find_relevant_occurrence(meeting["startTime"], meeting["endTime"], meeting["recurrence"], now),
            )
            for meeting in meetings
        ],
    )


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_meeting(
    payload: MeetingCreate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    await require_scope(principal, "meetings:write")
    user = await fetch_one(db, "SELECT id FROM users WHERE id = :id", {"id": principal.id})
    if not user:
        raise HTTPException(status_code=401, detail="Session expired. Please log in again.")
    meeting_id = new_id()
    now = utcnow()
    attendee_ids = list(dict.fromkeys([principal.id, *payload.attendee_ids]))
    try:
        result = await db.execute(
            statement(
                'INSERT INTO meetings (id, title, description, "startTime", "endTime", location, '
                'recurrence, "createdById", "createdAt", "updatedAt") VALUES '
                "(:id, :title, :description, :start_time, :end_time, :location, :recurrence, "
                ":creator, :now, :now) RETURNING *"
            ),
            {
                "id": meeting_id,
                "title": payload.title,
                "description": payload.description,
                "start_time": _database_datetime(payload.start_time),
                "end_time": _database_datetime(payload.end_time),
                "location": payload.location,
                "recurrence": payload.recurrence,
                "creator": principal.id,
                "now": now,
            },
        )
        for user_id in attendee_ids:
            await db.execute(
                statement(
                    'INSERT INTO meeting_attendees (id, "meetingId", "userId") '
                    'VALUES (:id, :meeting_id, :user_id) ON CONFLICT ("meetingId", "userId") DO NOTHING'
                ),
                {"id": new_id(), "meeting_id": meeting_id, "user_id": user_id},
            )
        await collaboration_audit_event(
            db,
            principal,
            category="MEETINGS",
            operation="CREATE",
            action="meetings.create",
            target_type="Meeting",
            target_id=meeting_id,
            target_label=payload.title,
            input_data=payload.model_dump(by_alias=True, mode="json"),
        )
        await db.commit()
        return await _meeting_out(db, dict(result.mappings().one()))
    except Exception:
        await db.rollback()
        raise


@router.get("/{meeting_id}")
async def get_meeting(
    meeting_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    await require_scope(principal, "meetings:read")
    await require_meeting_access(db, meeting_id, principal)
    return await _meeting_out(db, await _meeting_row(db, meeting_id))


@router.post("/{meeting_id}/call-token")
async def get_call_token(
    meeting_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, str]:
    await require_scope(principal, "meetings:write")
    meeting = await require_meeting_access(db, meeting_id, principal)
    app_id = os.getenv("NEXT_PUBLIC_JAAS_APP_ID")
    kid = os.getenv("JAAS_KID")
    private_key = os.getenv("JAAS_PRIVATE_KEY", "").replace("\\n", "\n")
    if not app_id or not kid or not private_key:
        raise HTTPException(status_code=412, detail="Video calling is not configured.")
    user = await fetch_one(db, "SELECT avatar FROM users WHERE id = :id", {"id": principal.id})
    issued_at = int(datetime.now(UTC).timestamp())
    moderator = principal.role == "ADMIN" or meeting["createdById"] == principal.id
    token = jwt.encode(
        {
            "aud": "jitsi",
            "iss": "chat",
            "sub": app_id,
            "room": f"meeting-{meeting_id}",
            "iat": issued_at,
            "nbf": issued_at - 5,
            "exp": issued_at + 7200,
            "context": {
                "user": {
                    "id": principal.id,
                    "name": principal.name,
                    "email": principal.email,
                    "avatar": user["avatar"] if user else None,
                    "moderator": moderator,
                },
                "features": {
                    "recording": False,
                    "transcription": False,
                    "livestreaming": False,
                    "outbound-call": False,
                },
            },
        },
        private_key,
        algorithm="RS256",
        headers={"alg": "RS256", "kid": kid, "typ": "JWT"},
    )
    return {"jwt": token, "roomName": f"{app_id}/meeting-{meeting_id}"}


@router.patch("/{meeting_id}")
async def update_meeting(
    meeting_id: str,
    payload: MeetingUpdate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    await require_scope(principal, "meetings:write")
    await require_meeting_access(db, meeting_id, principal, manage=True)
    meeting = await _meeting_row(db, meeting_id)
    values = payload.model_dump(exclude_unset=True)
    if not values:
        raise HTTPException(status_code=422, detail="No meeting fields were supplied")
    start = _database_datetime(values.get("start_time", meeting["startTime"]))
    end = _database_datetime(values.get("end_time", meeting["endTime"]))
    if end <= start:
        raise HTTPException(status_code=422, detail="endTime must be after startTime")
    try:
        await db.execute(
            statement(
                'UPDATE meetings SET title = :title, description = :description, "startTime" = :start_time, '
                '"endTime" = :end_time, location = :location, recurrence = :recurrence, "updatedAt" = :now '
                "WHERE id = :id"
            ),
            {
                "id": meeting_id,
                "title": values.get("title", meeting["title"]),
                "description": values.get("description", meeting["description"]),
                "start_time": start,
                "end_time": end,
                "location": values.get("location", meeting["location"]),
                "recurrence": values.get("recurrence", meeting["recurrence"]),
                "now": utcnow(),
            },
        )
        if "attendee_ids" in values:
            await db.execute(statement('DELETE FROM meeting_attendees WHERE "meetingId" = :id'), {"id": meeting_id})
            for user_id in dict.fromkeys([principal.id, *(values["attendee_ids"] or [])]):
                await db.execute(
                    statement(
                        'INSERT INTO meeting_attendees (id, "meetingId", "userId") VALUES (:id, :meeting_id, :user_id)'
                    ),
                    {"id": new_id(), "meeting_id": meeting_id, "user_id": user_id},
                )
        await collaboration_audit_event(
            db,
            principal,
            category="MEETINGS",
            operation="UPDATE",
            action="meetings.update",
            target_type="Meeting",
            target_id=meeting_id,
            target_label=values.get("title", meeting["title"]),
            changes={key: True for key in values},
        )
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return await _meeting_out(db, await _meeting_row(db, meeting_id))


@router.delete("/{meeting_id}")
async def delete_meeting(
    meeting_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    await require_scope(principal, "meetings:write")
    await require_meeting_access(db, meeting_id, principal, manage=True)
    result = await db.execute(statement("DELETE FROM meetings WHERE id = :id RETURNING *"), {"id": meeting_id})
    await collaboration_audit_event(
        db,
        principal,
        category="MEETINGS",
        operation="DELETE",
        action="meetings.delete",
        target_type="Meeting",
        target_id=meeting_id,
    )
    await db.commit()
    return row_dict(result.mappings().one())


async def _record_join(
    db: AsyncConnection, meeting_id: str, principal: Principal, *, attendee_only: bool
) -> dict[str, Any]:
    meeting = await require_meeting_access(db, meeting_id, principal)
    if attendee_only and not meeting["attendee"]:
        raise HTTPException(status_code=403, detail="You are not an attendee of this meeting.")
    now = utcnow()
    occurrence = find_relevant_occurrence(meeting["startTime"], meeting["endTime"], meeting["recurrence"], now)
    if now < occurrence["start"] - timedelta(minutes=5):
        return {"skipped": "too_early", "occurrence": occurrence, "alreadyJoined": False}
    if now > occurrence["end"]:
        return {"skipped": "too_late", "occurrence": occurrence, "alreadyJoined": False}
    result = await db.execute(
        statement(
            "INSERT INTO meeting_attendance_log "
            '(id, "meetingId", "userId", "occurrenceStart", "joinedAt", "createdAt") '
            "VALUES (:id, :meeting_id, :user_id, :occurrence, :now, :now) "
            'ON CONFLICT ("meetingId", "userId", "occurrenceStart") DO NOTHING RETURNING "joinedAt"'
        ),
        {
            "id": new_id(),
            "meeting_id": meeting_id,
            "user_id": principal.id,
            "occurrence": occurrence["start"],
            "now": now,
        },
    )
    created = result.mappings().first()
    if created:
        joined_at = created["joinedAt"]
        already_joined = False
        await db.execute(
            statement(
                'UPDATE meeting_attendees SET "joinedAt" = :now WHERE "meetingId" = :meeting_id AND "userId" = :user_id'
            ),
            {"now": now, "meeting_id": meeting_id, "user_id": principal.id},
        )
        await insert_activity(
            db,
            principal,
            type="meeting_joined",
            message=f'joined meeting "{meeting["title"]}" ({punctuality_label(occurrence["start"], now)})',
            entity_type="Meeting",
            entity_id=meeting_id,
        )
    else:
        existing = await fetch_one(
            db,
            'SELECT "joinedAt" FROM meeting_attendance_log WHERE "meetingId" = :meeting_id '
            'AND "userId" = :user_id AND "occurrenceStart" = :occurrence',
            {
                "meeting_id": meeting_id,
                "user_id": principal.id,
                "occurrence": occurrence["start"],
            },
        )
        joined_at = existing["joinedAt"] if existing else now
        already_joined = True
    await collaboration_audit_event(
        db,
        principal,
        category="MEETINGS",
        operation="EXECUTE",
        action="meetings.join",
        target_type="Meeting",
        target_id=meeting_id,
        metadata={"alreadyJoined": already_joined, "occurrenceStart": occurrence["start"]},
    )
    await db.commit()
    return {"joinedAt": joined_at, "alreadyJoined": already_joined, "occurrence": occurrence}


@router.post("/{meeting_id}/join")
async def mark_joined(
    meeting_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    await require_scope(principal, "meetings:write")
    return await _record_join(db, meeting_id, principal, attendee_only=True)


@router.post("/{meeting_id}/call/join")
async def log_join(
    meeting_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    await require_scope(principal, "meetings:write")
    result = await _record_join(db, meeting_id, principal, attendee_only=False)
    result.pop("occurrence", None)
    return result


@router.post("/{meeting_id}/call/leave")
async def log_leave(
    meeting_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    await require_scope(principal, "meetings:write")
    meeting = await require_meeting_access(db, meeting_id, principal)
    now = utcnow()
    occurrence = find_relevant_occurrence(meeting["startTime"], meeting["endTime"], meeting["recurrence"], now)
    result = await db.execute(
        statement(
            'UPDATE meeting_attendance_log SET "leftAt" = :now WHERE "meetingId" = :meeting_id '
            'AND "userId" = :user_id AND "occurrenceStart" = :occurrence AND "leftAt" IS NULL'
        ),
        {
            "now": now,
            "meeting_id": meeting_id,
            "user_id": principal.id,
            "occurrence": occurrence["start"],
        },
    )
    await collaboration_audit_event(
        db,
        principal,
        category="MEETINGS",
        operation="EXECUTE",
        action="meetings.leave",
        target_type="Meeting",
        target_id=meeting_id,
        metadata={"left": result.rowcount > 0},
    )
    await db.commit()
    return {"left": result.rowcount > 0}


@router.get("/{meeting_id}/attendance")
async def attendance_report(
    meeting_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    await require_scope(principal, "meetings:read")
    await require_meeting_access(db, meeting_id, principal)
    logs = await fetch_all(
        db,
        'SELECT l."userId", l."occurrenceStart", l."joinedAt", '
        "jsonb_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar) AS user "
        'FROM meeting_attendance_log l JOIN users u ON u.id = l."userId" '
        'WHERE l."meetingId" = :id',
        {"id": meeting_id},
    )
    held = len({row["occurrenceStart"] for row in logs}) or 1
    by_user: dict[str, dict[str, Any]] = {}
    for log in logs:
        entry = by_user.setdefault(log["userId"], {"user": log["user"], "attended": 0, "lastJoinedAt": None})
        entry["attended"] += 1
        if entry["lastJoinedAt"] is None or log["joinedAt"] > entry["lastJoinedAt"]:
            entry["lastJoinedAt"] = log["joinedAt"]
    attendees = [dict(entry, rate=round(entry["attended"] / held * 100)) for entry in by_user.values()]
    attendees.sort(key=lambda entry: entry["attended"], reverse=True)
    return {"heldOccurrences": held, "attendees": attendees}
