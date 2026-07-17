import json
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.exc import DataError, IntegrityError, StatementError
from sqlalchemy.ext.asyncio import AsyncConnection

from ..database import connection
from ..security import Principal, current_principal
from .crm_schemas import (
    ClientCreate,
    ClientUpdate,
    ContactCreate,
    ContactUpdate,
    ContractCreate,
    ContractStatusUpdate,
    ContractUpdate,
    DocumentCreate,
    InvoiceFromContract,
)
from .domain_common import dump, execute, fetch_all, fetch_one, log_activity, new_id, require_admin, require_scope

router = APIRouter(prefix="/api/v1", tags=["crm"])

CLIENT_COLUMNS = (
    'id, name, logo, website, industry, location, timezone, notes, status::text AS status, "createdAt", "updatedAt"'
)
CONTRACT_COLUMNS = (
    'id, "clientId", title, "fileUrl", value, currency::text AS currency, status::text AS status, '
    '"startDate", "endDate", "signedAt", notes, "projectId", "createdAt", "updatedAt"'
)


def update_statement(table: str, values: dict[str, Any], casts: dict[str, str] | None = None) -> str:
    del casts
    fields = values.keys() - {"id", "updatedAt"}
    assignments = [f'"{key}" = :{key}' for key in fields]
    if "updatedAt" in values:
        assignments.append('"updatedAt" = :updatedAt')
    return f"UPDATE {table} SET {', '.join(assignments)} WHERE id = :id"


async def contract_payload(db: AsyncConnection, contract_id: str) -> dict[str, Any] | None:
    return await fetch_one(
        db,
        'SELECT c.id, c."clientId", c.title, c."fileUrl", c.value, c.currency::text AS currency, '
        'c.status::text AS status, c."startDate", c."endDate", c."signedAt", c.notes, c."projectId", '
        'c."createdAt", c."updatedAt", '
        "CASE WHEN p.id IS NULL THEN NULL ELSE json_build_object('id', p.id, 'name', p.name) END AS project "
        'FROM contracts c LEFT JOIN projects p ON p.id = c."projectId" WHERE c.id = :id',
        {"id": contract_id},
    )


@router.get("/clients")
async def list_clients(
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "clients:read")
    require_admin(principal)
    clients = await fetch_all(db, f"SELECT {CLIENT_COLUMNS} FROM clients ORDER BY name")
    for client in clients:
        client["contacts"] = await fetch_all(
            db,
            'SELECT id, "clientId", name, email, phone, role, "isPrimary", "createdAt", "updatedAt" '
            'FROM client_contacts WHERE "clientId" = :id AND "isPrimary" = true LIMIT 1',
            {"id": client["id"]},
        )
        counts = await fetch_one(
            db,
            'SELECT (SELECT count(*) FROM projects WHERE "clientId" = :id) AS projects, '
            '(SELECT count(*) FROM invoices WHERE "clientId" = :id) AS invoices, '
            '(SELECT count(*) FROM documents WHERE "clientId" = :id) AS documents',
            {"id": client["id"]},
        ) or {"projects": 0, "invoices": 0, "documents": 0}
        if principal.role != "ADMIN":
            counts["invoices"] = 0
            client["totalRevenue"] = 0
        else:
            revenue = await fetch_one(
                db,
                "SELECT coalesce(sum(total), 0) AS total FROM invoices WHERE \"clientId\" = :id AND status = 'PAID'",
                {"id": client["id"]},
            )
            client["totalRevenue"] = (revenue or {}).get("total", 0)
        client["_count"] = counts
    return {"data": clients}


