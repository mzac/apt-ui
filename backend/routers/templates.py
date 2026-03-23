from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.auth import get_current_user
from backend.database import get_db
from backend.models import Template, TemplatePackage, User
from backend.schemas import (
    TemplateCreate, TemplateOut, TemplatePackageCreate, TemplatePackageOut, TemplateUpdate,
)

router = APIRouter(prefix="/api/templates", tags=["templates"])


async def _get_template_or_404(template_id: int, db: AsyncSession) -> Template:
    result = await db.execute(
        select(Template).where(Template.id == template_id)
    )
    t = result.scalar_one_or_none()
    if t is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Template not found")
    return t


def _template_out(t: Template) -> TemplateOut:
    return TemplateOut(
        id=t.id,
        name=t.name,
        description=t.description,
        created_at=t.created_at,
        packages=[
            TemplatePackageOut(
                id=p.id,
                template_id=p.template_id,
                package_name=p.package_name,
                notes=p.notes,
            )
            for p in t.packages
        ],
    )


@router.get("", response_model=list[TemplateOut])
async def list_templates(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(select(Template).order_by(Template.name))
    templates = result.scalars().all()
    # Eagerly load packages
    out = []
    for t in templates:
        await db.refresh(t, ["packages"])
        out.append(_template_out(t))
    return out


@router.post("", response_model=TemplateOut, status_code=201)
async def create_template(
    body: TemplateCreate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    template = Template(name=body.name, description=body.description)
    db.add(template)
    await db.flush()

    for pkg in body.packages:
        db.add(TemplatePackage(
            template_id=template.id,
            package_name=pkg.package_name,
            notes=pkg.notes,
        ))

    await db.commit()
    await db.refresh(template, ["packages"])
    return _template_out(template)


@router.put("/{template_id}", response_model=TemplateOut)
async def update_template(
    template_id: int,
    body: TemplateUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    template = await _get_template_or_404(template_id, db)

    if body.name is not None:
        template.name = body.name
    if body.description is not None:
        template.description = body.description

    await db.commit()
    await db.refresh(template, ["packages"])
    return _template_out(template)


@router.delete("/{template_id}", status_code=204)
async def delete_template(
    template_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    template = await _get_template_or_404(template_id, db)
    await db.delete(template)
    await db.commit()


@router.post("/{template_id}/packages", response_model=TemplatePackageOut, status_code=201)
async def add_template_package(
    template_id: int,
    body: TemplatePackageCreate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    await _get_template_or_404(template_id, db)
    pkg = TemplatePackage(
        template_id=template_id,
        package_name=body.package_name,
        notes=body.notes,
    )
    db.add(pkg)
    await db.commit()
    await db.refresh(pkg)
    return TemplatePackageOut(
        id=pkg.id,
        template_id=pkg.template_id,
        package_name=pkg.package_name,
        notes=pkg.notes,
    )


@router.delete("/{template_id}/packages/{pkg_id}", status_code=204)
async def remove_template_package(
    template_id: int,
    pkg_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_user),
):
    result = await db.execute(
        select(TemplatePackage).where(
            TemplatePackage.id == pkg_id,
            TemplatePackage.template_id == template_id,
        )
    )
    pkg = result.scalar_one_or_none()
    if pkg is None:
        raise HTTPException(status_code=404, detail="Package not found")
    await db.delete(pkg)
    await db.commit()


