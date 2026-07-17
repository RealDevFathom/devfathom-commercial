from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncConnection

from ..collaboration_schemas import (
    ChannelCreate,
    ChannelMembersUpdate,
    ChannelMuteUpdate,
    ChannelUpdate,
    DirectMessageCreate,
    MessageCreate,
    MessageUpdate,
    ReactionToggle,
)
from ..database import connection, statement
from ..security import Principal, current_principal
from .collaboration_common import (
    RT_MEMBERSHIP_CHANGED,
    RT_MESSAGE_DELETE,
    RT_MESSAGE_NEW,
    RT_MESSAGE_UPDATE,
    RT_NOTIFICATION,
    RT_REACTION,
    RT_READ,
    RT_THREAD_REPLY,
    can_manage_channel,
    collaboration_audit_event,
    emit_to_channel,
    emit_to_user,
    fetch_all,
    fetch_one,
    insert_notifications,
    json_text,
    new_id,
    require_channel_member,
    require_scope,
    utcnow,
)

router = APIRouter(prefix="/api/v1/chat", tags=["chat"])
MESSAGE_PAGE_SIZE = 30


def _walk(document: Any):
    if not isinstance(document, dict):
        return
    yield document
    for child in document.get("content", []):
        yield from _walk(child)


def tiptap_to_plain_text(document: Any) -> str:
    return " ".join(node["text"] for node in _walk(document) if isinstance(node.get("text"), str))[:8000]


def extract_mention_ids(document: Any) -> list[str]:
    return list(
        dict.fromkeys(
            str(node["attrs"]["id"])
            for node in _walk(document)
            if node.get("type") == "mention"
            and isinstance(node.get("attrs"), dict)
            and isinstance(node["attrs"].get("id"), str)
        )
    )


def aggregate_reactions(rows: list[dict[str, Any]], current_user_id: str) -> list[dict[str, Any]]:
    grouped: dict[str, list[str]] = {}
    for row in rows:
        grouped.setdefault(row["emoji"], []).append(row["userId"])
    return [
        {
            "emoji": emoji,
            "count": len(user_ids),
            "userIds": user_ids,
            "reactedByMe": current_user_id in user_ids,
        }
        for emoji, user_ids in grouped.items()
    ]


async def _message_row(db: AsyncConnection, message_id: str) -> dict[str, Any]:
    row = await fetch_one(
        db,
        "SELECT m.*, jsonb_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar, "
        "'title', u.title) AS sender FROM messages m JOIN users u ON u.id = m.\"senderId\" "
        "WHERE m.id = :id",
        {"id": message_id},
    )
    if not row:
        raise HTTPException(status_code=404, detail="Message not found")
    return row


async def _message_outs(db: AsyncConnection, rows: list[dict[str, Any]], current_user_id: str) -> list[dict[str, Any]]:
    """Hydrate message relations with a fixed number of bulk queries."""
    if not rows:
        return []
    message_ids = list(dict.fromkeys(row["id"] for row in rows))
    params = {"message_ids": json_text(message_ids)}
    reactions = await fetch_all(
        db,
        'SELECT mr."messageId", mr.emoji, mr."userId" FROM message_reactions mr '
        'WHERE mr."messageId" IN (SELECT value FROM jsonb_array_elements_text(CAST(:message_ids AS jsonb))) '
        'ORDER BY mr."messageId", mr.id',
        params,
    )
    attachments = await fetch_all(
        db,
        'SELECT ma."messageId", ma.id, ma.name, ma.url, ma.type, ma.size, ma.duration '
        'FROM message_attachments ma WHERE ma."messageId" IN '
        "(SELECT value FROM jsonb_array_elements_text(CAST(:message_ids AS jsonb))) "
        'ORDER BY ma."messageId", ma."createdAt"',
        params,
    )
    mentions = await fetch_all(
        db,
        'SELECT mm."messageId", mm."userId" FROM message_mentions mm WHERE mm."messageId" IN '
        "(SELECT value FROM jsonb_array_elements_text(CAST(:message_ids AS jsonb))) "
        'ORDER BY mm."messageId", mm."createdAt"',
        params,
    )
    replies = await fetch_all(
        db,
        'WITH ranked AS (SELECT r."parentId", r."createdAt", '
        "jsonb_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar, 'title', u.title) AS sender, "
        'row_number() OVER (PARTITION BY r."parentId" ORDER BY r."createdAt" DESC) AS rank, '
        'count(*) OVER (PARTITION BY r."parentId")::int AS "replyCount" '
        'FROM messages r JOIN users u ON u.id = r."senderId" WHERE r."parentId" IN '
        "(SELECT value FROM jsonb_array_elements_text(CAST(:message_ids AS jsonb)))) "
        'SELECT "parentId", "createdAt", sender, "replyCount" FROM ranked WHERE rank <= 3 '
        'ORDER BY "parentId", "createdAt" DESC',
        params,
    )
    states = await fetch_all(
        db,
        "WITH requested AS (SELECT value AS id FROM jsonb_array_elements_text(CAST(:message_ids AS jsonb))) "
        'SELECT requested.id AS "messageId", EXISTS(SELECT 1 FROM pinned_messages p '
        'WHERE p."messageId" = requested.id) AS pinned, EXISTS(SELECT 1 FROM saved_messages s '
        'WHERE s."messageId" = requested.id AND s."userId" = :user_id) AS saved FROM requested',
        {**params, "user_id": current_user_id},
    )

    reactions_by_id: dict[str, list[dict[str, Any]]] = {}
    attachments_by_id: dict[str, list[dict[str, Any]]] = {}
    mentions_by_id: dict[str, list[str]] = {}
    replies_by_id: dict[str, list[dict[str, Any]]] = {}
    for reaction in reactions:
        reactions_by_id.setdefault(reaction.pop("messageId"), []).append(reaction)
    for attachment in attachments:
        attachments_by_id.setdefault(attachment.pop("messageId"), []).append(attachment)
    for mention in mentions:
        mentions_by_id.setdefault(mention["messageId"], []).append(mention["userId"])
    for reply in replies:
        replies_by_id.setdefault(reply["parentId"], []).append(reply)
    states_by_id = {state["messageId"]: state for state in states}

    output: list[dict[str, Any]] = []
    for row in rows:
        message_id = row["id"]
        deleted = row["deletedAt"] is not None
        message_replies = replies_by_id.get(message_id, [])
        participants: list[dict[str, Any]] = []
        seen: set[str] = set()
        for reply in message_replies:
            sender = reply["sender"]
            if sender["id"] not in seen:
                participants.append(sender)
                seen.add(sender["id"])
        state = states_by_id.get(message_id)
        output.append(
            {
                "id": message_id,
                "channelId": row["channelId"],
                "content": "" if deleted else row["content"],
                "contentJson": None if deleted else row["contentJson"],
                "sender": row["sender"],
                "parentId": row["parentId"],
                "isEdited": row["isEdited"],
                "editedAt": row["editedAt"],
                "deletedAt": row["deletedAt"],
                "createdAt": row["createdAt"],
                "reactions": []
                if deleted
                else aggregate_reactions(reactions_by_id.get(message_id, []), current_user_id),
                "attachments": [] if deleted else attachments_by_id.get(message_id, []),
                "mentionIds": mentions_by_id.get(message_id, []),
                "replyCount": message_replies[0]["replyCount"] if message_replies else 0,
                "lastReplyAt": message_replies[0]["createdAt"] if message_replies else None,
                "threadParticipants": participants,
                "isPinned": bool(state and state["pinned"]),
                "isSaved": bool(state and state["saved"]),
            }
        )
    return output


