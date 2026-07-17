from collections.abc import Callable
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection

from ..database import connection, row_dict, rows, statement
from ..schemas_people import (
    LeaveBalanceSet,
    LeaveCreate,
    LeaveDecision,
    MemberUpdate,
    PerformanceNoteCreate,
    ProfileUpdate,
    ResignationCreate,
    ResignationDecision,
    ReviewAssignment,
    ReviewCycleCreate,
    ReviewSubmit,
)
from ..security import Principal, require_scope
from .firm_common import as_naive_utc, audit_event, lock_active_admin_invariant, new_id, require_roles, utcnow_naive

router = APIRouter(tags=["team and HR"])
team_read = require_scope("team:read")
team_write = require_scope("team:write")


def leave_days(start: datetime, end: datetime) -> int:
    return max(1, (end.date() - start.date()).days + 1)


@router.get("/api/team")
async def list_team(principal: Principal = Depends(team_read), db: AsyncConnection = Depends(connection)) -> dict:
    result = await db.execute(
        statement(
            "SELECT id, name, email, role::text role, department::text department, title, avatar, phone, bio, skills, "
            '"startDate", status::text status, "lastActiveAt", '
            '(SELECT count(*) FROM project_members pm WHERE pm."userId" = users.id) AS "projectCount", '
            '(SELECT count(*) FROM task_assignees ta WHERE ta."userId" = users.id) AS "taskCount" '
            "FROM users ORDER BY name"
        )
    )
    data = rows(result)
    if principal.role not in {"ADMIN", "HR"}:
        for member in data:
            if member["id"] != principal.id:
                member["email"] = ""
                member["phone"] = None
    return {"data": data}