@router.post("/clients", status_code=status.HTTP_201_CREATED)
async def create_client(
    payload: ClientCreate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "clients:write")
    require_admin(principal)
    values = dump(payload)
    contacts = values.pop("contacts")
    client_id = new_id()
    now = datetime.now(UTC)
    try:
        await execute(
            db,
            'INSERT INTO clients (id, name, logo, website, industry, location, timezone, notes, status, "createdAt", "updatedAt") '
            "VALUES (:id, :name, :logo, :website, :industry, :location, :timezone, :notes, :status, :now, :now)",
            {"id": client_id, **values, "now": now},
        )
        for contact in contacts:
            await execute(
                db,
                'INSERT INTO client_contacts (id, "clientId", name, email, phone, role, "isPrimary", "createdAt", "updatedAt") '
                "VALUES (:id, :client_id, :name, :email, :phone, :role, :is_primary, :now, :now)",
                {
                    "id": new_id(),
                    "client_id": client_id,
                    "name": contact["name"],
                    "email": contact.get("email"),
                    "phone": contact.get("phone"),
                    "role": contact.get("role"),
                    "is_primary": contact.get("isPrimary", False),
                    "now": now,
                },
            )
        await log_activity(
            db,
            principal,
            type="client_created",
            message=f"added client {payload.name}",
            entity_type="Client",
            entity_id=client_id,
        )
        await db.commit()
    except (IntegrityError, DataError, StatementError) as exc:
        await db.rollback()
        raise HTTPException(status_code=400, detail="The client did not pass database validation") from exc
    except Exception:
        await db.rollback()
        raise
    return {"data": await fetch_one(db, f"SELECT {CLIENT_COLUMNS} FROM clients WHERE id = :id", {"id": client_id})}


@router.get("/clients/{client_id}")
async def get_client(
    client_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "clients:read")
    require_admin(principal)
    client = await fetch_one(db, f"SELECT {CLIENT_COLUMNS} FROM clients WHERE id = :id", {"id": client_id})
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    client["contacts"] = await fetch_all(
        db,
        'SELECT id, "clientId", name, email, phone, role, "isPrimary", "createdAt", "updatedAt" '
        'FROM client_contacts WHERE "clientId" = :id ORDER BY "isPrimary" DESC, name',
        {"id": client_id},
    )
    client["projects"] = await fetch_all(
        db,
        'SELECT id, name, description, status::text AS status, type::text AS type, "startDate", "endDate", "techStack", '
        'budget, "clientId", "createdAt", "updatedAt" FROM projects WHERE "clientId" = :id ORDER BY "updatedAt" DESC',
        {"id": client_id},
    )
    client["documents"] = await fetch_all(
        db,
        'SELECT d.id, d.name, d.url, d.type, d.size, d."clientId", d."uploadedById", d."createdAt", '
        "json_build_object('id', u.id, 'name', u.name) AS \"uploadedBy\" "
        'FROM documents d JOIN users u ON u.id = d."uploadedById" WHERE d."clientId" = :id ORDER BY d."createdAt" DESC',
        {"id": client_id},
    )
    if principal.role == "ADMIN":
        client["contracts"] = await fetch_all(
            db,
            f'SELECT {CONTRACT_COLUMNS} FROM contracts WHERE "clientId" = :id ORDER BY "createdAt" DESC',
            {"id": client_id},
        )
        client["invoices"] = await fetch_all(
            db,
            'SELECT * FROM invoices WHERE "clientId" = :id ORDER BY "createdAt" DESC',
            {"id": client_id},
        )
    else:
        client["contracts"] = []
        client["invoices"] = []
    return {"data": client}


@router.patch("/clients/{client_id}")
async def update_client(
    client_id: str,
    payload: ClientUpdate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "clients:write")
    require_admin(principal)
    if not await fetch_one(db, "SELECT id FROM clients WHERE id = :id", {"id": client_id}):
        raise HTTPException(status_code=404, detail="Client not found")
    values = dump(payload, exclude_unset=True)
    if values:
        values.update({"id": client_id, "updatedAt": datetime.now(UTC)})
        await execute(db, update_statement("clients", values, {"status": '::"ClientStatus"'}), values)
        await db.commit()
    return {"data": await fetch_one(db, f"SELECT {CLIENT_COLUMNS} FROM clients WHERE id = :id", {"id": client_id})}