async def _message_out(db: AsyncConnection, row: dict[str, Any], current_user_id: str) -> dict[str, Any]:
    return (await _message_outs(db, [row], current_user_id))[0]


async def _channel_outs(
    db: AsyncConnection,
    channels: list[dict[str, Any]],
    current_user_id: str,
) -> list[dict[str, Any]]:
    if not channels:
        return []
    channel_ids = list(dict.fromkeys(channel["id"] for channel in channels))
    params = {"channel_ids": json_text(channel_ids)}
    members = await fetch_all(
        db,
        'SELECT cm."channelId", cm."userId", cm.role, cm.muted, cm."lastReadAt", '
        "jsonb_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar, 'title', u.title) AS user "
        'FROM channel_members cm JOIN users u ON u.id = cm."userId" WHERE cm."channelId" IN '
        "(SELECT value FROM jsonb_array_elements_text(CAST(:channel_ids AS jsonb))) "
        'ORDER BY cm."channelId", cm."joinedAt"',
        params,
    )
    last_messages = await fetch_all(
        db,
        'SELECT DISTINCT ON (m."channelId") m."channelId", m.content, m."createdAt" FROM messages m '
        'WHERE m."channelId" IN (SELECT value FROM jsonb_array_elements_text(CAST(:channel_ids AS jsonb))) '
        'AND m."deletedAt" IS NULL ORDER BY m."channelId", m."createdAt" DESC',
        params,
    )
    counts = await fetch_all(
        db,
        "WITH requested AS (SELECT value AS id FROM jsonb_array_elements_text(CAST(:channel_ids AS jsonb))) "
        'SELECT requested.id AS "channelId", count(DISTINCT m.id) FILTER '
        '(WHERE m."senderId" <> :user_id)::int AS unread, count(DISTINCT mm.id)::int AS mentions '
        'FROM requested JOIN channel_members mine ON mine."channelId" = requested.id '
        'AND mine."userId" = :user_id LEFT JOIN messages m ON m."channelId" = requested.id '
        'AND m."deletedAt" IS NULL AND (mine."lastReadAt" IS NULL OR m."createdAt" > mine."lastReadAt") '
        'LEFT JOIN message_mentions mm ON mm."messageId" = m.id AND mm."userId" = :user_id '
        "GROUP BY requested.id",
        {**params, "user_id": current_user_id},
    )
    members_by_id: dict[str, list[dict[str, Any]]] = {}
    for member in members:
        members_by_id.setdefault(member.pop("channelId"), []).append(member)
    last_by_id = {last["channelId"]: last for last in last_messages}
    counts_by_id = {count["channelId"]: count for count in counts}
    output = []
    for channel in channels:
        channel_members = members_by_id.get(channel["id"], [])
        mine = next((member for member in channel_members if member["userId"] == current_user_id), None)
        others = [member for member in channel_members if member["userId"] != current_user_id]
        is_dm = channel["type"] == "DM"
        last = last_by_id.get(channel["id"])
        count = counts_by_id.get(channel["id"])
        output.append(
            {
                "id": channel["id"],
                "name": channel["name"],
                "type": channel["type"],
                "topic": channel["topic"],
                "description": channel["description"],
                "isPrivate": channel["isPrivate"],
                "isArchived": channel["isArchived"],
                "createdById": channel["createdById"],
                "memberCount": len(channel_members),
                "members": [
                    dict(member["user"], role=member["role"], presence="offline") for member in channel_members
                ],
                "isDM": is_dm,
                "dmPeer": others[0]["user"] if is_dm and others else None,
                "unreadCount": count["unread"] if count else 0,
                "mentionCount": count["mentions"] if count else 0,
                "muted": mine["muted"] if mine else False,
                "lastReadAt": mine["lastReadAt"] if mine else None,
                "lastMessagePreview": last["content"] if last else None,
                "lastMessageAt": last["createdAt"] if last else None,
            }
        )
    return output


