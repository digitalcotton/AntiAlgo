"""
Tenant Management Routes
"""

from typing import Optional, List
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth import get_current_tenant, require_scope, TenantContext, generate_api_key


router = APIRouter()


# ============================================
# SCHEMAS
# ============================================

class TenantResponse(BaseModel):
    id: int
    external_id: str
    name: str
    slug: str
    plan: str
    max_runs_per_week: int
    max_signals_per_run: int
    created_at: datetime


class TenantUpdateRequest(BaseModel):
    name: Optional[str] = None
    settings: Optional[dict] = None


class APIKeyResponse(BaseModel):
    id: int
    name: str
    scopes: List[str]
    created_at: datetime
    last_used_at: Optional[datetime]
    expires_at: Optional[datetime]


class APIKeyCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    scopes: List[str] = ["read"]


class APIKeyCreateResponse(BaseModel):
    id: int
    name: str
    key: str  # Only returned once on creation
    scopes: List[str]


# ============================================
# ROUTES
# ============================================

@router.get("/me", response_model=TenantResponse)
async def get_current_tenant_info(
    tenant: TenantContext = Depends(get_current_tenant),
):
    """Get current tenant information."""
    # TODO: Fetch full tenant from database
    return {
        "id": tenant.tenant_id,
        "external_id": tenant.external_id,
        "name": tenant.name,
        "slug": tenant.name.lower().replace(" ", "-"),
        "plan": tenant.plan,
        "max_runs_per_week": 10 if tenant.plan == "pro" else 1,
        "max_signals_per_run": 50 if tenant.plan == "pro" else 10,
        "created_at": datetime.utcnow(),
    }


@router.patch("/me", response_model=TenantResponse)
async def update_current_tenant(
    update: TenantUpdateRequest,
    tenant: TenantContext = Depends(get_current_tenant),
):
    """Update current tenant settings."""
    # TODO: Update tenant in database
    return {
        "id": tenant.tenant_id,
        "external_id": tenant.external_id,
        "name": update.name or tenant.name,
        "slug": (update.name or tenant.name).lower().replace(" ", "-"),
        "plan": tenant.plan,
        "max_runs_per_week": 10,
        "max_signals_per_run": 50,
        "created_at": datetime.utcnow(),
    }


@router.get("/me/api-keys", response_model=List[APIKeyResponse])
async def list_api_keys(
    tenant: TenantContext = Depends(get_current_tenant),
):
    """List all API keys for current tenant."""
    # TODO: Fetch from database
    return []


@router.post("/me/api-keys", response_model=APIKeyCreateResponse, status_code=status.HTTP_201_CREATED)
async def create_api_key(
    request: APIKeyCreateRequest,
    tenant: TenantContext = Depends(get_current_tenant),
):
    """
    Create a new API key.
    
    The key is only shown once - save it securely!
    """
    plaintext_key, hashed_key = generate_api_key()
    
    # TODO: Save to database
    # api_key = APIKey(
    #     tenant_id=tenant.tenant_id,
    #     key_hash=hashed_key,
    #     name=request.name,
    #     scopes=request.scopes,
    # )
    # await db.save(api_key)
    
    return {
        "id": 1,
        "name": request.name,
        "key": plaintext_key,  # Only returned once!
        "scopes": request.scopes,
    }


@router.delete("/me/api-keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_api_key(
    key_id: int,
    tenant: TenantContext = Depends(get_current_tenant),
):
    """Revoke an API key."""
    # TODO: Delete from database
    pass


@router.get("/me/usage")
async def get_usage(
    tenant: TenantContext = Depends(get_current_tenant),
):
    """Get current usage statistics."""
    # TODO: Calculate from database
    return {
        "tenant_id": tenant.tenant_id,
        "period": "current_week",
        "runs": {
            "used": 3,
            "limit": 10,
        },
        "questions_ingested": 1500,
        "signals_detected": 45,
        "api_requests": {
            "used": 250,
            "limit": 10000,
        },
    }