@router.get("/api/team/stats/overview")
async def team_stats_overview(
    principal: Principal = Depends(team_read), db: AsyncConnection = Depends(connection)
) -> dict:
    require_roles(principal, "ADMIN")
    now = utcnow_naive()
    week_ago = now - timedelta(days=7)
    two_weeks_ago = now - timedelta(days=14)
    thirty_days_ago = now - timedelta(days=30)

    member_result = await db.execute(
        statement(
            """
            SELECT u.id AS "userId", u.name, u.avatar, u.title, u."lastActiveAt",
              (SELECT count(*) FROM task_assignees ta JOIN tasks t ON t.id = ta."taskId"
               JOIN columns c ON c.id = t."columnId"
               WHERE ta."userId" = u.id AND c.name <> 'Done') AS "openTasks",
              (SELECT count(*) FROM task_assignees ta JOIN tasks t ON t.id = ta."taskId"
               JOIN columns c ON c.id = t."columnId"
               WHERE ta."userId" = u.id AND c.name = 'Done' AND t."updatedAt" >= :week_ago)
               AS "completedThisWeek",
              (SELECT count(*) FROM task_assignees ta JOIN tasks t ON t.id = ta."taskId"
               JOIN columns c ON c.id = t."columnId"
               WHERE ta."userId" = u.id AND c.name = 'Done'
                 AND t."updatedAt" >= :two_weeks_ago AND t."updatedAt" < :week_ago)
               AS "completedLastWeek",
              (SELECT count(*) FROM task_assignees ta JOIN tasks t ON t.id = ta."taskId"
               JOIN columns c ON c.id = t."columnId"
               WHERE ta."userId" = u.id AND c.name <> 'Done' AND t."dueDate" < :now)
               AS "overdueTasks",
              (SELECT round((avg(extract(epoch FROM (t."updatedAt" - t."createdAt"))) / 86400)::numeric, 1)
               FROM task_assignees ta JOIN tasks t ON t.id = ta."taskId"
               JOIN columns c ON c.id = t."columnId"
               WHERE ta."userId" = u.id AND c.name = 'Done'
                 AND t."updatedAt" >= t."createdAt" AND t."updatedAt" < t."createdAt" + interval '365 days')
               AS "avgCycleTimeDays",
              (SELECT count(*) FROM meeting_attendees ma JOIN meetings m ON m.id = ma."meetingId"
               WHERE ma."userId" = u.id AND m."startTime" < :now) AS "meetingsInvited",
              (SELECT count(*) FROM meeting_attendance_log ml
               WHERE ml."userId" = u.id AND ml."occurrenceStart" < :now) AS "meetingsAttended",
              (SELECT round(avg(greatest(0, extract(epoch FROM (ml."joinedAt" - ml."occurrenceStart"))) / 60)::numeric, 1)
               FROM meeting_attendance_log ml WHERE ml."userId" = u.id AND ml."occurrenceStart" < :now)
               AS "avgMinutesLate",
              (SELECT round(100.0 * count(*) FILTER (
                  WHERE ml."joinedAt" <= ml."occurrenceStart" + interval '5 minutes') / nullif(count(*), 0))
               FROM meeting_attendance_log ml WHERE ml."userId" = u.id AND ml."occurrenceStart" < :now)
               AS "onTimePercent",
              (SELECT count(*) FROM notes n WHERE n."authorId" = u.id) AS "notesAuthored",
              (SELECT count(*) FROM project_members pm JOIN projects p ON p.id = pm."projectId"
               WHERE pm."userId" = u.id AND p.status IN ('ACTIVE', 'IN_DEVELOPMENT')) AS "projectsActive",
              (SELECT count(*) FROM task_comments tc
               WHERE tc."userId" = u.id AND tc."createdAt" >= :week_ago) AS "commentsThisWeek"
            FROM users u
            WHERE u.status = 'ACTIVE'
            ORDER BY u.name
            """
        ),
        {"now": now, "week_ago": week_ago, "two_weeks_ago": two_weeks_ago},
    )
    members = rows(member_result)

    sparkline_result = await db.execute(
        statement(
            """
            SELECT ta."userId", to_char(t."updatedAt", 'YYYY-MM-DD') AS day, count(*) AS count
            FROM task_assignees ta JOIN tasks t ON t.id = ta."taskId"
            JOIN columns c ON c.id = t."columnId"
            WHERE c.name = 'Done' AND t."updatedAt" >= :week_ago
            GROUP BY ta."userId", day
            """
        ),
        {"week_ago": week_ago},
    )
    sparkline_lookup = {(row["userId"], row["day"]): int(row["count"]) for row in rows(sparkline_result)}
    spark_days = [(now - timedelta(days=offset)).date().isoformat() for offset in range(6, -1, -1)]

    for member in members:
        for field in (
            "openTasks",
            "completedThisWeek",
            "completedLastWeek",
            "overdueTasks",
            "meetingsInvited",
            "meetingsAttended",
            "notesAuthored",
            "projectsActive",
            "commentsThisWeek",
        ):
            member[field] = int(member[field] or 0)
        for field in ("avgCycleTimeDays", "avgMinutesLate", "onTimePercent"):
            member[field] = float(member[field]) if member[field] is not None else None
        member["tasksDoneSparkline"] = [sparkline_lookup.get((member["userId"], day), 0) for day in spark_days]

    velocity_result = await db.execute(
        statement(
            """
            SELECT to_char(t."updatedAt", 'YYYY-MM-DD') AS day, count(*) AS count
            FROM tasks t JOIN columns c ON c.id = t."columnId"
            WHERE c.name = 'Done' AND t."updatedAt" >= :thirty_days_ago
            GROUP BY day ORDER BY day
            """
        ),
        {"thirty_days_ago": thirty_days_ago},
    )
    velocity_lookup = {row["day"]: int(row["count"]) for row in rows(velocity_result)}
    velocity_days = [(now - timedelta(days=offset)).date().isoformat() for offset in range(29, -1, -1)]
    velocity = [{"date": day, "count": velocity_lookup.get(day, 0)} for day in velocity_days]

    alerts = []
    for member in members:
        if member["openTasks"] == 0:
            alerts.append(
                {
                    "userId": member["userId"],
                    "name": member["name"],
                    "severity": "high",
                    "kind": "no_tasks",
                    "message": "has no active tasks assigned",
                }
            )
        if member["completedThisWeek"] == 0 and member["openTasks"] > 0:
            alerts.append(
                {
                    "userId": member["userId"],
                    "name": member["name"],
                    "severity": "medium",
                    "kind": "no_progress",
                    "message": "hasn't moved anything to Done in the last 7 days",
                }
            )
        if member["overdueTasks"] > 0:
            count = member["overdueTasks"]
            alerts.append(
                {
                    "userId": member["userId"],
                    "name": member["name"],
                    "severity": "medium" if count >= 3 else "low",
                    "kind": "overdue",
                    "message": f"has {count} overdue task{'s' if count != 1 else ''}",
                }
            )
    alerts.sort(key=lambda alert: {"high": 0, "medium": 1, "low": 2}[alert["severity"]])

    def top_by(field: str, *, require: Callable[[dict], bool] | None = None, reverse: bool = True) -> list[dict]:
        eligible = [member for member in members if (require(member) if require else member[field] is not None)]
        return sorted(eligible, key=lambda member: member[field] or 0, reverse=reverse)[:3]

    leaderboards = {
        "topCompleter": top_by("completedThisWeek", require=lambda item: item["completedThisWeek"] > 0),
        "bestPunctuality": top_by(
            "onTimePercent", require=lambda item: item["onTimePercent"] is not None and item["meetingsAttended"] >= 2
        ),
        "mostCollaborative": sorted(
            [member for member in members if member["commentsThisWeek"] + member["notesAuthored"] > 0],
            key=lambda item: item["commentsThisWeek"] + item["notesAuthored"],
            reverse=True,
        )[:3],
        "fastestCycle": top_by("avgCycleTimeDays", reverse=False),
    }
    totals = {
        "teamCompletedThisWeek": sum(member["completedThisWeek"] for member in members),
        "teamCompletedLastWeek": sum(member["completedLastWeek"] for member in members),
        "teamOpenTasks": sum(member["openTasks"] for member in members),
        "teamOverdue": sum(member["overdueTasks"] for member in members),
        "teamMembers": len(members),
        "membersWithNoTasks": sum(1 for member in members if member["openTasks"] == 0),
    }
    return {
        "data": {
            "members": members,
            "alerts": alerts,
            "velocity": velocity,
            "leaderboards": leaderboards,
            "totals": totals,
        }
    }