@router.delete("/clients/{client_id}")
async def delete_client(
    client_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "clients:write")
    require_admin(principal)
    client = await fetch_one(
        db,
        'SELECT c.name, (SELECT count(*) FROM invoices i WHERE i."clientId" = c.id) AS invoices FROM clients c WHERE c.id = :id',
        {"id": client_id},
    )
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    if client["invoices"] > 0:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot delete {client['name']}: {client['invoices']} invoice(s) reference this client. Delete or reassign them first.",
        )
    await execute(db, "DELETE FROM clients WHERE id = :id", {"id": client_id})
    await log_activity(db, principal, type="client_deleted", message=f"deleted client {client['name']}")
    await db.commit()
    return {"success": True}


@router.get("/clients/{client_id}/activity")
async def client_activity(
    client_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "clients:read")
    require_admin(principal)
    if not await fetch_one(db, "SELECT id FROM clients WHERE id = :id", {"id": client_id}):
        raise HTTPException(status_code=404, detail="Client not found")
    if principal.role == "ADMIN":
        rows = await fetch_all(
            db,
            'SELECT a.id, a.type, a.message, a."entityType", a."entityId", a.metadata, a."createdAt", '
            "json_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar) AS user "
            'FROM activities a JOIN users u ON u.id = a."userId" WHERE '
            '(a."entityType" = \'Client\' AND a."entityId" = :id) OR '
            '(a."entityType" = \'Contract\' AND a."entityId" IN (SELECT id FROM contracts WHERE "clientId" = :id)) OR '
            '(a."entityType" = \'Invoice\' AND a."entityId" IN (SELECT id FROM invoices WHERE "clientId" = :id)) '
            'ORDER BY a."createdAt" DESC LIMIT 30',
            {"id": client_id},
        )
    else:
        rows = await fetch_all(
            db,
            'SELECT a.id, a.type, a.message, a."entityType", a."entityId", a.metadata, a."createdAt", '
            "json_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar) AS user "
            'FROM activities a JOIN users u ON u.id = a."userId" '
            'WHERE a."entityType" = \'Client\' AND a."entityId" = :id ORDER BY a."createdAt" DESC LIMIT 30',
            {"id": client_id},
        )
    return {"data": rows}


@router.post("/clients/{client_id}/contacts", status_code=status.HTTP_201_CREATED)
async def create_contact(
    client_id: str,
    payload: ContactCreate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "clients:write")
    require_admin(principal)
    if not await fetch_one(db, "SELECT id FROM clients WHERE id = :id", {"id": client_id}):
        raise HTTPException(status_code=404, detail="Client not found")
    contact_id = new_id()
    now = datetime.now(UTC)
    values = dump(payload)
    if values["isPrimary"]:
        await execute(db, 'UPDATE client_contacts SET "isPrimary" = false WHERE "clientId" = :id', {"id": client_id})
    await execute(
        db,
        'INSERT INTO client_contacts (id, "clientId", name, email, phone, role, "isPrimary", "createdAt", "updatedAt") '
        "VALUES (:id, :clientId, :name, :email, :phone, :role, :isPrimary, :now, :now)",
        {"id": contact_id, "clientId": client_id, **values, "now": now},
    )
    await db.commit()
    return {
        "data": await fetch_one(
            db,
            'SELECT id, "clientId", name, email, phone, role, "isPrimary", "createdAt", "updatedAt" FROM client_contacts WHERE id = :id',
            {"id": contact_id},
        )
    }


@router.patch("/contacts/{contact_id}")
async def update_contact(
    contact_id: str,
    payload: ContactUpdate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "clients:write")
    require_admin(principal)
    contact = await fetch_one(db, 'SELECT "clientId" FROM client_contacts WHERE id = :id', {"id": contact_id})
    if not contact:
        raise HTTPException(status_code=404, detail="Contact not found")
    values = dump(payload, exclude_unset=True)
    if values.get("isPrimary") is True:
        await execute(
            db,
            'UPDATE client_contacts SET "isPrimary" = false WHERE "clientId" = :client_id AND id <> :id',
            {"client_id": contact["clientId"], "id": contact_id},
        )
    if values:
        values.update({"id": contact_id, "updatedAt": datetime.now(UTC)})
        await execute(db, update_statement("client_contacts", values), values)
    await db.commit()
    return {
        "data": await fetch_one(
            db,
            'SELECT id, "clientId", name, email, phone, role, "isPrimary", "createdAt", "updatedAt" FROM client_contacts WHERE id = :id',
            {"id": contact_id},
        )
    }


