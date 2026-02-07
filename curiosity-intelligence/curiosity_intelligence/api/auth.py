"""
Authentication and Authorization

Handles API key validation and tenant context.
"""

import os
import hashlib
import secrets
from typing import Optional, List
from dataclasses import dataclass
from functools import wraps

from fastapi import Depends, HTTPException, Security, status
from fastapi.security import APIKeyHeader, HTTPBearer, HTTPAuthorizationCredentials

from ..infra.observability import logger


# Security schemes
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)
bearer_scheme = HTTPBearer(auto_error=False)


@dataclass
class TenantContext:
    """Current tenant context from authentication."""
    tenant_id: int
    external_id: str
    name: str
    plan: str
    scopes: List[str]


def hash_api_key(key: str) -> str:
    """Hash an API key for storage."""
    return hashlib.sha256(key.encode()).hexdigest()


def generate_api_key() -> tuple:
    """
    Generate a new API key.
    
    Returns:
        (plaintext_key, hashed_key)
    """
    key = f"ci_{secrets.token_urlsafe(32)}"
    return key, hash_api_key(key)


async def get_current_tenant(
    api_key: Optional[str] = Security(api_key_header),
    bearer: Optional[HTTPAuthorizationCredentials] = Security(bearer_scheme),
) -> TenantContext:
    """
    Validate authentication and return tenant context.
    
    Supports:
    - X-API-Key header
    - Bearer token (JWT from Supabase Auth)
    - Dev mode bypass (ENVIRONMENT=development)
    """
    
    # Dev mode: skip auth entirely
    if os.environ.get("ENVIRONMENT", "development") == "development":
        return TenantContext(
            tenant_id=1,
            external_id="dev-tenant",
            name="Development",
            plan="enterprise",
            scopes=["read", "write", "admin"],
        )
    
    # Try API key first
    if api_key:
        tenant = await _validate_api_key(api_key)
        if tenant:
            return tenant
    
    # Try bearer token
    if bearer:
        tenant = await _validate_bearer_token(bearer.credentials)
        if tenant:
            return tenant
    
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or missing authentication",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def _validate_api_key(key: str) -> Optional[TenantContext]:
    """Validate API key and return tenant context."""
    from .services.database import get_db
    
    # Check test key for development
    test_key = os.environ.get("TEST_API_KEY")
    if test_key and key == test_key:
        return TenantContext(
            tenant_id=1,
            external_id="test-tenant",
            name="Test Tenant",
            plan="pro",
            scopes=["read", "write", "admin"],
        )
    
    # Query database for API key
    try:
        db = await get_db()
        key_hash = hash_api_key(key)
        api_key_record = await db.get_api_key_by_hash(key_hash)
        
        if api_key_record:
            tenant_data = api_key_record.get('tenants', {})
            
            # Update last used timestamp
            await db.update_api_key_last_used(api_key_record['id'])
            
            return TenantContext(
                tenant_id=tenant_data.get('id', 0),
                external_id=tenant_data.get('external_id', ''),
                name=tenant_data.get('name', 'Unknown'),
                plan=tenant_data.get('plan', 'free'),
                scopes=api_key_record.get('scopes', ['read']),
            )
    except Exception as e:
        from ..infra.observability import logger
        logger.error("api_key_validation_failed", error=str(e))
    
    return None


async def _validate_bearer_token(token: str) -> Optional[TenantContext]:
    """Validate JWT bearer token (Supabase Auth)."""
    
    # In production, validate JWT with Supabase
    # For now, skip validation in development
    if os.environ.get("ENVIRONMENT") == "development":
        # Parse JWT without validation (dev only)
        try:
            import jwt
            payload = jwt.decode(token, options={"verify_signature": False})
            return TenantContext(
                tenant_id=1,
                external_id=payload.get("sub", "dev-user"),
                name=payload.get("email", "Developer"),
                plan="pro",
                scopes=["read", "write", "admin"],
            )
        except Exception:
            pass
    
    # TODO: Validate with Supabase
    # supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    # user = supabase.auth.get_user(token)
    # if user:
    #     tenant = await db.get_tenant_by_external_id(user.id)
    #     return TenantContext(...)
    
    return None


def require_scope(scope: str):
    """
    Dependency that requires a specific scope.
    
    Usage:
        @router.get("/admin", dependencies=[Depends(require_scope("admin"))])
        async def admin_endpoint():
            ...
    """
    async def check_scope(tenant: TenantContext = Depends(get_current_tenant)):
        if scope not in tenant.scopes:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Scope '{scope}' required",
            )
        return tenant
    return check_scope


def require_plan(min_plan: str):
    """
    Dependency that requires a minimum plan level.
    
    Plan hierarchy: free < pro < enterprise
    """
    plan_levels = {"free": 0, "pro": 1, "enterprise": 2}
    
    async def check_plan(tenant: TenantContext = Depends(get_current_tenant)):
        tenant_level = plan_levels.get(tenant.plan, 0)
        required_level = plan_levels.get(min_plan, 0)
        
        if tenant_level < required_level:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Plan '{min_plan}' or higher required",
            )
        return tenant
    return check_plan
