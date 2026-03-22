from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from backend.config import DATABASE_URL


engine = create_async_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
    echo=False,
)

AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    pass


async def get_db():
    async with AsyncSessionLocal() as session:
        yield session


async def init_db():
    from backend import models  # noqa: F401 — ensure models are registered
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Apply incremental column migrations for existing databases.
        # SQLite supports ALTER TABLE ADD COLUMN but not IF NOT EXISTS,
        # so we catch the error when a column already exists.
        migrations = [
            "ALTER TABLE update_checks ADD COLUMN autoremove_count INTEGER DEFAULT 0",
            "ALTER TABLE update_checks ADD COLUMN autoremove_packages TEXT",
            "ALTER TABLE servers ADD COLUMN os_info TEXT",
            "ALTER TABLE servers ADD COLUMN is_enabled BOOLEAN DEFAULT 1",
            "ALTER TABLE servers ADD COLUMN tags TEXT",
        ]
        for sql in migrations:
            try:
                await conn.execute(__import__('sqlalchemy').text(sql))
            except Exception:
                pass  # Column already exists — ignore
