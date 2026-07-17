import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncConnection

from ..collaboration_schemas import NoteCreate, NoteSharesUpdate, NoteUpdate, SuccessOut
from ..database import connection, row_dict, statement
from ..security import Principal, current_principal
from .collaboration_common import (
    collaboration_audit_event,
    fetch_all,
    fetch_one,
    insert_activity,
    insert_notifications,
    json_text,
    new_id,
    require_scope,
    utcnow,
)

router = APIRouter(prefix="/api/v1/notes", tags=["notes"])
REVISION_RETENTION = 50

NOTE_LIST_SELECT = """
SELECT n.id, n.title, n.visibility::text AS visibility, n."authorId", n."projectId",
       n."clientId", n."updatedAt", n."createdAt",
       jsonb_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar) AS author,
       CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('id', p.id, 'name', p.name) END AS project,
       CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('id', c.id, 'name', c.name) END AS client
FROM notes n
JOIN users u ON u.id = n."authorId"
LEFT JOIN projects p ON p.id = n."projectId"
LEFT JOIN clients c ON c.id = n."clientId"
"""


def _walk(document: Any):
    if not isinstance(document, dict):
        return
    yield document
    content = document.get("content")
    if isinstance(content, list):
        for child in content:
            yield from _walk(child)


def extract_plain_text(document: Any) -> str:
    return " ".join(node["text"] for node in _walk(document) if isinstance(node.get("text"), str))[:10000]


def extract_linked_note_ids(document: Any) -> list[str]:
    return list(
        dict.fromkeys(
            node["attrs"]["id"]
            for node in _walk(document)
            if node.get("type") == "noteLink"
            and isinstance(node.get("attrs"), dict)
            and isinstance(node["attrs"].get("id"), str)
        )
    )


def extract_mention_node_user_ids(document: Any) -> set[str]:
    return {
        node["attrs"]["id"]
        for node in _walk(document)
        if node.get("type") == "mention"
        and isinstance(node.get("attrs"), dict)
        and isinstance(node["attrs"].get("id"), str)
    }


def resolve_mentioned_user_ids(text: str, team: list[dict[str, Any]]) -> set[str]:
    if not text:
        return set()
    lower = text.lower()

    def normalize(value: str) -> str:
        return re.sub(r"[^a-z0-9]", "", value.lower())

    tokens = {normalize(match) for match in re.findall(r"@([a-z0-9._-]{2,40})", lower) if normalize(match)}
    resolved: set[str] = set()
    for user in team:
        name = str(user["name"])
        email = str(user["email"])
        full = normalize(name)
        first = normalize(name.strip().split()[0] if name.strip() else "")
        local = normalize(email.split("@", 1)[0])
        if (
            (full and full in tokens)
            or (first and first in tokens)
            or (local and local in tokens)
            or (name.strip() and f"@{name.strip().lower()}" in lower)
        ):
            resolved.add(str(user["id"]))
    return resolved


def compute_mention_targets(
    *,
    content_text: str,
    content_json: Any,
    visibility: str,
    author_id: str,
    share_user_ids: list[str],
    team: list[dict[str, Any]],
) -> list[str]:
    resolved = resolve_mentioned_user_ids(content_text, team)
    resolved.update(extract_mention_node_user_ids(content_json))
    if visibility == "TEAM":
        visible_ids = {str(user["id"]) for user in team}
    elif visibility == "SHARED":
        visible_ids = set(share_user_ids)
    else:
        visible_ids = set()
    return [user_id for user_id in resolved if user_id != author_id and user_id in visible_ids]


def visibility_sql(alias: str = "n") -> str:
    return (
        f"({alias}.\"authorId\" = :user_id OR {alias}.visibility::text = 'TEAM' OR "
        f"({alias}.visibility::text = 'SHARED' AND EXISTS("
        f'SELECT 1 FROM note_shares ns_v WHERE ns_v."noteId" = {alias}.id '
        f'AND ns_v."userId" = :user_id)))'
    )