@router.get("/api/team/{user_id}")
async def get_member(
    user_id: str, principal: Principal = Depends(team_read), db: AsyncConnection = Depends(connection)
) -> dict:
    result = await db.execute(
        statement(
            "SELECT id, name, email, role::text role, department::text department, title, avatar, phone, bio, skills, "
            '"startDate", status::text status, "lastActiveAt" FROM users WHERE id = :id'
        ),
        {"id": user_id},
    )
    member = result.mappings().first()
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")
    data = row_dict(member)
    if principal.role not in {"ADMIN", "HR"} and principal.id != user_id:
        data["email"] = ""
        data["phone"] = None
    project_result = await db.execute(
        statement(
            "SELECT p.id, p.name, p.type::text type, p.status::text status, pm.role "
            'FROM project_members pm JOIN projects p ON p.id = pm."projectId" '
            'WHERE pm."userId" = :id ORDER BY p."updatedAt" DESC'
        ),
        {"id": user_id},
    )
    task_result = await db.execute(
        statement(
            'SELECT t.id, t.title, t.priority::text priority, c.name AS "columnName" '
            'FROM task_assignees ta JOIN tasks t ON t.id = ta."taskId" '
            'JOIN columns c ON c.id = t."columnId" WHERE ta."userId" = :id '
            'ORDER BY t."updatedAt" DESC LIMIT 12'
        ),
        {"id": user_id},
    )
    data["projects"] = rows(project_result)
    data["tasks"] = rows(task_result)
    if principal.role in {"ADMIN", "HR"} or principal.id == user_id:
        leave_result = await db.execute(
            statement(
                'SELECT id, type::text type, "startDate", "endDate", status::text status, reason '
                'FROM leave_requests WHERE "userId" = :id ORDER BY "startDate" DESC'
            ),
            {"id": user_id},
        )
        data["leaveRequests"] = rows(leave_result)
    else:
        data["leaveRequests"] = []
    return {"data": data}


@router.patch("/api/team/me")
async def update_profile(
    payload: ProfileUpdate, principal: Principal = Depends(team_write), db: AsyncConnection = Depends(connection)
) -> dict:
    supplied = payload.model_fields_set
    if not supplied:
        raise HTTPException(status_code=422, detail="No fields were supplied")
    values = payload.model_dump(include=supplied)
    values.update({"id": principal.id, "now": utcnow_naive()})
    assignments = [f'"{key}" = :{key}' for key in supplied] + ['"updatedAt" = :now']
    result = await db.execute(
        statement(
            f"UPDATE users SET {', '.join(assignments)} WHERE id = :id RETURNING id, name, email, phone, bio, skills"
        ),
        values,
    )
    await audit_event(
        db,
        principal,
        category="TEAM",
        operation="UPDATE",
        action="team.updateProfile",
        target_type="User",
        target_id=principal.id,
        input_data=values,
    )
    await db.commit()
    return {"data": row_dict(result.mappings().one())}


@router.patch("/api/team/{user_id}/admin")
async def admin_update_member(
    user_id: str,
    payload: MemberUpdate,
    principal: Principal = Depends(team_write),
    db: AsyncConnection = Depends(connection),
) -> dict:
    require_roles(principal, "ADMIN")
    supplied = payload.model_fields_set
    if (payload.role is not None and payload.role != "ADMIN") or (
        payload.status is not None and payload.status != "ACTIVE"
    ):
        await lock_active_admin_invariant(db)
    current_result = await db.execute(
        statement("SELECT name, role::text role, status::text status FROM users WHERE id = :id FOR UPDATE"),
        {"id": user_id},
    )
    current = current_result.mappings().first()
    if not current:
        raise HTTPException(status_code=404, detail="Member not found")
    demoting = payload.role is not None and payload.role != "ADMIN"
    deactivating = payload.status is not None and payload.status != "ACTIVE"
    if current["role"] == "ADMIN" and (demoting or deactivating):
        count = await db.execute(
            statement("SELECT COUNT(*) FROM users WHERE id <> :id AND role = 'ADMIN' AND status = 'ACTIVE'"),
            {"id": user_id},
        )
        if count.scalar_one() == 0:
            raise HTTPException(status_code=400, detail="Cannot demote or deactivate the last active admin")
    values = payload.model_dump(include=supplied)
    values.update({"id": user_id, "now": utcnow_naive()})
    assignments = [f'"{key}" = :{key}' for key in supplied] + ['"updatedAt" = :now']
    result = await db.execute(
        statement(
            f"UPDATE users SET {', '.join(assignments)} WHERE id = :id RETURNING id, name, email, role::text role, department::text department, title, phone, bio, skills, status::text status"
        ),
        values,
    )
    record = result.mappings().one()
    await audit_event(
        db,
        principal,
        category="TEAM",
        operation="UPDATE",
        action="team.adminUpdateMember",
        target_type="User",
        target_id=user_id,
        target_label=record["name"],
        input_data=values,
        changes={
            key: {"before": current.get(key), "after": values[key]}
            for key in supplied
            if key in current and current.get(key) != values[key]
        },
    )
    await db.commit()
    return {"data": row_dict(record)}