async def _channel_out(
    db: AsyncConnection,
    channel: dict[str, Any],
    current_user_id: str,
    unread_count: int = 0,
    mention_count: int = 0,
) -> dict[str, Any]:
    output = (await _channel_outs(db, [channel], current_user_id))[0]
    # Callers may provide authoritative counts after a write.
    if unread_count or mention_count:
        output["unreadCount"] = unread_count
        output["mentionCount"] = mention_count
    return output


async def _channel_row(db: AsyncConnection, channel_id: str) -> dict[str, Any]:
    channel = await fetch_one(
        db,
        'SELECT id, name, description, topic, type::text AS type, "isPrivate", "isArchived", '
        '"createdById", "createdAt", "updatedAt" FROM channels WHERE id = :id',
        {"id": channel_id},
    )
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    return channel


@router.get("/channels")
async def get_channels(
    principal: Principal = Depends(current_principal), db: AsyncConnection = Depends(connection)
) -> list[dict[str, Any]]:
    await require_scope(principal, "chat:read")
    channels = await fetch_all(
        db,
        'SELECT c.id, c.name, c.description, c.topic, c.type::text AS type, c."isPrivate", '
        'c."isArchived", c."createdById", c."createdAt", c."updatedAt", cm."lastReadAt" '
        'FROM channels c JOIN channel_members cm ON cm."channelId" = c.id '
        'WHERE cm."userId" = :user_id AND c."isArchived" = false ORDER BY c."updatedAt" DESC',
        {"user_id": principal.id},
    )
    return await _channel_outs(db, channels, principal.id)


