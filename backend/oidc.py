"""OIDC/OAuth2 SSO — Authorization Code flow with PKCE (issue #62).

Entirely optional and off by default (`backend.config.OIDC_ENABLED`). When
disabled, `is_enabled()` is False and nothing else in this module is ever
invoked — current behavior is unchanged. See `backend/routers/auth.py` for
the `/api/auth/sso/*` endpoints that call into this module.

Flow:
  1. `GET /api/auth/sso/login`    -> build_authorization_request() computes a
     PKCE verifier/challenge, a nonce, and a CSRF `state`, and returns the
     IdP's authorization_endpoint URL to redirect the browser to.
  2. IdP redirects back to `GET /api/auth/sso/callback?code=...&state=...`.
  3. exchange_code_for_tokens() posts the code + PKCE verifier to the token
     endpoint server-to-server — the verifier never touches the browser.
  4. verify_id_token() validates the ID token: signature via the issuer's
     JWKS (cached), iss, aud, exp, and nonce.
  5. provision_or_login_user() finds-or-creates the local `User` row and
     re-evaluates the group -> is_admin mapping on every login.
  6. `routers/auth.py` issues the same HS256 `apt_ui_token` cookie the
     password-login path uses, so every existing endpoint/WebSocket keeps
     working unchanged.

Security notes:
  - `state`, the PKCE verifier, and the `nonce` are held server-side only (an
    in-memory, single-use, short-TTL store) — the browser only ever sees the
    opaque `state` value round-tripped by the IdP redirect itself.
  - The client secret and every token are never logged and never returned by
    any API response.
  - ID token signatures are only accepted for asymmetric algorithms resolved
    via the issuer's JWKS (never HS256/"none"), which rules out
    algorithm-confusion attacks.
  - No new dependency: JWKS fetching + caching uses `jwt.PyJWKClient`, part
    of the `PyJWT` package already in `backend/requirements.txt`.
"""
import base64
import hashlib
import logging
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import httpx
import jwt

from backend import config

logger = logging.getLogger(__name__)

DISCOVERY_CACHE_TTL_SECONDS = 3600  # 1 hour — same pattern as release_check.py's cache
PENDING_TTL_SECONDS = 600  # 10 minutes to complete the round trip to the IdP and back
HTTP_TIMEOUT = 10
# Never accept HS256/"none" — those would let a token be forged/confused with a
# key we don't control (e.g. the client_secret). Only asymmetric algs resolved
# via the issuer's JWKS are trusted.
ALLOWED_ID_TOKEN_ALGORITHMS = ["RS256", "ES256", "PS256"]


class OIDCError(Exception):
    """Raised for any SSO flow failure with a message safe to show the user."""


class OIDCAccountConflict(OIDCError):
    """An SSO identity collided with an existing local account.

    Distinct from a generic auth failure so the login page can say *why* — an
    admin debugging this needs to know it is a name collision, not a bad token.
    """


@dataclass
class _PendingAuth:
    code_verifier: str
    nonce: str
    next_path: str
    created_at: float = field(default_factory=time.time)


# state -> _PendingAuth. Single-use, short TTL, in-memory — same pattern as the
# brute-force tracker in routers/auth.py. Resets on container restart, which
# just means an in-flight SSO login has to be restarted; acceptable for a
# single-node deployment (see CLAUDE.md: "Single Docker container").
_pending: dict[str, _PendingAuth] = {}

# Cache shape: (fetched_at, discovery_document), keyed by issuer.
_discovery_cache: dict[str, tuple[float, dict[str, Any]]] = {}

# One PyJWKClient per jwks_uri, reused so its own signing-key cache is effective.
_jwks_clients: dict[str, "jwt.PyJWKClient"] = {}


def is_enabled() -> bool:
    """SSO is only considered enabled when the flag AND every required setting
    are present — a half-configured deployment behaves as disabled rather than
    erroring on every page load."""
    return bool(
        config.OIDC_ENABLED
        and config.OIDC_ISSUER
        and config.OIDC_CLIENT_ID
        and config.OIDC_CLIENT_SECRET
        and config.OIDC_REDIRECT_URL
    )


def _cleanup_pending() -> None:
    now = time.time()
    expired = [s for s, p in _pending.items() if now - p.created_at > PENDING_TTL_SECONDS]
    for s in expired:
        _pending.pop(s, None)