@router.get("/api/hr/leave")
async def list_leave(
    status_filter: str | None = None,
    limit: int = Query(100, ge=1, le=1000),
    principal: Principal = Depends(team_read),
    db: AsyncConnection = Depends(connection),
) -> dict:
    require_roles(principal, "ADMIN", "HR")
    clause = "WHERE l.status = :status" if status_filter else ""
    result = await db.execute(
        statement(
            'SELECT l.*, u.name AS "userName", u.avatar AS "userAvatar", u.department::text AS "userDepartment", '
            'u.title AS "userTitle", a.name AS "approvedByName" FROM leave_requests l JOIN users u ON u.id = l."userId" '
            f'LEFT JOIN users a ON a.id = l."approvedById" {clause} ORDER BY l."createdAt" DESC LIMIT :limit'
        ),
        {"status": status_filter, "limit": limit},
    )
    return {"data": rows(result)}


@router.get("/api/hr/leave/mine")
async def my_leave(principal: Principal = Depends(team_read), db: AsyncConnection = Depends(connection)) -> dict:
    result = await db.execute(
        statement('SELECT * FROM leave_requests WHERE "userId" = :id ORDER BY "createdAt" DESC'), {"id": principal.id}
    )
    return {"data": rows(result)}


@router.post("/api/hr/leave", status_code=status.HTTP_201_CREATED)
async def create_leave(
    payload: LeaveCreate, principal: Principal = Depends(team_write), db: AsyncConnection = Depends(connection)
) -> dict:
    start_date = as_naive_utc(payload.start_date)
    end_date = as_naive_utc(payload.end_date)
    today = utcnow_naive().date()
    if start_date.date() < today:
        raise HTTPException(status_code=400, detail="Leave cannot start in the past")
    overlap = await db.execute(
        statement(
            'SELECT id FROM leave_requests WHERE "userId" = :user_id AND status IN (\'PENDING\',\'APPROVED\') AND "startDate" <= :end_date AND "endDate" >= :start_date LIMIT 1'
        ),
        {"user_id": principal.id, "start_date": start_date, "end_date": end_date},
    )
    if overlap.first():
        raise HTTPException(status_code=409, detail="This request overlaps existing pending or approved leave")
    leave_id = new_id()
    result = await db.execute(
        statement(
            'INSERT INTO leave_requests (id, "userId", type, "startDate", "endDate", status, reason, "createdAt", "updatedAt") VALUES (:id, :user_id, :type, :start_date, :end_date, \'PENDING\', :reason, now(), now()) RETURNING *'
        ),
        {
            "id": leave_id,
            "user_id": principal.id,
            **payload.model_dump(exclude={"start_date", "end_date"}),
            "start_date": start_date,
            "end_date": end_date,
        },
    )
    await audit_event(
        db,
        principal,
        category="TEAM",
        operation="CREATE",
        action="team.createLeaveRequest",
        target_type="LeaveRequest",
        target_id=leave_id,
        input_data=payload.model_dump(mode="json"),
    )
    await db.commit()
    return {"data": row_dict(result.mappings().one())}


@router.delete("/api/hr/leave/{leave_id}")
async def cancel_leave(
    leave_id: str, principal: Principal = Depends(team_write), db: AsyncConnection = Depends(connection)
) -> dict:
    result = await db.execute(
        statement(
            "DELETE FROM leave_requests WHERE id = :id AND \"userId\" = :user_id AND status = 'PENDING' RETURNING id"
        ),
        {"id": leave_id, "user_id": principal.id},
    )
    if not result.first():
        raise HTTPException(status_code=400, detail="Only your own pending leave can be cancelled")
    await audit_event(
        db,
        principal,
        category="TEAM",
        operation="DELETE",
        action="team.cancelLeaveRequest",
        target_type="LeaveRequest",
        target_id=leave_id,
    )
    await db.commit()
    return {"success": True}