async def _load_note(db: AsyncConnection, note_id: str) -> dict[str, Any]:
    note = await fetch_one(
        db,
        "SELECT n.*, n.visibility::text AS visibility, "
        "COALESCE((SELECT jsonb_agg(jsonb_build_object('userId', ns.\"userId\", "
        "'permission', ns.permission::text)) FROM note_shares ns WHERE ns.\"noteId\" = n.id), '[]'::jsonb) AS shares, "
        'COALESCE((SELECT jsonb_agg(nm."userId") FROM note_mentions nm WHERE nm."noteId" = n.id), \'[]\'::jsonb) AS mention_ids '
        "FROM notes n WHERE n.id = :id",
        {"id": note_id},
    )
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    return note


def _can_view(note: dict[str, Any], user_id: str) -> bool:
    return (
        note["authorId"] == user_id
        or note["visibility"] == "TEAM"
        or (note["visibility"] == "SHARED" and any(share["userId"] == user_id for share in note["shares"]))
    )


def _can_edit(note: dict[str, Any], user_id: str) -> bool:
    return (
        note["authorId"] == user_id
        or note["visibility"] == "TEAM"
        or (
            note["visibility"] == "SHARED"
            and any(share["userId"] == user_id and share["permission"] == "EDIT" for share in note["shares"])
        )
    )


async def _require_viewable(db: AsyncConnection, note_id: str, principal: Principal) -> dict[str, Any]:
    note = await _load_note(db, note_id)
    if not _can_view(note, principal.id):
        raise HTTPException(status_code=403, detail="You do not have access to this note")
    return note


async def _snapshot(db: AsyncConnection, note: dict[str, Any], editor_id: str) -> None:
    await db.execute(
        statement(
            "INSERT INTO note_revisions "
            '(id, "noteId", title, "contentJson", "contentText", "editedById", "createdAt") '
            "VALUES (:id, :note_id, :title, CAST(:content_json AS jsonb), :content_text, :editor_id, :now)"
        ),
        {
            "id": new_id(),
            "note_id": note["id"],
            "title": note["title"],
            "content_json": json_text(note["contentJson"]),
            "content_text": note["contentText"],
            "editor_id": editor_id,
            "now": utcnow(),
        },
    )
    await db.execute(
        statement(
            "DELETE FROM note_revisions WHERE id IN (SELECT id FROM note_revisions "
            'WHERE "noteId" = :note_id ORDER BY "createdAt" DESC OFFSET :retention)'
        ),
        {"note_id": note["id"], "retention": REVISION_RETENTION},
    )


async def _sync_links(db: AsyncConnection, note_id: str, document: Any) -> None:
    await db.execute(statement('DELETE FROM note_links WHERE "fromNoteId" = :id'), {"id": note_id})
    for linked_id in extract_linked_note_ids(document):
        if linked_id == note_id:
            continue
        await db.execute(
            statement(
                'INSERT INTO note_links (id, "fromNoteId", "toNoteId", "createdAt") '
                "SELECT :new_id, :note_id, id, :now FROM notes WHERE id = :linked_id "
                'ON CONFLICT ("fromNoteId", "toNoteId") DO NOTHING'
            ),
            {"new_id": new_id(), "note_id": note_id, "linked_id": linked_id, "now": utcnow()},
        )


async def _replace_mentions(db: AsyncConnection, note_id: str, target_ids: list[str]) -> None:
    await db.execute(statement('DELETE FROM note_mentions WHERE "noteId" = :id'), {"id": note_id})
    for user_id in target_ids:
        await db.execute(
            statement(
                'INSERT INTO note_mentions (id, "noteId", "userId", "createdAt") '
                'VALUES (:id, :note_id, :user_id, :now) ON CONFLICT ("noteId", "userId") DO NOTHING'
            ),
            {"id": new_id(), "note_id": note_id, "user_id": user_id, "now": utcnow()},
        )


