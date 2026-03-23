from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user
from backend.database import get_db
from backend.models import Server, ServerGroup, ServerGroupMembership, User
from backend.schemas import ServerGroupCreate, ServerGroupOut, ServerGroupUpdate

router = APIRouter(prefix="/api/groups", tags=["groups"])


async def _get_group_or_404(group_id: int, db: AsyncSession) -> ServerGroup:
    result = await db.execute(select(ServerGroup).where(ServerGroup.id == group_id))
    group = result.scalar_one_or_none()
    if group is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
    return group


async def _server_count(group_id: int, db: AsyncSession) -> int:
    # Count servers via the new multi-group membership table
    result = await db.execute(
        select(func.count()).select_from(ServerGroupMembership).where(
            ServerGroupMembership.group_id == group_id
        )
    )
    membership_count = result.scalar_one()
    if membership_count > 0:
        return membership_count
    # Fallback: count via legacy group_id column
    result2 = await db.execute(
        select(func.count()).select_from(Server).where(Server.group_id == group_id)
    )
    return result2.scalar_one()


@router.get("", response_model=list[ServerGroupOut])
async def list_groups(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(select(ServerGroup).order_by(ServerGroup.sort_order, ServerGroup.name))
    groups = result.scalars().all()
    out = []
    for g in groups:
        count = await _server_count(g.id, db)
        out.append(ServerGroupOut(
            id=g.id, name=g.name, color=g.color,
            sort_order=g.sort_order, server_count=count,
        ))
    return out


@router.post("", response_model=ServerGroupOut, status_code=201)
async def create_group(
    body: ServerGroupCreate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    existing = await db.execute(select(ServerGroup).where(ServerGroup.name == body.name))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="A group with that name already exists")

    group = ServerGroup(name=body.name, color=body.color, sort_order=body.sort_order)
    db.add(group)
    await db.commit()
    await db.refresh(group)
    return ServerGroupOut(id=group.id, name=group.name, color=group.color,
                          sort_order=group.sort_order, server_count=0)


@router.put("/{group_id}", response_model=ServerGroupOut)
async def update_group(
    group_id: int,
    body: ServerGroupUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    group = await _get_group_or_404(group_id, db)

    if body.name is not None:
        existing = await db.execute(
            select(ServerGroup).where(ServerGroup.name == body.name, ServerGroup.id != group_id)
        )
        if existing.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="A group with that name already exists")
        group.name = body.name
    if body.color is not None:
        group.color = body.color
    if body.sort_order is not None:
        group.sort_order = body.sort_order

    await db.commit()
    await db.refresh(group)
    count = await _server_count(group.id, db)
    return ServerGroupOut(id=group.id, name=group.name, color=group.color,
                          sort_order=group.sort_order, server_count=count)


@router.delete("/{group_id}", status_code=204)
async def delete_group(
    group_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    group = await _get_group_or_404(group_id, db)

    from sqlalchemy import delete as sa_delete
    # Remove from multi-group memberships (cascade handles it, but be explicit)
    await db.execute(
        sa_delete(ServerGroupMembership).where(ServerGroupMembership.group_id == group_id)
    )

    # Unassign primary group_id on servers (legacy compat)
    result = await db.execute(select(Server).where(Server.group_id == group_id))
    for server in result.scalars().all():
        server.group_id = None

    await db.delete(group)
    await db.commit()
