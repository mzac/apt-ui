"""
CLI tool for admin operations inside the container.

Usage:
    python -m backend.cli reset-password [--username admin] [--password newpass]
    python -m backend.cli create-user --username zac --password mypass
    python -m backend.cli list-users
"""

import argparse
import getpass
import sys
from datetime import datetime

import bcrypt
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from backend.config import DATABASE_PATH
from backend.models import User

# Use synchronous SQLAlchemy for the CLI — no async needed
_sync_url = f"sqlite:///{DATABASE_PATH}"
_engine = create_engine(_sync_url, connect_args={"check_same_thread": False})


def get_session() -> Session:
    return Session(_engine)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_reset_password(args):
    username = args.username or input("Username [admin]: ").strip() or "admin"
    if args.password:
        new_password = args.password
    else:
        new_password = getpass.getpass("New password: ")
        confirm = getpass.getpass("Confirm password: ")
        if new_password != confirm:
            print("❌  Passwords do not match.", file=sys.stderr)
            sys.exit(1)

    with get_session() as session:
        result = session.execute(select(User).where(User.username == username))
        user = result.scalar_one_or_none()
        if user is None:
            print(f"❌  User '{username}' not found.", file=sys.stderr)
            sys.exit(1)
        user.password_hash = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt()).decode()
        session.commit()
    print(f"✅  Password for '{username}' has been reset.")


def cmd_create_user(args):
    if not args.username:
        print("❌  --username is required.", file=sys.stderr)
        sys.exit(1)
    if args.password:
        password = args.password
    else:
        password = getpass.getpass("Password: ")
        confirm = getpass.getpass("Confirm password: ")
        if password != confirm:
            print("❌  Passwords do not match.", file=sys.stderr)
            sys.exit(1)

    with get_session() as session:
        existing = session.execute(select(User).where(User.username == args.username))
        if existing.scalar_one_or_none():
            print(f"❌  User '{args.username}' already exists.", file=sys.stderr)
            sys.exit(1)
        user = User(
            username=args.username,
            password_hash=bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode(),
            is_admin=not args.readonly,
            created_at=datetime.utcnow(),
        )
        session.add(user)
        session.commit()
    print(f"✅  User '{args.username}' created.")


def cmd_list_users(args):
    with get_session() as session:
        result = session.execute(select(User).order_by(User.id))
        users = result.scalars().all()
    if not users:
        print("No users found.")
        return
    print(f"{'ID':<5} {'Username':<20} {'Admin':<7} {'Created':<25} {'Last Login'}")
    print("-" * 75)
    for u in users:
        created = u.created_at.isoformat() if u.created_at else "—"
        last_login = u.last_login.isoformat() if u.last_login else "never"
        print(f"{u.id:<5} {u.username:<20} {'yes' if u.is_admin else 'no':<7} {created:<25} {last_login}")


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Apt Dashboard CLI")
    subparsers = parser.add_subparsers(dest="command")

    # reset-password
    rp = subparsers.add_parser("reset-password", help="Reset a user's password")
    rp.add_argument("--username", default="admin", help="Username (default: admin)")
    rp.add_argument("--password", default=None, help="New password (prompted if omitted)")

    # create-user
    cu = subparsers.add_parser("create-user", help="Create a new user")
    cu.add_argument("--username", required=True, help="Username")
    cu.add_argument("--password", default=None, help="Password (prompted if omitted)")
    cu.add_argument("--readonly", action="store_true", help="Create as read-only user (cannot mutate state)")

    # list-users
    subparsers.add_parser("list-users", help="List all users")

    args = parser.parse_args()

    if args.command == "reset-password":
        cmd_reset_password(args)
    elif args.command == "create-user":
        cmd_create_user(args)
    elif args.command == "list-users":
        cmd_list_users(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