@router.get("/channels/browse")
async def browse_channels(
    q: str | None = None,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> list[dict[str, Any]]:
    await require_scope(principal, "chat:read")
    name_clause = " AND name ILIKE :q" if q else ""
    browse_params: dict[str, Any] = {"user_id": principal.id}
    if q:
        browse_params["q"] = f"%{q}%"
    channels = await fetch_all(
        db,
        'SELECT id, name, description, topic, type::text AS type, "isPrivate", "isArchived", '
        '"createdById", "createdAt", "updatedAt" FROM channels c WHERE "isArchived" = false '
        "AND \"isPrivate\" = false AND type::text <> 'DM' "
        'AND NOT EXISTS(SELECT 1 FROM channel_members cm WHERE cm."channelId" = c.id '
        'AND cm."userId" = :user_id)' + name_clause + ' ORDER BY "updatedAt" DESC LIMIT 50',
        browse_params,
    )
    return await _channel_outs(db, channels, principal.id)


@router.post("/channels", status_code=status.HTTP_201_CREATED)
async def create_channel(
    payload: ChannelCreate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    await require_scope(principal, "chat:write")
    channel_id = new_id()
    now = utcnow()
    member_ids = list(dict.fromkeys([principal.id, *payload.member_ids]))
    try:
        await db.execute(
            statement(
                'INSERT INTO channels (id, name, description, topic, type, "isPrivate", "isArchived", '
                '"createdById", "createdAt", "updatedAt") VALUES '
                "(:id, :name, :description, :topic, :type, :private, false, :creator, :now, :now)"
            ),
            {
                "id": channel_id,
                "name": payload.name,
                "description": payload.description,
                "topic": payload.topic,
                "type": payload.type,
                "private": payload.is_private,
                "creator": principal.id,
                "now": now,
            },
        )
        for user_id in member_ids:
            await db.execute(
                statement(
                    'INSERT INTO channel_members (id, "channelId", "userId", role, muted, "joinedAt") '
                    "VALUES (:id, :channel_id, :user_id, :role, false, :now) "
                    'ON CONFLICT ("channelId", "userId") DO NOTHING'
                ),
                {
                    "id": new_id(),
                    "channel_id": channel_id,
                    "user_id": user_id,
                    "role": "OWNER" if user_id == principal.id else "MEMBER",
                    "now": now,
                },
            )
        await collaboration_audit_event(
            db,
            principal,
            category="CHAT",
            operation="CREATE",
            action="chat.channel.create",
            target_type="Channel",
            target_id=channel_id,
            target_label=payload.name,
            input_data=payload.model_dump(by_alias=True),
        )
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return await _channel_out(db, await _channel_row(db, channel_id), principal.id)


@router.post("/channels/dm")
async def create_or_get_dm(
    payload: DirectMessageCreate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    await require_scope(principal, "chat:write")
    if payload.user_id == principal.id:
        raise HTTPException(status_code=400, detail="You cannot DM yourself")
    user = await fetch_one(db, "SELECT id FROM users WHERE id = :id", {"id": payload.user_id})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    existing = await fetch_one(
        db,
        "SELECT c.id FROM channels c WHERE c.type::text = 'DM' "
        'AND EXISTS(SELECT 1 FROM channel_members a WHERE a."channelId" = c.id AND a."userId" = :me) '
        'AND EXISTS(SELECT 1 FROM channel_members b WHERE b."channelId" = c.id AND b."userId" = :peer) '
        'AND (SELECT count(*) FROM channel_members cm WHERE cm."channelId" = c.id) = 2 LIMIT 1',
        {"me": principal.id, "peer": payload.user_id},
    )
    if existing:
        return await _channel_out(db, await _channel_row(db, existing["id"]), principal.id)
    channel_id = new_id()
    now = utcnow()
    try:
        await db.execute(
            statement(
                'INSERT INTO channels (id, type, "isPrivate", "isArchived", "createdById", "createdAt", "updatedAt") '
                "VALUES (:id, 'DM', true, false, :creator, :now, :now)"
            ),
            {"id": channel_id, "creator": principal.id, "now": now},
        )
        for user_id in (principal.id, payload.user_id):
            await db.execute(
                statement(
                    'INSERT INTO channel_members (id, "channelId", "userId", role, muted, "joinedAt") '
                    "VALUES (:id, :channel_id, :user_id, 'MEMBER', false, :now)"
                ),
                {"id": new_id(), "channel_id": channel_id, "user_id": user_id, "now": now},
            )
        await collaboration_audit_event(
            db,
            principal,
            category="CHAT",
            operation="CREATE",
            action="chat.dm.create",
            target_type="Channel",
            target_id=channel_id,
            metadata={"peerId": payload.user_id},
        )
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return await _channel_out(db, await _channel_row(db, channel_id), principal.id)


@router.patch("/channels/{channel_id}")
async def update_channel(
    channel_id: str,
    payload: ChannelUpdate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    await require_scope(principal, "chat:write")
    if not await can_manage_channel(db, channel_id, principal):
        raise HTTPException(status_code=403, detail="Only channel admins can edit this channel")
    channel = await _channel_row(db, channel_id)
    values = payload.model_dump(exclude_unset=True)
    if not values:
        raise HTTPException(status_code=422, detail="No channel fields were supplied")
    await db.execute(
        statement(
            "UPDATE channels SET name = :name, description = :description, topic = :topic, "
            '"updatedAt" = :now WHERE id = :id'
        ),
        {
            "id": channel_id,
            "name": values.get("name", channel["name"]),
            "description": values.get("description", channel["description"]),
            "topic": values.get("topic", channel["topic"]),
            "now": utcnow(),
        },
    )
    await collaboration_audit_event(
        db,
        principal,
        category="CHAT",
        operation="UPDATE",
        action="chat.channel.update",
        target_type="Channel",
        target_id=channel_id,
        target_label=channel["name"],
        changes=values,
    )
    await db.commit()
    return await _channel_out(db, await _channel_row(db, channel_id), principal.id)


@router.post("/channels/{channel_id}/archive")
async def archive_channel(
    channel_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, str]:
    await require_scope(principal, "chat:write")
    if not await can_manage_channel(db, channel_id, principal):
        raise HTTPException(status_code=403, detail="Only channel admins can archive this channel")
    await db.execute(
        statement('UPDATE channels SET "isArchived" = true, "updatedAt" = :now WHERE id = :id'),
        {"id": channel_id, "now": utcnow()},
    )
    await collaboration_audit_event(
        db,
        principal,
        category="CHAT",
        operation="UPDATE",
        action="chat.channel.archive",
        target_type="Channel",
        target_id=channel_id,
    )
    await db.commit()
    return {"id": channel_id}


@router.delete("/channels/{channel_id}")
async def delete_channel(
    channel_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, str]:
    await require_scope(principal, "chat:write")
    if not await can_manage_channel(db, channel_id, principal):
        raise HTTPException(status_code=403, detail="Only channel admins can delete this channel")
    channel = await _channel_row(db, channel_id)
    await db.execute(statement("DELETE FROM channels WHERE id = :id"), {"id": channel_id})
    await collaboration_audit_event(
        db,
        principal,
        category="CHAT",
        operation="DELETE",
        action="chat.channel.delete",
        target_type="Channel",
        target_id=channel_id,
        target_label=channel["name"],
    )
    await db.commit()
    return {"id": channel_id}


@router.get("/channels/{channel_id}/members")
async def get_members(
    channel_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> list[dict[str, Any]]:
    await require_scope(principal, "chat:read")
    await require_channel_member(db, channel_id, principal)
    members = await fetch_all(
        db,
        "SELECT u.id, u.name, u.avatar, u.title, cm.role FROM channel_members cm JOIN users u "
        'ON u.id = cm."userId" WHERE cm."channelId" = :id ORDER BY cm."joinedAt"',
        {"id": channel_id},
    )
    return [dict(member, presence="offline") for member in members]


@router.get("/channels/{channel_id}/mentions")
async def get_mention_targets(
    channel_id: str,
    q: str = "",
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> list[dict[str, Any]]:
    await require_scope(principal, "chat:read")
    await require_channel_member(db, channel_id, principal)
    query_clause = " AND u.name ILIKE :like" if q else ""
    mention_params: dict[str, Any] = {"id": channel_id}
    if q:
        mention_params["like"] = f"%{q}%"
    return await fetch_all(
        db,
        "SELECT u.id, u.name, u.avatar, u.title FROM channel_members cm JOIN users u "
        'ON u.id = cm."userId" WHERE cm."channelId" = :id' + query_clause + " LIMIT 8",
        mention_params,
    )


@router.post("/channels/{channel_id}/join")
async def join_channel(
    channel_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, str]:
    await require_scope(principal, "chat:write")
    channel = await _channel_row(db, channel_id)
    if channel["isPrivate"] or channel["type"] == "DM":
        raise HTTPException(status_code=403, detail="This channel is private")
    await db.execute(
        statement(
            'INSERT INTO channel_members (id, "channelId", "userId", role, muted, "joinedAt") '
            "VALUES (:id, :channel_id, :user_id, 'MEMBER', false, :now) "
            'ON CONFLICT ("channelId", "userId") DO NOTHING'
        ),
        {"id": new_id(), "channel_id": channel_id, "user_id": principal.id, "now": utcnow()},
    )
    await collaboration_audit_event(
        db,
        principal,
        category="CHAT",
        operation="UPDATE",
        action="chat.channel.join",
        target_type="Channel",
        target_id=channel_id,
    )
    await db.commit()
    return {"channelId": channel_id}


@router.post("/channels/{channel_id}/leave")
async def leave_channel(
    channel_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, str]:
    await require_scope(principal, "chat:write")
    await db.execute(
        statement('DELETE FROM channel_members WHERE "channelId" = :id AND "userId" = :user_id'),
        {"id": channel_id, "user_id": principal.id},
    )
    await collaboration_audit_event(
        db,
        principal,
        category="CHAT",
        operation="UPDATE",
        action="chat.channel.leave",
        target_type="Channel",
        target_id=channel_id,
    )
    await db.commit()
    await emit_to_user(principal.id, RT_MEMBERSHIP_CHANGED, {"channelId": channel_id})
    return {"channelId": channel_id}


@router.post("/channels/{channel_id}/members")
async def add_members(
    channel_id: str,
    payload: ChannelMembersUpdate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, str]:
    await require_scope(principal, "chat:write")
    channel = await _channel_row(db, channel_id)
    if channel["type"] == "DM":
        raise HTTPException(status_code=400, detail="Cannot add members to a direct message")
    if not await can_manage_channel(db, channel_id, principal):
        raise HTTPException(status_code=403, detail="Only channel admins can add members")
    for user_id in dict.fromkeys(payload.user_ids):
        await db.execute(
            statement(
                'INSERT INTO channel_members (id, "channelId", "userId", role, muted, "joinedAt") '
                "VALUES (:id, :channel_id, :user_id, 'MEMBER', false, :now) "
                'ON CONFLICT ("channelId", "userId") DO NOTHING'
            ),
            {"id": new_id(), "channel_id": channel_id, "user_id": user_id, "now": utcnow()},
        )
    await collaboration_audit_event(
        db,
        principal,
        category="CHAT",
        operation="UPDATE",
        action="chat.channel.members.add",
        target_type="Channel",
        target_id=channel_id,
        metadata={"userIds": payload.user_ids},
    )
    await db.commit()
    return {"channelId": channel_id}


@router.delete("/channels/{channel_id}/members/{user_id}")
async def remove_member(
    channel_id: str,
    user_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, str]:
    await require_scope(principal, "chat:write")
    if user_id != principal.id and not await can_manage_channel(db, channel_id, principal):
        raise HTTPException(status_code=403, detail="Only channel admins can remove members")
    await db.execute(
        statement('DELETE FROM channel_members WHERE "channelId" = :channel_id AND "userId" = :user_id'),
        {"channel_id": channel_id, "user_id": user_id},
    )
    await collaboration_audit_event(
        db,
        principal,
        category="CHAT",
        operation="UPDATE",
        action="chat.channel.member.remove",
        target_type="Channel",
        target_id=channel_id,
        metadata={"userId": user_id},
    )
    await db.commit()
    await emit_to_user(user_id, RT_MEMBERSHIP_CHANGED, {"channelId": channel_id})
    return {"channelId": channel_id}


@router.put("/channels/{channel_id}/mute")
async def set_muted(
    channel_id: str,
    payload: ChannelMuteUpdate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    await require_scope(principal, "chat:write")
    await require_channel_member(db, channel_id, principal)
    await db.execute(
        statement('UPDATE channel_members SET muted = :muted WHERE "channelId" = :id AND "userId" = :user_id'),
        {"muted": payload.muted, "id": channel_id, "user_id": principal.id},
    )
    await collaboration_audit_event(
        db,
        principal,
        category="CHAT",
        operation="UPDATE",
        action="chat.channel.mute",
        target_type="Channel",
        target_id=channel_id,
        changes={"muted": payload.muted},
    )
    await db.commit()
    return {"muted": payload.muted}


@router.post("/channels/{channel_id}/read")
async def mark_read(
    channel_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    await require_scope(principal, "chat:write")
    await require_channel_member(db, channel_id, principal)
    now = utcnow()
    await db.execute(
        statement('UPDATE channel_members SET "lastReadAt" = :now WHERE "channelId" = :id AND "userId" = :user_id'),
        {"now": now, "id": channel_id, "user_id": principal.id},
    )
    await collaboration_audit_event(
        db,
        principal,
        category="CHAT",
        operation="UPDATE",
        action="chat.channel.read",
        target_type="Channel",
        target_id=channel_id,
    )
    await db.commit()
    await emit_to_user(
        principal.id,
        RT_READ,
        {"channelId": channel_id, "userId": principal.id, "lastReadAt": now.isoformat()},
    )
    return {"lastReadAt": now}


@router.get("/channels/{channel_id}/messages")
async def get_messages(
    channel_id: str,
    cursor: str | None = None,
    limit: int = Query(MESSAGE_PAGE_SIZE, ge=1, le=MESSAGE_PAGE_SIZE),
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    await require_scope(principal, "chat:read")
    await require_channel_member(db, channel_id, principal)
    params: dict[str, Any] = {"channel_id": channel_id, "take": limit + 1}
    cursor_clause = ""
    if cursor:
        cursor_clause = ' AND (m."createdAt", m.id) < (SELECT "createdAt", id FROM messages WHERE id = :cursor)'
        params["cursor"] = cursor
    messages = await fetch_all(
        db,
        "SELECT m.*, jsonb_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar, "
        "'title', u.title) AS sender FROM messages m JOIN users u ON u.id = m.\"senderId\" "
        'WHERE m."channelId" = :channel_id AND m."parentId" IS NULL'
        + cursor_clause
        + ' ORDER BY m."createdAt" DESC, m.id DESC LIMIT :take',
        params,
    )
    has_more = len(messages) > limit
    messages = messages[:limit]
    next_cursor = messages[-1]["id"] if has_more and messages else None
    items = await _message_outs(db, list(reversed(messages)), principal.id)
    return {"items": items, "nextCursor": next_cursor}


@router.post("/channels/{channel_id}/messages", status_code=status.HTTP_201_CREATED)
async def send_message(
    channel_id: str,
    payload: MessageCreate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    await require_scope(principal, "chat:write")
    await require_channel_member(db, channel_id, principal)
    if payload.parent_id:
        parent = await fetch_one(
            db,
            'SELECT "channelId", "deletedAt" FROM messages WHERE id = :id',
            {"id": payload.parent_id},
        )
        if not parent or parent["channelId"] != channel_id or parent["deletedAt"]:
            raise HTTPException(status_code=400, detail="Invalid thread parent")
    if any(not attachment.url.startswith(("/uploads/", "/api/files/")) for attachment in payload.attachments):
        raise HTTPException(status_code=400, detail="Invalid attachment URL")
    content = tiptap_to_plain_text(payload.content_json) if payload.content_json is not None else payload.content
    raw_mentions = (
        extract_mention_ids(payload.content_json) if payload.content_json is not None else payload.mention_ids
    )
    if not content.strip() and not payload.attachments:
        raise HTTPException(status_code=400, detail="Message is empty")
    valid_mentions: list[str] = []
    for user_id in dict.fromkeys(raw_mentions):
        if user_id == principal.id:
            continue
        member = await fetch_one(
            db,
            'SELECT id FROM channel_members WHERE "channelId" = :channel_id AND "userId" = :user_id',
            {"channel_id": channel_id, "user_id": user_id},
        )
        if member:
            valid_mentions.append(user_id)
    message_id = new_id()
    now = utcnow()
    try:
        await db.execute(
            statement(
                'INSERT INTO messages (id, content, "contentJson", "channelId", "senderId", "parentId", '
                '"isEdited", "createdAt", "updatedAt") VALUES '
                "(:id, :content, CAST(:content_json AS jsonb), :channel_id, :sender_id, :parent_id, false, :now, :now)"
            ),
            {
                "id": message_id,
                "content": content,
                "content_json": json_text(payload.content_json) if payload.content_json is not None else None,
                "channel_id": channel_id,
                "sender_id": principal.id,
                "parent_id": payload.parent_id,
                "now": now,
            },
        )
        for attachment in payload.attachments:
            await db.execute(
                statement(
                    "INSERT INTO message_attachments "
                    '(id, "messageId", name, url, type, size, duration, "createdAt") '
                    "VALUES (:id, :message_id, :name, :url, :type, :size, :duration, :now)"
                ),
                {
                    "id": new_id(),
                    "message_id": message_id,
                    **attachment.model_dump(),
                    "now": now,
                },
            )
        for user_id in valid_mentions:
            await db.execute(
                statement(
                    'INSERT INTO message_mentions (id, "messageId", "userId", "createdAt") '
                    "VALUES (:id, :message_id, :user_id, :now)"
                ),
                {"id": new_id(), "message_id": message_id, "user_id": user_id, "now": now},
            )
        delivered_mentions: list[str] = []
        if valid_mentions:
            delivered_mentions = await insert_notifications(
                db,
                valid_mentions,
                type="mention",
                title=f"{principal.name} mentioned you",
                message=content[:140],
                entity_type="Message",
                entity_id=message_id,
            )
        await collaboration_audit_event(
            db,
            principal,
            category="CHAT",
            operation="CREATE",
            action="chat.message.send",
            target_type="Message",
            target_id=message_id,
            metadata={"channelId": channel_id, "parentId": payload.parent_id},
        )
        await db.execute(
            statement('UPDATE channels SET "updatedAt" = :now WHERE id = :id'),
            {"now": now, "id": channel_id},
        )
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    message = await _message_out(db, await _message_row(db, message_id), principal.id)
    if payload.parent_id:
        await emit_to_channel(
            channel_id,
            RT_THREAD_REPLY,
            {
                "channelId": channel_id,
                "parentId": payload.parent_id,
                "message": message,
                "replyCount": message["replyCount"],
            },
        )
    else:
        await emit_to_channel(channel_id, RT_MESSAGE_NEW, {"channelId": channel_id, "message": message})
    for user_id in delivered_mentions:
        await emit_to_user(
            user_id,
            RT_NOTIFICATION,
            {
                "id": message_id,
                "title": f"{principal.name} mentioned you",
                "message": content[:140],
                "type": "mention",
                "entityType": "Message",
                "entityId": message_id,
            },
        )
    return message


@router.get("/messages/{message_id}/thread")
async def get_thread(
    message_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    await require_scope(principal, "chat:read")
    parent = await _message_row(db, message_id)
    await require_channel_member(db, parent["channelId"], principal)
    replies = await fetch_all(
        db,
        "SELECT m.*, jsonb_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar, "
        "'title', u.title) AS sender FROM messages m JOIN users u ON u.id = m.\"senderId\" "
        'WHERE m."parentId" = :id ORDER BY m."createdAt"',
        {"id": message_id},
    )
    hydrated = await _message_outs(db, [parent, *replies], principal.id)
    return {"parent": hydrated[0], "replies": hydrated[1:]}


@router.get("/messages/{message_id}/edits")
async def get_message_edit_history(
    message_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    await require_scope(principal, "chat:read")
    message = await _message_row(db, message_id)
    await require_channel_member(db, message["channelId"], principal)
    edits = await fetch_all(
        db,
        'SELECT id, "previousContent", "editedAt" FROM message_edits WHERE "messageId" = :id ORDER BY "editedAt" DESC',
        {"id": message_id},
    )
    return {"current": message["content"], "currentEditedAt": message["editedAt"], "edits": edits}


@router.patch("/messages/{message_id}")
async def edit_message(
    message_id: str,
    payload: MessageUpdate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    await require_scope(principal, "chat:write")
    existing = await _message_row(db, message_id)
    if existing["senderId"] != principal.id:
        raise HTTPException(status_code=403, detail="You can only edit your own messages")
    if existing["deletedAt"]:
        raise HTTPException(status_code=400, detail="Cannot edit a deleted message")
    content = tiptap_to_plain_text(payload.content_json) if payload.content_json is not None else payload.content
    raw_mentions = (
        extract_mention_ids(payload.content_json) if payload.content_json is not None else payload.mention_ids
    )
    prior = await fetch_all(db, 'SELECT "userId" FROM message_mentions WHERE "messageId" = :id', {"id": message_id})
    prior_ids = {row["userId"] for row in prior}
    valid_mentions = []
    for user_id in dict.fromkeys(raw_mentions):
        member = await fetch_one(
            db,
            'SELECT id FROM channel_members WHERE "channelId" = :channel_id AND "userId" = :user_id',
            {"channel_id": existing["channelId"], "user_id": user_id},
        )
        if member:
            valid_mentions.append(user_id)
    newly_mentioned = [uid for uid in valid_mentions if uid not in prior_ids and uid != principal.id]
    now = utcnow()
    try:
        await db.execute(
            statement(
                'INSERT INTO message_edits (id, "messageId", "previousContent", "previousContentJson", "editedAt") '
                "VALUES (:id, :message_id, :content, CAST(:content_json AS jsonb), :now)"
            ),
            {
                "id": new_id(),
                "message_id": message_id,
                "content": existing["content"],
                "content_json": json_text(existing["contentJson"]) if existing["contentJson"] is not None else None,
                "now": now,
            },
        )
        await db.execute(statement('DELETE FROM message_mentions WHERE "messageId" = :id'), {"id": message_id})
        for user_id in valid_mentions:
            await db.execute(
                statement(
                    'INSERT INTO message_mentions (id, "messageId", "userId", "createdAt") '
                    "VALUES (:id, :message_id, :user_id, :now)"
                ),
                {"id": new_id(), "message_id": message_id, "user_id": user_id, "now": now},
            )
        await db.execute(
            statement(
                'UPDATE messages SET content = :content, "contentJson" = CAST(:content_json AS jsonb), '
                '"isEdited" = true, "editedAt" = :now, "updatedAt" = :now WHERE id = :id'
            ),
            {
                "id": message_id,
                "content": content,
                "content_json": json_text(payload.content_json) if payload.content_json is not None else None,
                "now": now,
            },
        )
        delivered_mentions: list[str] = []
        if newly_mentioned:
            delivered_mentions = await insert_notifications(
                db,
                newly_mentioned,
                type="mention",
                title=f"{principal.name} mentioned you",
                message=content[:140],
                entity_type="Message",
                entity_id=message_id,
            )
        await collaboration_audit_event(
            db,
            principal,
            category="CHAT",
            operation="UPDATE",
            action="chat.message.edit",
            target_type="Message",
            target_id=message_id,
            changes={"content": True, "mentions": valid_mentions},
        )
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    message = await _message_out(db, await _message_row(db, message_id), principal.id)
    await emit_to_channel(
        existing["channelId"],
        RT_MESSAGE_UPDATE,
        {"channelId": existing["channelId"], "message": message},
    )
    for user_id in delivered_mentions:
        await emit_to_user(
            user_id,
            RT_NOTIFICATION,
            {
                "id": message_id,
                "title": f"{principal.name} mentioned you",
                "message": content[:140],
                "type": "mention",
                "entityType": "Message",
                "entityId": message_id,
            },
        )
    return message


@router.delete("/messages/{message_id}")
async def delete_message(
    message_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, str]:
    await require_scope(principal, "chat:write")
    existing = await _message_row(db, message_id)
    channel = await _channel_row(db, existing["channelId"])
    can_moderate = principal.role == "ADMIN" and channel["type"] != "DM"
    if existing["senderId"] != principal.id and not can_moderate:
        raise HTTPException(status_code=403, detail="You can only delete your own messages")
    await db.execute(
        statement(
            'UPDATE messages SET content = \'\', "contentJson" = NULL, "deletedAt" = :now, '
            '"updatedAt" = :now WHERE id = :id'
        ),
        {"id": message_id, "now": utcnow()},
    )
    await collaboration_audit_event(
        db,
        principal,
        category="CHAT",
        operation="DELETE",
        action="chat.message.delete",
        target_type="Message",
        target_id=message_id,
        metadata={"channelId": existing["channelId"]},
    )
    await db.commit()
    await emit_to_channel(
        existing["channelId"],
        RT_MESSAGE_DELETE,
        {"channelId": existing["channelId"], "messageId": message_id},
    )
    return {"id": message_id}


@router.post("/messages/{message_id}/reaction")
async def toggle_reaction(
    message_id: str,
    payload: ReactionToggle,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> list[dict[str, Any]]:
    await require_scope(principal, "chat:write")
    message = await _message_row(db, message_id)
    await require_channel_member(db, message["channelId"], principal)
    existing = await fetch_one(
        db,
        'SELECT id FROM message_reactions WHERE "messageId" = :message_id AND "userId" = :user_id AND emoji = :emoji',
        {"message_id": message_id, "user_id": principal.id, "emoji": payload.emoji},
    )
    if existing:
        await db.execute(statement("DELETE FROM message_reactions WHERE id = :id"), {"id": existing["id"]})
    else:
        await db.execute(
            statement(
                'INSERT INTO message_reactions (id, "messageId", "userId", emoji) VALUES (:id, :message_id, :user_id, :emoji)'
            ),
            {"id": new_id(), "message_id": message_id, "user_id": principal.id, "emoji": payload.emoji},
        )
    await collaboration_audit_event(
        db,
        principal,
        category="CHAT",
        operation="UPDATE",
        action="chat.message.reaction.toggle",
        target_type="Message",
        target_id=message_id,
        metadata={"emoji": payload.emoji, "removed": bool(existing)},
    )
    await db.commit()
    rows = await fetch_all(
        db, 'SELECT emoji, "userId" FROM message_reactions WHERE "messageId" = :id', {"id": message_id}
    )
    reactions = aggregate_reactions(rows, principal.id)
    await emit_to_channel(
        message["channelId"],
        RT_REACTION,
        {"channelId": message["channelId"], "messageId": message_id, "reactions": reactions},
    )
    return reactions


@router.post("/messages/{message_id}/pin")
async def toggle_pin(
    message_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    await require_scope(principal, "chat:write")
    message = await _message_row(db, message_id)
    await require_channel_member(db, message["channelId"], principal)
    existing = await fetch_one(db, 'SELECT id FROM pinned_messages WHERE "messageId" = :id', {"id": message_id})
    if existing:
        await db.execute(statement("DELETE FROM pinned_messages WHERE id = :id"), {"id": existing["id"]})
        pinned = False
    else:
        await db.execute(
            statement(
                'INSERT INTO pinned_messages (id, "messageId", "channelId", "pinnedById", "createdAt") '
                "VALUES (:id, :message_id, :channel_id, :user_id, :now)"
            ),
            {
                "id": new_id(),
                "message_id": message_id,
                "channel_id": message["channelId"],
                "user_id": principal.id,
                "now": utcnow(),
            },
        )
        pinned = True
    await collaboration_audit_event(
        db,
        principal,
        category="CHAT",
        operation="UPDATE",
        action="chat.message.pin.toggle",
        target_type="Message",
        target_id=message_id,
        metadata={"isPinned": pinned},
    )
    await db.commit()
    reloaded = await _message_out(db, await _message_row(db, message_id), principal.id)
    await emit_to_channel(
        message["channelId"],
        RT_MESSAGE_UPDATE,
        {"channelId": message["channelId"], "message": reloaded},
    )
    return {"isPinned": pinned}


@router.post("/messages/{message_id}/save")
async def toggle_save(
    message_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    await require_scope(principal, "chat:write")
    message = await _message_row(db, message_id)
    await require_channel_member(db, message["channelId"], principal)
    existing = await fetch_one(
        db,
        'SELECT id FROM saved_messages WHERE "messageId" = :id AND "userId" = :user_id',
        {"id": message_id, "user_id": principal.id},
    )
    if existing:
        await db.execute(statement("DELETE FROM saved_messages WHERE id = :id"), {"id": existing["id"]})
        saved = False
    else:
        await db.execute(
            statement(
                'INSERT INTO saved_messages (id, "messageId", "userId", "createdAt") '
                "VALUES (:id, :message_id, :user_id, :now)"
            ),
            {"id": new_id(), "message_id": message_id, "user_id": principal.id, "now": utcnow()},
        )
        saved = True
    await collaboration_audit_event(
        db,
        principal,
        category="CHAT",
        operation="UPDATE",
        action="chat.message.save.toggle",
        target_type="Message",
        target_id=message_id,
        metadata={"isSaved": saved},
    )
    await db.commit()
    return {"isSaved": saved}


@router.get("/channels/{channel_id}/pins")
async def get_pins(
    channel_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> list[dict[str, Any]]:
    await require_scope(principal, "chat:read")
    await require_channel_member(db, channel_id, principal)
    rows = await fetch_all(
        db,
        "SELECT m.*, jsonb_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar, "
        "'title', u.title) AS sender FROM pinned_messages p JOIN messages m ON m.id = p.\"messageId\" "
        'JOIN users u ON u.id = m."senderId" WHERE p."channelId" = :id ORDER BY p."createdAt" DESC',
        {"id": channel_id},
    )
    return await _message_outs(db, rows, principal.id)


@router.get("/saved")
async def get_saved(
    principal: Principal = Depends(current_principal), db: AsyncConnection = Depends(connection)
) -> list[dict[str, Any]]:
    await require_scope(principal, "chat:read")
    rows = await fetch_all(
        db,
        "SELECT m.*, jsonb_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar, "
        "'title', u.title) AS sender FROM saved_messages s JOIN messages m ON m.id = s.\"messageId\" "
        'JOIN users u ON u.id = m."senderId" '
        'WHERE s."userId" = :user_id AND EXISTS(SELECT 1 FROM channel_members cm '
        'WHERE cm."channelId" = m."channelId" AND cm."userId" = :user_id) '
        'ORDER BY s."createdAt" DESC',
        {"user_id": principal.id},
    )
    return await _message_outs(db, rows, principal.id)


@router.get("/search")
async def search_messages(
    query: str = Query(min_length=1),
    channel_id: str | None = Query(None, alias="channelId"),
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> list[dict[str, Any]]:
    await require_scope(principal, "chat:read")
    if channel_id:
        await require_channel_member(db, channel_id, principal)
    access_clause = (
        'm."channelId" = :channel_id'
        if channel_id
        else 'EXISTS(SELECT 1 FROM channel_members cm WHERE cm."channelId" = m."channelId" AND cm."userId" = :user_id)'
    )
    params = {"query": f"%{query}%", "user_id": principal.id}
    if channel_id:
        params["channel_id"] = channel_id
    rows = await fetch_all(
        db,
        "SELECT m.*, jsonb_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar, "
        "'title', u.title) AS sender FROM messages m JOIN users u ON u.id = m.\"senderId\" "
        'WHERE m."deletedAt" IS NULL AND m.content ILIKE :query AND '
        + access_clause
        + ' ORDER BY m."createdAt" DESC LIMIT 50',
        params,
    )
    return await _message_outs(db, rows, principal.id)