@router.delete("/contacts/{contact_id}")
async def delete_contact(
    contact_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "clients:write")
    require_admin(principal)
    if not await fetch_one(db, "SELECT id FROM client_contacts WHERE id = :id", {"id": contact_id}):
        raise HTTPException(status_code=404, detail="Contact not found")
    await execute(db, "DELETE FROM client_contacts WHERE id = :id", {"id": contact_id})
    await db.commit()
    return {"success": True}


@router.get("/clients/{client_id}/contracts")
async def list_contracts(
    client_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "clients:read")
    require_admin(principal)
    return {
        "data": await fetch_all(
            db,
            f'SELECT {CONTRACT_COLUMNS} FROM contracts WHERE "clientId" = :id ORDER BY "createdAt" DESC',
            {"id": client_id},
        )
    }


@router.post("/clients/{client_id}/contracts", status_code=status.HTTP_201_CREATED)
async def create_contract(
    client_id: str,
    payload: ContractCreate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "clients:write")
    require_admin(principal)
    if not await fetch_one(db, "SELECT id FROM clients WHERE id = :id", {"id": client_id}):
        raise HTTPException(status_code=404, detail="Client not found")
    if payload.project_id and not await fetch_one(
        db, "SELECT id FROM projects WHERE id = :id", {"id": payload.project_id}
    ):
        raise HTTPException(status_code=404, detail="Linked project not found.")
    contract_id = new_id()
    now = datetime.now(UTC)
    values = dump(payload)
    await execute(
        db,
        'INSERT INTO contracts (id, "clientId", title, "fileUrl", value, currency, status, "startDate", "endDate", "signedAt", notes, "projectId", "createdAt", "updatedAt") '
        "VALUES (:id, :clientId, :title, :fileUrl, :value, :currency, :status, :startDate, :endDate, :signedAt, :notes, :projectId, :now, :now)",
        {"id": contract_id, "clientId": client_id, **values, "now": now},
    )
    await log_activity(
        db,
        principal,
        type="contract_created",
        message=f'added contract "{payload.title}"',
        entity_type="Contract",
        entity_id=contract_id,
    )
    await db.commit()
    return {"data": await contract_payload(db, contract_id)}


