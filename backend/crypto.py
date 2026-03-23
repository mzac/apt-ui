"""
Symmetric encryption for secrets stored in the database (e.g. per-server SSH keys).

Uses Fernet (AES-128-CBC + HMAC-SHA256) from the cryptography library.

Key derivation:
  1. ENCRYPTION_KEY env var (preferred — set this explicitly)
  2. JWT_SECRET env var (fallback — convenient for single-env setups)
  3. Ephemeral random key (last resort — warns loudly; keys won't survive restarts)

The raw env var string is SHA-256 hashed to produce a fixed-length key, so there
are no requirements on the format or length of the env var value.
"""

import base64
import hashlib
import logging

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)

_fernet: Fernet | None = None


def _build_fernet() -> Fernet:
    from backend.config import ENCRYPTION_KEY, JWT_SECRET

    raw = ENCRYPTION_KEY or JWT_SECRET
    if raw:
        key_bytes = hashlib.sha256(raw.encode()).digest()
        fernet_key = base64.urlsafe_b64encode(key_bytes)
        if not ENCRYPTION_KEY:
            logger.info(
                "ENCRYPTION_KEY not set — deriving encryption key from JWT_SECRET. "
                "Set ENCRYPTION_KEY explicitly to decouple the two secrets."
            )
    else:
        fernet_key = Fernet.generate_key()
        logger.warning(
            "Neither ENCRYPTION_KEY nor JWT_SECRET is set. "
            "Per-server SSH keys are encrypted with an ephemeral key and will "
            "NOT survive a container restart. Set ENCRYPTION_KEY to persist them."
        )

    return Fernet(fernet_key)


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
