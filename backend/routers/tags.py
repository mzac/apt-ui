from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user, require_admin
from backend.database import get_db
from backend.models import ServerTag, Tag, User
from backend.schemas import TagCreate, TagOut, TagUpdate

router = APIRouter(prefix="/api/tags", tags=["tags"])


async def _get_tag_or_404(tag_id: int, db: AsyncSession) -> Tag:
    result = await db.execute(select(Tag).where(Tag.id == tag_id))
    tag = result.scalar_one_or_none()
    if tag is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tag not found")
    return tag


async def _server_count(tag_id: int, db: AsyncSession) -> int:
    result = await db.execute(
        select(func.count()).select_from(ServerTag).where(ServerTag.tag_id == tag_id)
    )
    return result.scalar_one()


@router.get("", response_model=list[TagOut])
async def list_tags(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(select(Tag).order_by(Tag.sort_order, Tag.name))
    tags = result.scalars().all()
    out = []
    for t in tags:
        count = await _server_count(t.id, db)
        out.append(TagOut(id=t.id, name=t.name, color=t.color, sort_order=t.sort_order, server_count=count))
    return out


@router.post("", response_model=TagOut, status_code=201)
async def create_tag(
    body: TagCreate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    existing = await db.execute(select(Tag).where(Tag.name == body.name))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="A tag with that name already exists")

    tag = Tag(name=body.name, color=body.color, sort_order=body.sort_order)
    db.add(tag)
    await db.commit()
    await db.refresh(tag)
    return TagOut(id=tag.id, name=tag.name, color=tag.color, sort_order=tag.sort_order, server_count=0)


@router.put("/{tag_id}", response_model=TagOut)
async def update_tag(
    tag_id: int,
    body: TagUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    tag = await _get_tag_or_404(tag_id, db)

    if body.name is not None:
        existing = await db.execute(
            select(Tag).where(Tag.name == body.name, Tag.id != tag_id)
        )
        if existing.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="A tag with that name already exists")
        tag.name = body.name
    if body.color is not None:
        tag.color = body.color
    if body.sort_order is not None:
        tag.sort_order = body.sort_order

    await db.commit()
    await db.refresh(tag)
    count = await _server_count(tag.id, db)
    return TagOut(id=tag.id, name=tag.name, color=tag.color, sort_order=tag.sort_order, server_count=count)


@router.delete("/{tag_id}", status_code=204)
async def delete_tag(
    tag_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    tag = await _get_tag_or_404(tag_id, db)
    # server_tag associations cascade via the model relationship
    await db.delete(tag)
    await db.commit()