@router.patch("/api/hr/leave/{leave_id}/decision")
async def decide_leave(
    leave_id: str,
    payload: LeaveDecision,
    principal: Principal = Depends(team_write),
    db: AsyncConnection = Depends(connection),
) -> dict:
    require_roles(principal, "ADMIN", "HR")
    existing = await db.execute(
        statement('SELECT "userId", status::text status FROM leave_requests WHERE id = :id FOR UPDATE'),
        {"id": leave_id},
    )
    leave = existing.mappings().first()
    if not leave:
        raise HTTPException(status_code=404, detail="Leave request not found")
    if leave["userId"] == principal.id:
        raise HTTPException(status_code=403, detail="You cannot approve or reject your own leave request")
    if leave["status"] != "PENDING":
        raise HTTPException(status_code=400, detail="This leave request has already been decided")
    result = await db.execute(
        statement(
            'UPDATE leave_requests SET status = :status, "approvedById" = :approver, "updatedAt" = now() WHERE id = :id RETURNING *'
        ),
        {"id": leave_id, "status": payload.status, "approver": principal.id},
    )
    await audit_event(
        db,
        principal,
        category="TEAM",
        operation="UPDATE",
        action="team.updateLeaveStatus",
        target_type="LeaveRequest",
        target_id=leave_id,
        changes={"status": {"before": "PENDING", "after": payload.status}},
    )
    await db.commit()
    return {"data": row_dict(result.mappings().one())}


@router.put("/api/hr/leave-balances")
async def set_leave_balance(
    payload: LeaveBalanceSet, principal: Principal = Depends(team_write), db: AsyncConnection = Depends(connection)
) -> dict:
    require_roles(principal, "ADMIN", "HR")
    result = await db.execute(
        statement(
            'INSERT INTO leave_balances (id, "userId", year, type, "entitledDays", "createdAt", "updatedAt") VALUES (:id, :user_id, :year, :type, :entitled_days, now(), now()) ON CONFLICT ("userId", year, type) DO UPDATE SET "entitledDays" = EXCLUDED."entitledDays", "updatedAt" = now() RETURNING *'
        ),
        {"id": new_id(), **payload.model_dump()},
    )
    await audit_event(
        db,
        principal,
        category="TEAM",
        operation="UPDATE",
        action="team.setLeaveBalance",
        target_type="LeaveBalance",
        target_id=result.mappings().one()["id"],
        input_data=payload.model_dump(),
    )
    await db.commit()
    return {"success": True}


@router.get("/api/hr/leave-balances")
async def get_leave_balances(
    user_id: str | None = None,
    year: int | None = None,
    principal: Principal = Depends(team_read),
    db: AsyncConnection = Depends(connection),
) -> dict:
    target = user_id if principal.role in {"ADMIN", "HR"} and user_id else principal.id
    target_year = year or utcnow_naive().year
    balances = await db.execute(
        statement('SELECT type::text type, "entitledDays" FROM leave_balances WHERE "userId" = :id AND year = :year'),
        {"id": target, "year": target_year},
    )
    approved = await db.execute(
        statement(
            'SELECT type::text type, "startDate", "endDate" FROM leave_requests WHERE "userId" = :id AND status = \'APPROVED\' AND EXTRACT(YEAR FROM "startDate") = :year'
        ),
        {"id": target, "year": target_year},
    )
    entitled = {row["type"]: row["entitledDays"] for row in balances.mappings()}
    used = {kind: 0 for kind in ("VACATION", "SICK", "REMOTE")}
    for row in approved.mappings():
        used[row["type"]] += leave_days(row["startDate"], row["endDate"])
    types = [
        {
            "type": kind,
            "entitledDays": entitled.get(kind, 0),
            "usedDays": used[kind],
            "remaining": entitled.get(kind, 0) - used[kind],
        }
        for kind in used
    ]
    return {"userId": target, "year": target_year, "types": types}


@router.get("/api/hr/resignations/mine")
async def my_resignations(principal: Principal = Depends(team_read), db: AsyncConnection = Depends(connection)) -> dict:
    result = await db.execute(
        statement(
            'SELECT r.*, u.name AS "reviewedByName" FROM resignations r LEFT JOIN users u ON u.id = r."reviewedById" WHERE r."userId" = :id ORDER BY r."createdAt" DESC'
        ),
        {"id": principal.id},
    )
    return {"data": rows(result)}


@router.post("/api/hr/resignations", status_code=status.HTTP_201_CREATED)
async def submit_resignation(
    payload: ResignationCreate, principal: Principal = Depends(team_write), db: AsyncConnection = Depends(connection)
) -> dict:
    pending = await db.execute(
        statement("SELECT id FROM resignations WHERE \"userId\" = :id AND status = 'PENDING' LIMIT 1"),
        {"id": principal.id},
    )
    if pending.first():
        raise HTTPException(status_code=409, detail="You already have a pending resignation")
    resignation_id = new_id()
    result = await db.execute(
        statement(
            'INSERT INTO resignations (id, "userId", reason, "proposedLastDay", status, "createdAt", "updatedAt") VALUES (:id, :user_id, :reason, :proposed_last_day, \'PENDING\', now(), now()) RETURNING *'
        ),
        {
            "id": resignation_id,
            "user_id": principal.id,
            **payload.model_dump(exclude={"proposed_last_day"}),
            "proposed_last_day": as_naive_utc(payload.proposed_last_day),
        },
    )
    await audit_event(
        db,
        principal,
        category="TEAM",
        operation="CREATE",
        action="resignations.submit",
        target_type="Resignation",
        target_id=resignation_id,
        input_data=payload.model_dump(mode="json"),
    )
    await db.commit()
    return {"data": row_dict(result.mappings().one())}