async def _get_discovery_document() -> dict[str, Any]:
    issuer = config.OIDC_ISSUER.rstrip("/")
    now = time.time()
    cached = _discovery_cache.get(issuer)
    if cached and (now - cached[0]) < DISCOVERY_CACHE_TTL_SECONDS:
        return cached[1]

    url = f"{issuer}/.well-known/openid-configuration"
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            resp = await client.get(url)
        resp.raise_for_status()
        doc = resp.json()
    except Exception as exc:
        logger.warning("OIDC discovery fetch failed (%s): %s", url, exc)
        if cached:
            # Serve the stale copy rather than hard-failing on a transient IdP blip.
            return cached[1]
        raise OIDCError("Could not reach the SSO provider (discovery document unavailable)") from exc

    for required in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
        if required not in doc:
            raise OIDCError(f"SSO provider discovery document is missing '{required}'")

    _discovery_cache[issuer] = (now, doc)
    return doc


def _get_jwks_client(jwks_uri: str) -> "jwt.PyJWKClient":
    client = _jwks_clients.get(jwks_uri)
    if client is None:
        # cache_keys=True caches fetched signing keys; PyJWT transparently
        # refetches once if a kid isn't in the cache, so IdP key rotation
        # doesn't require restarting apt-ui.
        client = jwt.PyJWKClient(jwks_uri, cache_keys=True, lifespan=DISCOVERY_CACHE_TTL_SECONDS)
        _jwks_clients[jwks_uri] = client
    return client


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


async def build_authorization_request(next_path: str = "/") -> str:
    """Return the URL to redirect the browser to in order to start SSO login.

    Raises OIDCError if SSO is disabled/misconfigured or the IdP can't be reached.
    """
    if not is_enabled():
        raise OIDCError("SSO is not enabled")

    doc = await _get_discovery_document()

    code_verifier = _b64url(secrets.token_bytes(48))
    code_challenge = _b64url(hashlib.sha256(code_verifier.encode()).digest())
    nonce = secrets.token_urlsafe(24)
    state = secrets.token_urlsafe(24)

    _cleanup_pending()
    _pending[state] = _PendingAuth(code_verifier=code_verifier, nonce=nonce, next_path=next_path or "/")

    params = {
        "response_type": "code",
        "client_id": config.OIDC_CLIENT_ID,
        "redirect_uri": config.OIDC_REDIRECT_URL,
        "scope": config.OIDC_SCOPES,
        "state": state,
        "nonce": nonce,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    query = httpx.QueryParams(params)
    return f"{doc['authorization_endpoint']}?{query}"


def pop_pending(state: str) -> _PendingAuth:
    """Consume the single-use state entry from an authorization callback.

    Popping (not just reading) makes the state single-use, closing a replay
    window if a callback URL were somehow captured/resent.
    """
    entry = _pending.pop(state, None)
    if entry is None:
        raise OIDCError("Invalid or expired SSO login attempt — please try signing in again")
    if time.time() - entry.created_at > PENDING_TTL_SECONDS:
        raise OIDCError("SSO login attempt expired — please try signing in again")
    return entry


async def exchange_code_for_tokens(code: str, code_verifier: str) -> dict[str, Any]:
    doc = await _get_discovery_document()
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": config.OIDC_REDIRECT_URL,
        "client_id": config.OIDC_CLIENT_ID,
        "client_secret": config.OIDC_CLIENT_SECRET,
        "code_verifier": code_verifier,
    }
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            resp = await client.post(doc["token_endpoint"], data=data, headers={"Accept": "application/json"})
    except Exception as exc:
        logger.warning("OIDC token exchange request failed: %s", exc)
        raise OIDCError("Could not reach the SSO provider to complete sign-in") from exc

    if resp.status_code != 200:
        # Never log the response body verbatim — a token endpoint error can
        # echo back the authorization code or other sensitive values.
        logger.warning("OIDC token exchange failed with status %s", resp.status_code)
        raise OIDCError("The SSO provider rejected the sign-in request")

    tokens = resp.json()
    if "id_token" not in tokens:
        raise OIDCError("The SSO provider did not return an ID token")
    return tokens


async def verify_id_token(id_token: str, expected_nonce: str) -> dict[str, Any]:
    """Validate signature (via JWKS), iss, aud, exp, and nonce. Returns claims."""
    doc = await _get_discovery_document()
    jwks_client = _get_jwks_client(doc["jwks_uri"])
    try:
        signing_key = jwks_client.get_signing_key_from_jwt(id_token)
    except jwt.PyJWKClientError as exc:
        raise OIDCError("Could not verify the SSO provider's ID token signature") from exc

    # Accept the discovery document's own "issuer" (authoritative per the OIDC
    # spec) as well as the configured issuer URL with/without a trailing slash,
    # since admins vary in how they paste the issuer value.
    allowed_issuers = {doc.get("issuer", ""), config.OIDC_ISSUER, config.OIDC_ISSUER.rstrip("/")}
    allowed_issuers.discard("")

    try:
        claims = jwt.decode(
            id_token,
            signing_key.key,
            algorithms=ALLOWED_ID_TOKEN_ALGORITHMS,
            audience=config.OIDC_CLIENT_ID,
            issuer=list(allowed_issuers),
            options={"require": ["exp", "iat", "sub"]},
        )
    except jwt.PyJWTError as exc:
        raise OIDCError(f"ID token validation failed: {exc}") from exc

    if claims.get("nonce") != expected_nonce:
        raise OIDCError("ID token nonce mismatch (possible replay)")

    return claims