@router.patch("/contracts/{contract_id}")
async def update_contract(
    contract_id: str,
    payload: ContractUpdate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "clients:write")
    require_admin(principal)
    existing = await fetch_one(db, 'SELECT title, "signedAt" FROM contracts WHERE id = :id', {"id": contract_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Contract not found")
    values = dump(payload, exclude_unset=True)
    project_id = values.get("projectId")
    if project_id and not await fetch_one(db, "SELECT id FROM projects WHERE id = :id", {"id": project_id}):
        raise HTTPException(status_code=404, detail="Linked project not found.")
    if values.get("status") == "SIGNED" and "signedAt" not in values and not existing["signedAt"]:
        values["signedAt"] = datetime.now(UTC)
    if values:
        values.update({"id": contract_id, "updatedAt": datetime.now(UTC)})
        await execute(
            db,
            update_statement("contracts", values, {"currency": '::"Currency"', "status": '::"ContractStatus"'}),
            values,
        )
    contract = await contract_payload(db, contract_id)
    await log_activity(
        db,
        principal,
        type="contract_updated",
        message=f'updated contract "{contract["title"]}"',
        entity_type="Contract",
        entity_id=contract_id,
    )
    await db.commit()
    return {"data": contract}


@router.put("/contracts/{contract_id}/status")
async def set_contract_status(
    contract_id: str,
    payload: ContractStatusUpdate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "clients:write")
    require_admin(principal)
    existing = await fetch_one(db, 'SELECT title, "signedAt" FROM contracts WHERE id = :id', {"id": contract_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Contract not found")
    signed_at = datetime.now(UTC) if payload.status == "SIGNED" and not existing["signedAt"] else existing["signedAt"]
    await execute(
        db,
        'UPDATE contracts SET status = :status, "signedAt" = :signed_at, "updatedAt" = :now WHERE id = :id',
        {"status": payload.status, "signed_at": signed_at, "now": datetime.now(UTC), "id": contract_id},
    )
    await log_activity(
        db,
        principal,
        type="contract_updated",
        message=f'set contract "{existing["title"]}" to {payload.status.lower()}',
        entity_type="Contract",
        entity_id=contract_id,
    )
    await db.commit()
    return {"data": await contract_payload(db, contract_id)}


@router.delete("/contracts/{contract_id}")
async def delete_contract(
    contract_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "clients:write")
    require_admin(principal)
    contract = await fetch_one(db, "SELECT title FROM contracts WHERE id = :id", {"id": contract_id})
    if not contract:
        raise HTTPException(status_code=404, detail="Contract not found")
    await execute(db, "DELETE FROM contracts WHERE id = :id", {"id": contract_id})
    await log_activity(db, principal, type="contract_deleted", message=f'deleted contract "{contract["title"]}"')
    await db.commit()
    return {"success": True}


@router.post("/contracts/{contract_id}/invoice", status_code=status.HTTP_201_CREATED)
async def generate_invoice_from_contract(
    contract_id: str,
    payload: InvoiceFromContract,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "finance:write")
    require_admin(principal)
    contract = await fetch_one(
        db,
        'SELECT c.id, c.title, c.value, c.currency::text AS currency, c."clientId", c."projectId", '
        'cl.name AS "clientName" FROM contracts c JOIN clients cl ON cl.id = c."clientId" WHERE c.id = :id',
        {"id": contract_id},
    )
    if not contract:
        raise HTTPException(status_code=404, detail="Contract not found")
    amount = round(float(contract["value"] or 0), 2)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Set a contract value before generating an invoice.")
    now = datetime.now(UTC)
    year = now.year
    count = await fetch_one(
        db,
        'SELECT count(*) AS count FROM invoices WHERE "invoiceNumber" LIKE :prefix',
        {"prefix": f"INV-{year}-%"},
    )
    invoice_number = f"INV-{year}-{int((count or {}).get('count', 0)) + 1:03d}"
    invoice_id = new_id()
    items = [{"description": contract["title"], "quantity": 1, "rate": amount, "amount": amount}]
    try:
        await execute(
            db,
            'INSERT INTO invoices (id, "invoiceNumber", "clientId", "projectId", items, subtotal, tax, total, '
            'currency, status, "dueDate", notes, "createdAt", "updatedAt") '
            "VALUES (:id, :number, :client_id, :project_id, CAST(:items AS jsonb), :amount, 0, :amount, "
            ":currency, 'DRAFT', :due_date, :notes, :now, :now)",
            {
                "id": invoice_id,
                "number": invoice_number,
                "client_id": contract["clientId"],
                "project_id": contract["projectId"],
                "items": json.dumps(items),
                "amount": amount,
                "currency": contract["currency"],
                "due_date": now + timedelta(days=payload.due_in_days),
                "notes": f'Generated from contract "{contract["title"]}"',
                "now": now,
            },
        )
        await log_activity(
            db,
            principal,
            type="invoice_created",
            message=(
                f'created invoice {invoice_number} from contract "{contract["title"]}" for {contract["clientName"]}'
            ),
            entity_type="Invoice",
            entity_id=invoice_id,
        )
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Invoice numbering conflicted; retry the request.") from exc
    except (DataError, StatementError) as exc:
        await db.rollback()
        raise HTTPException(status_code=400, detail="The invoice did not pass database validation") from exc
    except Exception:
        await db.rollback()
        raise
    invoice = await fetch_one(
        db,
        "SELECT i.*, json_build_object('name', c.name) AS client FROM invoices i "
        'JOIN clients c ON c.id = i."clientId" WHERE i.id = :id',
        {"id": invoice_id},
    )
    return {"data": invoice}


@router.get("/clients/{client_id}/contracted-value")
async def contracted_value(
    client_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "clients:read")
    require_admin(principal)
    return {
        "data": await fetch_all(
            db,
            "SELECT currency::text AS currency, coalesce(sum(value), 0) AS total, count(*) AS count "
            'FROM contracts WHERE "clientId" = :id AND value IS NOT NULL GROUP BY currency ORDER BY total DESC',
            {"id": client_id},
        )
    }


@router.get("/contracts/expiring")
async def expiring_contracts(
    within_days: int = Query(30, alias="withinDays", ge=1, le=365),
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "clients:read")
    require_admin(principal)
    now = datetime.now(UTC)
    return {
        "data": await fetch_all(
            db,
            'SELECT ct.id, ct."clientId", ct.title, ct."fileUrl", ct.value, ct.currency::text AS currency, '
            'ct.status::text AS status, ct."startDate", ct."endDate", ct."signedAt", ct.notes, ct."projectId", '
            "ct.\"createdAt\", ct.\"updatedAt\", json_build_object('id', c.id, 'name', c.name) AS client "
            "FROM contracts ct JOIN clients c ON c.id = ct.\"clientId\" WHERE ct.status IN ('SENT', 'SIGNED') "
            'AND ct."endDate" BETWEEN :now AND :until ORDER BY ct."endDate"',
            {"now": now, "until": now + timedelta(days=within_days)},
        )
    }


@router.post("/contracts/sweep-expired")
async def sweep_expired_contracts(
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, int]:
    require_scope(principal, "clients:write")
    require_admin(principal)
    due = await fetch_all(
        db,
        "SELECT id FROM contracts WHERE status IN ('SENT', 'SIGNED') AND \"endDate\" < :now",
        {"now": datetime.now(UTC)},
    )
    for contract in due:
        await execute(
            db,
            "UPDATE contracts SET status = 'EXPIRED', \"updatedAt\" = :now WHERE id = :id",
            {"now": datetime.now(UTC), "id": contract["id"]},
        )
    if due:
        await log_activity(
            db,
            principal,
            type="contract_updated",
            message=f"expired {len(due)} contract{'' if len(due) == 1 else 's'} past their end date",
        )
    await db.commit()
    return {"expired": len(due)}


@router.get("/clients/{client_id}/documents")
async def list_documents(
    client_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "clients:read")
    require_admin(principal)
    if not await fetch_one(db, "SELECT id FROM clients WHERE id = :id", {"id": client_id}):
        raise HTTPException(status_code=404, detail="Client not found")
    return {
        "data": await fetch_all(
            db,
            'SELECT id, name, url, type, size, "clientId", "uploadedById", "createdAt" FROM documents '
            'WHERE "clientId" = :id ORDER BY "createdAt" DESC',
            {"id": client_id},
        )
    }


@router.post("/clients/{client_id}/documents", status_code=status.HTTP_201_CREATED)
async def create_document(
    client_id: str,
    payload: DocumentCreate,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, Any]:
    require_scope(principal, "clients:write")
    require_admin(principal)
    if not await fetch_one(db, "SELECT id FROM clients WHERE id = :id", {"id": client_id}):
        raise HTTPException(status_code=404, detail="Client not found")
    document_id = new_id()
    await execute(
        db,
        'INSERT INTO documents (id, name, url, type, size, "clientId", "uploadedById", "createdAt") '
        "VALUES (:id, :name, :url, :type, :size, :client_id, :uploaded_by, :now)",
        {
            "id": document_id,
            "name": payload.name,
            "url": str(payload.url),
            "type": payload.type,
            "size": payload.size,
            "client_id": client_id,
            "uploaded_by": principal.id,
            "now": datetime.now(UTC),
        },
    )
    await db.commit()
    return {
        "data": await fetch_one(
            db,
            'SELECT id, name, url, type, size, "clientId", "uploadedById", "createdAt" FROM documents WHERE id = :id',
            {"id": document_id},
        )
    }


@router.delete("/documents/{document_id}")
async def delete_document(
    document_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict[str, bool]:
    require_scope(principal, "clients:write")
    require_admin(principal)
    if not await fetch_one(db, "SELECT id FROM documents WHERE id = :id", {"id": document_id}):
        raise HTTPException(status_code=404, detail="Document not found")
    await execute(db, "DELETE FROM documents WHERE id = :id", {"id": document_id})
    await db.commit()
    return {"success": True}
