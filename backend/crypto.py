"""
Symmetric encryption for secrets stored in the database (e.g. per-server SSH keys).

Uses Fernet (AES-128-CBC + HMAC-SHA256) from the cryptography library.

Key derivation (in order):
  1. ENCRYPTION_KEY env var (preferred — set this explicitly)
  2. JWT_SECRET env var (fallback — convenient for single-env setups)
  3. Key persisted in the `app_config` table, auto-generated on first start
     (`init_encryption_key()` is called from `seed_defaults()`). The DB lives on
     a mounted volume, so this survives container restarts.
  4. Ephemeral random key (last resort — warns loudly; only reached if the
     encryption layer is used before startup initialisation).

The raw key string is SHA-256 hashed to produce a fixed-length key, so there
are no requirements on the format or length of the value.
"""

import base64
import hashlib
import logging

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)

_fernet: Fernet | None = None


def _fernet_from_raw(raw: str) -> Fernet:
    key_bytes = hashlib.sha256(raw.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key_bytes))


def env_key() -> str:
    """Return the encryption key from the environment, or "" if unset.

    Exposed so startup code can tell whether it needs to fall back to the
    DB-persisted key.
    """
    from backend.config import ENCRYPTION_KEY, JWT_SECRET

    return ENCRYPTION_KEY or JWT_SECRET


def init_encryption_key(raw: str) -> None:
    """Called once at startup with the resolved key (env var or DB-persisted)."""
    global _fernet
    _fernet = _fernet_from_raw(raw)


def _build_fernet() -> Fernet:
    raw = env_key()
    if raw:
        return _fernet_from_raw(raw)

    logger.warning(
        "Encryption key requested before startup initialisation and no "
        "ENCRYPTION_KEY / JWT_SECRET is set. Using an ephemeral key — stored "
        "SSH keys and TOTP secrets will NOT be readable after a restart."
    )
    return Fernet(Fernet.generate_key())


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = _build_fernet()
    return _fernet


def encrypt(plaintext: str) -> str:
    """Encrypt *plaintext* and return a URL-safe base64 ciphertext string."""
    return _get_fernet().encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: str) -> str:
    """Decrypt a ciphertext produced by :func:`encrypt`. Raises on bad data."""
    try:
        return _get_fernet().decrypt(ciphertext.encode()).decode()
    except InvalidToken as exc:
        raise ValueError(
            "Failed to decrypt stored SSH key — the ENCRYPTION_KEY may have changed. "
            "Clear and re-enter the key for this server."
        ) from exc