@router.patch("/api/hr/resignations/{resignation_id}/withdraw")
async def withdraw_resignation(
    resignation_id: str, principal: Principal = Depends(team_write), db: AsyncConnection = Depends(connection)
) -> dict:
    result = await db.execute(
        statement(
            "UPDATE resignations SET status = 'WITHDRAWN', \"updatedAt\" = now() WHERE id = :id AND \"userId\" = :user_id AND status = 'PENDING' RETURNING *"
        ),
        {"id": resignation_id, "user_id": principal.id},
    )
    record = result.mappings().first()
    if not record:
        raise HTTPException(status_code=400, detail="Only your own pending resignation can be withdrawn")
    await db.commit()
    return {"data": row_dict(record)}


@router.get("/api/hr/resignations")
async def list_resignations(
    status_filter: str | None = None,
    principal: Principal = Depends(team_read),
    db: AsyncConnection = Depends(connection),
) -> dict:
    require_roles(principal, "ADMIN", "HR")
    clause = "WHERE r.status = :status" if status_filter else ""
    result = await db.execute(
        statement(
            f'SELECT r.*, u.name AS "userName", u.role::text AS "userRole", u.department::text AS "userDepartment", u.title AS "userTitle" FROM resignations r JOIN users u ON u.id = r."userId" {clause} ORDER BY r."createdAt" DESC'
        ),
        {"status": status_filter},
    )
    return {"data": rows(result)}


@router.patch("/api/hr/resignations/{resignation_id}/decision")
async def decide_resignation(
    resignation_id: str,
    payload: ResignationDecision,
    principal: Principal = Depends(team_write),
    db: AsyncConnection = Depends(connection),
) -> dict:
    require_roles(principal, "ADMIN", "HR")
    if payload.decision == "APPROVED":
        await lock_active_admin_invariant(db)
    current_result = await db.execute(
        statement(
            'SELECT r.*, u.name AS "userName", u.role::text AS "userRole" FROM resignations r JOIN users u ON u.id = r."userId" WHERE r.id = :id FOR UPDATE'
        ),
        {"id": resignation_id},
    )
    current = current_result.mappings().first()
    if not current:
        raise HTTPException(status_code=404, detail="Resignation not found")
    if (
        current["status"] != "PENDING"
        or current["userId"] == principal.id
        or (principal.role == "HR" and current["userRole"] == "ADMIN")
    ):
        raise HTTPException(status_code=403, detail="You do not have permission to review this resignation")
    last_day = payload.last_working_day or current["proposedLastDay"] if payload.decision == "APPROVED" else None
    if last_day:
        last_day = as_naive_utc(last_day)
    deactivates_now = bool(payload.decision == "APPROVED" and last_day and last_day <= utcnow_naive())
    if current["userRole"] == "ADMIN" and deactivates_now:
        count = await db.execute(
            statement("SELECT COUNT(*) FROM users WHERE id <> :id AND role = 'ADMIN' AND status = 'ACTIVE'"),
            {"id": current["userId"]},
        )
        if count.scalar_one() == 0:
            raise HTTPException(status_code=400, detail="Cannot deactivate the last active admin")
    result = await db.execute(
        statement(
            'UPDATE resignations SET status = :decision, "reviewedById" = :reviewer, "reviewedAt" = now(), "reviewNote" = :note, "lastWorkingDay" = :last_day, "updatedAt" = now() WHERE id = :id RETURNING *'
        ),
        {
            "id": resignation_id,
            "decision": payload.decision,
            "reviewer": principal.id,
            "note": payload.review_note,
            "last_day": last_day,
        },
    )
    if deactivates_now:
        await db.execute(
            statement(
                'UPDATE users SET status = \'INACTIVE\', "tokenVersion" = "tokenVersion" + 1, "updatedAt" = now() WHERE id = :id'
            ),
            {"id": current["userId"]},
        )
    await audit_event(
        db,
        principal,
        category="TEAM",
        operation="UPDATE",
        action="resignations.review",
        target_type="Resignation",
        target_id=resignation_id,
        target_label=current["userName"],
        changes={"status": {"before": current["status"], "after": payload.decision}},
    )
    await db.commit()
    return {"data": row_dict(result.mappings().one())}


@router.get("/api/hr/performance-notes/{user_id}")
async def list_performance_notes(
    user_id: str, principal: Principal = Depends(team_read), db: AsyncConnection = Depends(connection)
) -> dict:
    if principal.role != "ADMIN" and principal.id != user_id:
        raise HTTPException(status_code=403, detail="Performance notes are private")
    result = await db.execute(
        statement(
            'SELECT n.*, u.name AS "authorName", u.avatar AS "authorAvatar" FROM performance_notes n JOIN users u ON u.id = n."authorId" WHERE n."userId" = :id ORDER BY n."createdAt" DESC'
        ),
        {"id": user_id},
    )
    return {"data": rows(result)}