@router.get("")
async def list_notes(
    scope: str = Query("all", pattern="^(mine|shared|all)$"),
    project_id: str | None = Query(None, alias="projectId"),
    client_id: str | None = Query(None, alias="clientId"),
    search: str | None = None,
    limit: int | None = Query(None, ge=1, le=1000),
    cursor: str | None = None,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> list[dict[str, Any]]:
    await require_scope(principal, "notes:read")
    clauses = [visibility_sql()]
    params: dict[str, Any] = {"user_id": principal.id}
    if scope == "mine":
        clauses.append('n."authorId" = :user_id')
    elif scope == "shared":
        clauses.append('n."authorId" <> :user_id')
    if project_id:
        clauses.append('n."projectId" = :project_id')
        params["project_id"] = project_id
    if client_id:
        clauses.append('n."clientId" = :client_id')
        params["client_id"] = client_id
    if search:
        clauses.append('(n.title ILIKE :search OR n."contentText" ILIKE :search)')
        params["search"] = f"%{search}%"
    if cursor:
        clauses.append('(n."updatedAt", n.id) < (SELECT "updatedAt", id FROM notes WHERE id = :cursor)')
        params["cursor"] = cursor
    sql = NOTE_LIST_SELECT + " WHERE " + " AND ".join(clauses) + ' ORDER BY n."updatedAt" DESC, n.id DESC'
    if limit is not None:
        sql += " LIMIT :limit"
        params["limit"] = limit
    return await fetch_all(db, sql, params)


@router.get("/mentions")
async def notes_mentioning_me(
    principal: Principal = Depends(current_principal), db: AsyncConnection = Depends(connection)
) -> list[dict[str, Any]]:
    await require_scope(principal, "notes:read")
    return await fetch_all(
        db,
        NOTE_LIST_SELECT
        + " WHERE "
        + visibility_sql()
        + ' AND EXISTS(SELECT 1 FROM note_mentions nm WHERE nm."noteId" = n.id '
        'AND nm."userId" = :user_id) ORDER BY n."updatedAt" DESC',
        {"user_id": principal.id},
    )


@router.get("/search")
async def search_notes(
    query: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> list[dict[str, Any]]:
    await require_scope(principal, "notes:read")
    if not query.strip():
        return []
    return await fetch_all(
        db,
        "SELECT n.id, n.title FROM notes n WHERE "
        + visibility_sql()
        + ' AND n.title ILIKE :query ORDER BY n."updatedAt" DESC LIMIT 10',
        {"user_id": principal.id, "query": f"%{query.strip()}%"},
    )


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_note(
    payload: NoteCreate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    await require_scope(principal, "notes:write")
    note_id = new_id()
    now = utcnow()
    content_text = extract_plain_text(payload.content_json)
    try:
        result = await db.execute(
            statement(
                'INSERT INTO notes (id, title, "contentJson", "contentText", "authorId", visibility, '
                '"projectId", "clientId", "createdAt", "updatedAt") VALUES '
                "(:id, :title, CAST(:content_json AS jsonb), :content_text, :author_id, :visibility, "
                ":project_id, :client_id, :now, :now) RETURNING *, visibility::text AS visibility"
            ),
            {
                "id": note_id,
                "title": payload.title,
                "content_json": json_text(payload.content_json),
                "content_text": content_text,
                "author_id": principal.id,
                "visibility": payload.visibility,
                "project_id": payload.project_id,
                "client_id": payload.client_id,
                "now": now,
            },
        )
        team = await fetch_all(db, "SELECT id, name, email FROM users")
        mention_ids = compute_mention_targets(
            content_text=content_text,
            content_json=payload.content_json,
            visibility=payload.visibility,
            author_id=principal.id,
            share_user_ids=[],
            team=team,
        )
        await _replace_mentions(db, note_id, mention_ids)
        if mention_ids:
            await insert_notifications(
                db,
                mention_ids,
                type="mention",
                title="You were mentioned in a note",
                message=f'{principal.name} mentioned you in "{payload.title}"',
                entity_type="Note",
                entity_id=note_id,
            )
        if payload.visibility != "PRIVATE":
            await insert_activity(
                db,
                principal,
                type="note_created",
                message=f'created note "{payload.title}"',
                entity_type="Note",
                entity_id=note_id,
            )
        await collaboration_audit_event(
            db,
            principal,
            category="NOTES",
            operation="CREATE",
            action="notes.create",
            target_type="Note",
            target_id=note_id,
            target_label=payload.title,
            input_data={
                "title": payload.title,
                "visibility": payload.visibility,
                "projectId": payload.project_id,
                "clientId": payload.client_id,
            },
        )
        await db.commit()
        return row_dict(result.mappings().one())
    except Exception:
        await db.rollback()
        raise


@router.get("/{note_id}")
async def get_note(
    note_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    await require_scope(principal, "notes:read")
    note = await _require_viewable(db, note_id, principal)
    detail = await fetch_one(
        db,
        """
        SELECT n.*, n.visibility::text AS visibility,
          jsonb_build_object('id', a.id, 'name', a.name, 'avatar', a.avatar) AS author,
          CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('id', p.id, 'name', p.name) END AS project,
          CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('id', c.id, 'name', c.name) END AS client,
          COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', ns.id, 'userId', ns."userId", 'permission', ns.permission::text, 'createdAt', ns."createdAt",
            'user', jsonb_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar)))
            FROM note_shares ns JOIN users u ON u.id = ns."userId" WHERE ns."noteId" = n.id), '[]'::jsonb) AS shares,
          COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', nm.id, 'userId', nm."userId", 'createdAt', nm."createdAt",
            'user', jsonb_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar)) ORDER BY nm."createdAt")
            FROM note_mentions nm JOIN users u ON u.id = nm."userId" WHERE nm."noteId" = n.id), '[]'::jsonb) AS mentions
        FROM notes n JOIN users a ON a.id = n."authorId"
        LEFT JOIN projects p ON p.id = n."projectId" LEFT JOIN clients c ON c.id = n."clientId"
        WHERE n.id = :id
        """,
        {"id": note_id},
    )
    assert detail is not None
    links_from = await fetch_all(
        db,
        'SELECT nl.id, nl."fromNoteId", nl."toNoteId", nl."createdAt", '
        "jsonb_build_object('id', t.id, 'title', t.title, 'authorId', t.\"authorId\", "
        '\'visibility\', t.visibility::text) AS "toNote" FROM note_links nl JOIN notes t ON t.id = nl."toNoteId" '
        'WHERE nl."fromNoteId" = :id AND ' + visibility_sql("t"),
        {"id": note_id, "user_id": principal.id},
    )
    links_to = await fetch_all(
        db,
        'SELECT nl.id, nl."fromNoteId", nl."toNoteId", nl."createdAt", '
        "jsonb_build_object('id', f.id, 'title', f.title, 'authorId', f.\"authorId\", "
        '\'visibility\', f.visibility::text) AS "fromNote" FROM note_links nl JOIN notes f ON f.id = nl."fromNoteId" '
        'WHERE nl."toNoteId" = :id AND ' + visibility_sql("f"),
        {"id": note_id, "user_id": principal.id},
    )
    detail.update(editable=_can_edit(note, principal.id), linksFrom=links_from, linksTo=links_to)
    return detail


@router.patch("/{note_id}")
async def update_note(
    note_id: str,
    payload: NoteUpdate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    await require_scope(principal, "notes:write")
    note = await _load_note(db, note_id)
    if not _can_edit(note, principal.id):
        raise HTTPException(status_code=403, detail="You cannot edit this note")
    fields = payload.model_fields_set
    if not fields:
        raise HTTPException(status_code=422, detail="No note fields were supplied")
    controlled = {"visibility", "project_id", "client_id"}
    if fields & controlled and note["authorId"] != principal.id and principal.role != "ADMIN":
        changed = any(
            getattr(payload, field) != note[{"project_id": "projectId", "client_id": "clientId"}.get(field, field)]
            for field in fields & controlled
        )
        if changed:
            raise HTTPException(
                status_code=403,
                detail="Only the note author can change its visibility or linked project/client.",
            )
    content_json = payload.content_json if "content_json" in fields else note["contentJson"]
    content_text = extract_plain_text(content_json)
    visibility = payload.visibility if "visibility" in fields else note["visibility"]
    title = payload.title if "title" in fields else note["title"]
    team = await fetch_all(db, "SELECT id, name, email FROM users")
    targets = compute_mention_targets(
        content_text=content_text,
        content_json=content_json,
        visibility=visibility,
        author_id=note["authorId"],
        share_user_ids=[share["userId"] for share in note["shares"]],
        team=team,
    )
    prior_mentions = set(note["mention_ids"])
    to_notify = [target for target in targets if target not in prior_mentions]
    content_changed = "content_json" in fields and content_json != note["contentJson"]
    title_changed = "title" in fields and title != note["title"]
    try:
        if title_changed or content_changed:
            await _snapshot(db, note, principal.id)
        result = await db.execute(
            statement(
                'UPDATE notes SET title = :title, "contentJson" = CAST(:content_json AS jsonb), '
                '"contentText" = :content_text, visibility = :visibility, "projectId" = :project_id, '
                '"clientId" = :client_id, "updatedAt" = :now WHERE id = :id '
                "RETURNING *, visibility::text AS visibility"
            ),
            {
                "id": note_id,
                "title": title,
                "content_json": json_text(content_json),
                "content_text": content_text,
                "visibility": visibility,
                "project_id": payload.project_id if "project_id" in fields else note["projectId"],
                "client_id": payload.client_id if "client_id" in fields else note["clientId"],
                "now": utcnow(),
            },
        )
        if "content_json" in fields:
            await _sync_links(db, note_id, content_json)
        await _replace_mentions(db, note_id, targets)
        if to_notify:
            await insert_notifications(
                db,
                to_notify,
                type="mention",
                title="You were mentioned in a note",
                message=f'{principal.name} mentioned you in "{title}"',
                entity_type="Note",
                entity_id=note_id,
            )
        await collaboration_audit_event(
            db,
            principal,
            category="NOTES",
            operation="UPDATE",
            action="notes.update",
            target_type="Note",
            target_id=note_id,
            target_label=title,
            changes={field: True for field in fields},
        )
        await db.commit()
        return row_dict(result.mappings().one())
    except Exception:
        await db.rollback()
        raise


@router.delete("/{note_id}", response_model=SuccessOut)
async def delete_note(
    note_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> SuccessOut:
    await require_scope(principal, "notes:write")
    note = await _load_note(db, note_id)
    if note["authorId"] != principal.id and principal.role != "ADMIN":
        raise HTTPException(status_code=403, detail="Only the note author can delete it")
    await db.execute(statement("DELETE FROM notes WHERE id = :id"), {"id": note_id})
    await collaboration_audit_event(
        db,
        principal,
        category="NOTES",
        operation="DELETE",
        action="notes.delete",
        target_type="Note",
        target_id=note_id,
        target_label=note["title"],
    )
    await db.commit()
    return SuccessOut()


@router.put("/{note_id}/shares", response_model=SuccessOut)
async def set_note_shares(
    note_id: str,
    payload: NoteSharesUpdate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> SuccessOut:
    await require_scope(principal, "notes:write")
    note = await _load_note(db, note_id)
    if note["authorId"] != principal.id:
        raise HTTPException(status_code=403, detail="Only the note author can change shares")
    deduped = {share.user_id: share.permission for share in payload.shares if share.user_id != principal.id}
    previous_count = len(note["shares"])
    try:
        await db.execute(statement('DELETE FROM note_shares WHERE "noteId" = :id'), {"id": note_id})
        for user_id, permission in deduped.items():
            await db.execute(
                statement(
                    'INSERT INTO note_shares (id, "noteId", "userId", permission, "createdAt") '
                    "VALUES (:id, :note_id, :user_id, :permission, :now)"
                ),
                {
                    "id": new_id(),
                    "note_id": note_id,
                    "user_id": user_id,
                    "permission": permission,
                    "now": utcnow(),
                },
            )
        # A share change can revoke visibility, so derived mention rows must be scoped again.
        team = await fetch_all(db, "SELECT id, name, email FROM users")
        targets = compute_mention_targets(
            content_text=note["contentText"],
            content_json=note["contentJson"],
            visibility=note["visibility"],
            author_id=note["authorId"],
            share_user_ids=list(deduped),
            team=team,
        )
        await _replace_mentions(db, note_id, targets)
        if previous_count == 0 and deduped:
            count = len(deduped)
            await insert_activity(
                db,
                principal,
                type="note_shared",
                message=f'shared note "{note["title"]}" with {count} member{"" if count == 1 else "s"}',
                entity_type="Note",
                entity_id=note_id,
            )
        await collaboration_audit_event(
            db,
            principal,
            category="NOTES",
            operation="UPDATE",
            action="notes.shares.replace",
            target_type="Note",
            target_id=note_id,
            target_label=note["title"],
            changes={"shares": payload.model_dump(by_alias=True)["shares"]},
        )
        await db.commit()
        return SuccessOut()
    except Exception:
        await db.rollback()
        raise


@router.get("/{note_id}/revisions")
async def list_note_revisions(
    note_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> list[dict[str, Any]]:
    await require_scope(principal, "notes:read")
    await _require_viewable(db, note_id, principal)
    return await fetch_all(
        db,
        'SELECT r.id, r.title, r."createdAt", CASE WHEN u.id IS NULL THEN NULL ELSE '
        "jsonb_build_object('id', u.id, 'name', u.name) END AS \"editedBy\" "
        'FROM note_revisions r LEFT JOIN users u ON u.id = r."editedById" '
        'WHERE r."noteId" = :id ORDER BY r."createdAt" DESC',
        {"id": note_id},
    )


@router.get("/revisions/{revision_id}")
async def get_revision(
    revision_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    await require_scope(principal, "notes:read")
    revision = await fetch_one(
        db,
        "SELECT r.*, CASE WHEN u.id IS NULL THEN NULL ELSE jsonb_build_object('id', u.id, 'name', u.name) "
        'END AS "editedBy" FROM note_revisions r LEFT JOIN users u ON u.id = r."editedById" '
        "WHERE r.id = :id",
        {"id": revision_id},
    )
    if not revision:
        raise HTTPException(status_code=404, detail="Revision not found")
    await _require_viewable(db, revision["noteId"], principal)
    return revision


@router.post("/revisions/{revision_id}/restore")
async def restore_revision(
    revision_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    await require_scope(principal, "notes:write")
    revision = await fetch_one(db, "SELECT * FROM note_revisions WHERE id = :id", {"id": revision_id})
    if not revision:
        raise HTTPException(status_code=404, detail="Revision not found")
    note = await _load_note(db, revision["noteId"])
    if note["authorId"] != principal.id and principal.role != "ADMIN":
        raise HTTPException(status_code=403, detail="Only the note author can restore a version")
    team = await fetch_all(db, "SELECT id, name, email FROM users")
    targets = compute_mention_targets(
        content_text=revision["contentText"],
        content_json=revision["contentJson"],
        visibility=note["visibility"],
        author_id=note["authorId"],
        share_user_ids=[share["userId"] for share in note["shares"]],
        team=team,
    )
    try:
        await _snapshot(db, note, principal.id)
        result = await db.execute(
            statement(
                'UPDATE notes SET title = :title, "contentJson" = CAST(:content_json AS jsonb), '
                '"contentText" = :content_text, "updatedAt" = :now WHERE id = :id RETURNING *, '
                "visibility::text AS visibility"
            ),
            {
                "id": note["id"],
                "title": revision["title"],
                "content_json": json_text(revision["contentJson"]),
                "content_text": revision["contentText"],
                "now": utcnow(),
            },
        )
        await _sync_links(db, note["id"], revision["contentJson"])
        await _replace_mentions(db, note["id"], targets)
        await collaboration_audit_event(
            db,
            principal,
            category="NOTES",
            operation="UPDATE",
            action="notes.revision.restore",
            target_type="Note",
            target_id=note["id"],
            target_label=revision["title"],
            metadata={"revisionId": revision_id},
        )
        await db.commit()
        return row_dict(result.mappings().one())
    except Exception:
        await db.rollback()
        raise