# ---------------------------------------------------------------------------
# JIT provisioning + group -> role mapping
# ---------------------------------------------------------------------------

async def provision_or_login_user(db, claims: dict[str, Any]):
    """Find-or-create the local User for these ID token claims, re-evaluating
    the group -> is_admin mapping on every login (so revoking a group in the
    IdP takes effect immediately, not just at first login).

    Matching order: `oidc_subject` first, then `username`.

    Account-takeover decision (documented here, not just in a commit message):
    a username collision with an existing row is only ever linked when that
    row is ALREADY an `oidc` account (re-login), or when an admin has
    explicitly opted in via `OIDC_LINK_EXISTING_USERS=true`. A collision with
    an existing **local** account is refused by default. Silently taking over
    a local account by username match alone would let anyone who can get a
    matching username/email claim issued by the IdP (a typo'd attribute
    mapping, a shared corporate directory, etc.) hijack an existing local
    login — including the break-glass local admin account. Refusing is safe;
    linking is a deliberate admin decision.

    Returns (user, info) where info = {"created": bool, "role_changed": bool,
    "is_admin": bool, "username": str} for the caller to build audit entries.
    """
    from sqlalchemy import select

    from backend.auth import hash_password
    from backend.models import User

    subject = claims.get("sub")
    if not subject:
        raise OIDCError("ID token is missing the 'sub' claim")

    username = (claims.get("preferred_username") or claims.get("email") or str(subject)).strip()
    if not username or len(username) > 100:
        raise OIDCError("Could not derive a valid username from the ID token claims")

    raw_groups = claims.get(config.OIDC_GROUPS_CLAIM) or []
    if isinstance(raw_groups, str):
        groups = [g.strip() for g in raw_groups.split(",") if g.strip()]
    elif isinstance(raw_groups, (list, tuple)):
        groups = [str(g) for g in raw_groups]
    else:
        groups = []
    # Read-only unless the admin has configured a mapping AND the user is in
    # that group — an unconfigured OIDC_ADMIN_GROUP means SSO users are never
    # made admin via group mapping (JIT default is always least-privilege).
    wants_admin = bool(config.OIDC_ADMIN_GROUP) and config.OIDC_ADMIN_GROUP in groups

    result = await db.execute(select(User).where(User.oidc_subject == subject))
    user = result.scalar_one_or_none()

    created = False
    if user is None:
        existing = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
        if existing is not None:
            if existing.auth_provider == "local" and not config.OIDC_LINK_EXISTING_USERS:
                raise OIDCAccountConflict(
                    f"An account named '{username}' already exists and is not linked to SSO. "
                    "Ask an admin to rename the local account, or set "
                    "OIDC_LINK_EXISTING_USERS=true to allow linking by username."
                )
            if existing.auth_provider == "oidc" and existing.oidc_subject and existing.oidc_subject != subject:
                # Two different IdP subjects resolved to the same username claim.
                raise OIDCAccountConflict(f"Username '{username}' is already linked to a different SSO identity")
            user = existing
            user.auth_provider = "oidc"
            user.oidc_subject = subject
        else:
            user = User(
                username=username,
                # password_hash is NOT NULL — fill it with an unusable random
                # bcrypt hash so password login can never succeed for this
                # account (nobody, including apt-ui, knows this value).
                password_hash=hash_password(secrets.token_urlsafe(32)),
                auth_provider="oidc",
                oidc_subject=subject,
                is_admin=wants_admin,
            )
            db.add(user)
            created = True

    # Group->role mapping only applies when an admin group is actually configured.
    # With OIDC_ADMIN_GROUP unset, `wants_admin` is always False, so assigning it
    # unconditionally would demote — on every single login — any SSO user an
    # administrator had deliberately promoted in the UI. Unset means "never
    # auto-promote", not "continuously revoke". When it IS configured the mapping
    # is authoritative in both directions, so revoking the group in the IdP takes
    # effect at the next sign-in.
    if config.OIDC_ADMIN_GROUP:
        role_changed = (not created) and (user.is_admin != wants_admin)
        user.is_admin = wants_admin
    else:
        role_changed = False
    user.last_login = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(user)

    info = {"created": created, "role_changed": role_changed, "is_admin": user.is_admin, "username": user.username}
    return user, info