@router.post("/api/hr/performance-notes", status_code=status.HTTP_201_CREATED)
async def add_performance_note(
    payload: PerformanceNoteCreate,
    principal: Principal = Depends(team_write),
    db: AsyncConnection = Depends(connection),
) -> dict:
    require_roles(principal, "ADMIN")
    note_id = new_id()
    result = await db.execute(
        statement(
            'INSERT INTO performance_notes (id, "userId", "authorId", content, "createdAt", "updatedAt") VALUES (:id, :user_id, :author_id, :content, now(), now()) RETURNING *'
        ),
        {"id": note_id, "user_id": payload.user_id, "author_id": principal.id, "content": payload.content},
    )
    await audit_event(
        db,
        principal,
        category="TEAM",
        operation="CREATE",
        action="team.addPerformanceNote",
        target_type="PerformanceNote",
        target_id=note_id,
        input_data=payload.model_dump(),
    )
    await db.commit()
    return {"data": row_dict(result.mappings().one())}


@router.delete("/api/hr/performance-notes/{note_id}")
async def delete_performance_note(
    note_id: str, principal: Principal = Depends(team_write), db: AsyncConnection = Depends(connection)
) -> dict:
    require_roles(principal, "ADMIN")
    result = await db.execute(
        statement('DELETE FROM performance_notes WHERE id = :id AND "authorId" = :author RETURNING id'),
        {"id": note_id, "author": principal.id},
    )
    if not result.first():
        raise HTTPException(status_code=403, detail="You can only delete your own performance notes")
    await db.commit()
    return {"success": True}


REVIEW_SELECT = '''SELECT r.*, c.name AS "cycleName", c.status AS "cycleStatus", c."startDate" AS "cycleStartDate", c."endDate" AS "cycleEndDate",
s.name AS "subjectName", s.avatar AS "subjectAvatar", s.title AS "subjectTitle", s.department::text AS "subjectDepartment",
v.name AS "reviewerName", v.avatar AS "reviewerAvatar", v.title AS "reviewerTitle", v.department::text AS "reviewerDepartment"
FROM reviews r JOIN review_cycles c ON c.id = r."cycleId" JOIN users s ON s.id = r."subjectId" JOIN users v ON v.id = r."reviewerId"'''


@router.post("/api/hr/review-cycles", status_code=status.HTTP_201_CREATED)
async def create_review_cycle(
    payload: ReviewCycleCreate, principal: Principal = Depends(team_write), db: AsyncConnection = Depends(connection)
) -> dict:
    require_roles(principal, "ADMIN", "HR")
    cycle_id = new_id()
    result = await db.execute(
        statement(
            'INSERT INTO review_cycles (id, name, "startDate", "endDate", status, "createdById", "createdAt", "updatedAt") VALUES (:id, :name, :start_date, :end_date, \'OPEN\', :creator, now(), now()) RETURNING *'
        ),
        {
            "id": cycle_id,
            "creator": principal.id,
            **payload.model_dump(exclude={"start_date", "end_date"}),
            "start_date": as_naive_utc(payload.start_date),
            "end_date": as_naive_utc(payload.end_date),
        },
    )
    await audit_event(
        db,
        principal,
        category="TEAM",
        operation="CREATE",
        action="reviews.createCycle",
        target_type="ReviewCycle",
        target_id=cycle_id,
        target_label=payload.name,
    )
    await db.commit()
    return {"data": row_dict(result.mappings().one())}


@router.get("/api/hr/review-cycles")
async def list_review_cycles(
    principal: Principal = Depends(team_read), db: AsyncConnection = Depends(connection)
) -> dict:
    require_roles(principal, "ADMIN", "HR")
    result = await db.execute(
        statement(
            'SELECT c.*, u.name AS "createdByName", COUNT(r.id)::int AS "reviewCount" FROM review_cycles c JOIN users u ON u.id = c."createdById" LEFT JOIN reviews r ON r."cycleId" = c.id GROUP BY c.id, u.name ORDER BY c."createdAt" DESC'
        )
    )
    return {"data": rows(result)}


@router.patch("/api/hr/review-cycles/{cycle_id}/{action}")
async def change_review_cycle(
    cycle_id: str, action: str, principal: Principal = Depends(team_write), db: AsyncConnection = Depends(connection)
) -> dict:
    require_roles(principal, "ADMIN", "HR")
    if action not in {"close", "reopen"}:
        raise HTTPException(status_code=404, detail="Unknown review-cycle action")
    next_status = "CLOSED" if action == "close" else "OPEN"
    result = await db.execute(
        statement('UPDATE review_cycles SET status = :status, "updatedAt" = now() WHERE id = :id RETURNING *'),
        {"id": cycle_id, "status": next_status},
    )
    record = result.mappings().first()
    if not record:
        raise HTTPException(status_code=404, detail="Review cycle not found")
    await audit_event(
        db,
        principal,
        category="TEAM",
        operation="UPDATE",
        action=f"reviews.{action}Cycle",
        target_type="ReviewCycle",
        target_id=cycle_id,
        target_label=record["name"],
        changes={"status": {"after": next_status}},
    )
    await db.commit()
    return {"data": row_dict(record)}


@router.post("/api/hr/review-cycles/{cycle_id}/reviews", status_code=status.HTTP_201_CREATED)
async def assign_review(
    cycle_id: str,
    payload: ReviewAssignment,
    principal: Principal = Depends(team_write),
    db: AsyncConnection = Depends(connection),
) -> dict:
    require_roles(principal, "ADMIN", "HR")
    cycle = await db.execute(statement("SELECT status FROM review_cycles WHERE id = :id"), {"id": cycle_id})
    if cycle.scalar_one_or_none() != "OPEN":
        raise HTTPException(status_code=400, detail="Reviewers can only be assigned while the cycle is open")
    review_id = new_id()
    try:
        await db.execute(
            statement(
                'INSERT INTO reviews (id, "cycleId", "subjectId", "reviewerId", status, "createdAt", "updatedAt") VALUES (:id, :cycle_id, :subject_id, :reviewer_id, \'DRAFT\', now(), now())'
            ),
            {"id": review_id, "cycle_id": cycle_id, **payload.model_dump()},
        )
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=409, detail="That review assignment already exists or references an unknown user"
        ) from exc
    result = await db.execute(statement(f"{REVIEW_SELECT} WHERE r.id = :id"), {"id": review_id})
    await audit_event(
        db,
        principal,
        category="TEAM",
        operation="CREATE",
        action="reviews.addReview",
        target_type="Review",
        target_id=review_id,
        input_data=payload.model_dump(),
    )
    await db.commit()
    return {"data": row_dict(result.mappings().one())}


@router.patch("/api/hr/reviews/{review_id}/submit")
async def submit_review(
    review_id: str,
    payload: ReviewSubmit,
    principal: Principal = Depends(team_write),
    db: AsyncConnection = Depends(connection),
) -> dict:
    review_result = await db.execute(
        statement(
            'SELECT r."reviewerId", r.status, c.status AS "cycleStatus" FROM reviews r JOIN review_cycles c ON c.id = r."cycleId" WHERE r.id = :id FOR UPDATE'
        ),
        {"id": review_id},
    )
    review = review_result.mappings().first()
    if not review:
        raise HTTPException(status_code=404, detail="Review not found")
    if review["reviewerId"] != principal.id:
        raise HTTPException(status_code=403, detail="You can only submit a review assigned to you")
    if review["cycleStatus"] != "OPEN":
        raise HTTPException(status_code=400, detail="This review cycle is closed")
    result = await db.execute(
        statement(
            'UPDATE reviews SET rating = :rating, strengths = :strengths, improvements = :improvements, comments = :comments, status = \'SUBMITTED\', "submittedAt" = now(), "updatedAt" = now() WHERE id = :id RETURNING *'
        ),
        {"id": review_id, **payload.model_dump()},
    )
    await audit_event(
        db,
        principal,
        category="TEAM",
        operation="UPDATE",
        action="reviews.submitReview",
        target_type="Review",
        target_id=review_id,
        changes={"status": {"before": review["status"], "after": "SUBMITTED"}},
    )
    await db.commit()
    return {"data": row_dict(result.mappings().one())}


@router.get("/api/hr/reviews")
async def list_reviews(
    cycle_id: str | None = None, principal: Principal = Depends(team_read), db: AsyncConnection = Depends(connection)
) -> dict:
    clauses = []
    values: dict[str, str] = {"me": principal.id}
    if cycle_id:
        clauses.append('r."cycleId" = :cycle_id')
        values["cycle_id"] = cycle_id
    if principal.role not in {"ADMIN", "HR"}:
        clauses.append('(r."reviewerId" = :me OR (r."subjectId" = :me AND r.status = \'SUBMITTED\'))')
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    result = await db.execute(statement(f'{REVIEW_SELECT} {where} ORDER BY r."createdAt" DESC'), values)
    return {"data": rows(result)}


@router.get("/api/hr/stats")
async def hr_stats(principal: Principal = Depends(team_read), db: AsyncConnection = Depends(connection)) -> dict:
    require_roles(principal, "ADMIN", "HR")
    result = await db.execute(
        statement(
            """SELECT
            (SELECT COUNT(*) FROM users WHERE status <> 'INACTIVE') AS active_members,
            (SELECT COUNT(*) FROM leave_requests WHERE status = 'PENDING') AS pending_leave,
            (SELECT COUNT(*) FROM leave_requests WHERE status = 'APPROVED' AND "startDate" <= now() AND "endDate" >= now()) AS out_today,
            (SELECT COUNT(*) FROM resignations WHERE status = 'PENDING') AS pending_resignations,
            (SELECT COUNT(*) FROM review_cycles WHERE status = 'OPEN') AS open_review_cycles"""
        )
    )
    return {"data": row_dict(result.mappings().one())}
