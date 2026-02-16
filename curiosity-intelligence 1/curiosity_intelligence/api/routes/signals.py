"""
Signal Routes
"""

from typing import Optional, List
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..auth import get_current_tenant, TenantContext
from ..services import get_db, DatabaseService


router = APIRouter()


# ============================================
# SCHEMAS
# ============================================

class SignalResponse(BaseModel):
    id: int
    run_id: int
    week: str
    canonical_question: str
    
    # Scores
    final_score: float
    velocity_score: float
    cross_platform_score: float
    engagement_score: float
    novelty_score: float
    weirdness_bonus: float
    
    # Classification
    tier: str
    is_signal: bool
    
    # Metrics
    velocity_pct: float
    question_count: int
    platform_count: int
    platforms: List[str]
    
    # Context
    news_trigger: Optional[dict]
    sample_questions: List[str]


class SignalListResponse(BaseModel):
    signals: List[SignalResponse]
    total: int
    page: int
    per_page: int


# ============================================
# ROUTES
# ============================================

@router.get("", response_model=SignalListResponse)
async def list_signals(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    tier: Optional[str] = Query(None, description="Filter by tier"),
    week: Optional[str] = Query(None, description="Filter by week (YYYY-WNN)"),
    min_score: Optional[float] = Query(None, ge=0, le=1),
    search: Optional[str] = Query(None, description="Search question text"),
    tenant: TenantContext = Depends(get_current_tenant),
    db: DatabaseService = Depends(get_db),
):
    """
    List signals with filtering and pagination.
    
    Signals are sorted by score descending by default.
    """
    result = await db.list_signals(
        tenant_id=tenant.tenant_id,
        page=page,
        per_page=per_page,
        tier=tier,
        week=week,
        min_score=min_score,
        search=search,
    )
    return result


@router.get("/trending")
async def get_trending_signals(
    limit: int = Query(10, ge=1, le=50),
    tenant: TenantContext = Depends(get_current_tenant),
    db: DatabaseService = Depends(get_db),
):
    """
    Get trending signals across recent weeks.
    
    Shows signals with highest velocity that are gaining momentum.
    """
    trending = await db.get_trending_signals(
        tenant_id=tenant.tenant_id,
        limit=limit,
    )
    return {"trending": trending}


@router.get("/breakouts")
async def get_breakout_signals(
    weeks: int = Query(4, ge=1, le=12),
    tenant: TenantContext = Depends(get_current_tenant),
    db: DatabaseService = Depends(get_db),
):
    """
    Get all breakout-tier signals from recent weeks.
    """
    result = await db.list_signals(
        tenant_id=tenant.tenant_id,
        page=1,
        per_page=50,
        tier="breakout",
    )
    return {
        "breakouts": result.get("signals", []),
        "weeks_analyzed": weeks,
    }


@router.get("/{signal_id}", response_model=SignalResponse)
async def get_signal(
    signal_id: int,
    tenant: TenantContext = Depends(get_current_tenant),
    db: DatabaseService = Depends(get_db),
):
    """Get details for a specific signal."""
    signal = await db.get_signal(tenant_id=tenant.tenant_id, signal_id=signal_id)
    if not signal:
        raise HTTPException(status_code=404, detail="Signal not found")
    return signal


@router.get("/{signal_id}/questions")
async def get_signal_questions(
    signal_id: int,
    limit: int = Query(50, ge=1, le=200),
    tenant: TenantContext = Depends(get_current_tenant),
    db: DatabaseService = Depends(get_db),
):
    """
    Get all questions that contributed to a signal.
    
    Shows the raw questions from each platform that were
    clustered together to form this signal.
    """
    # Verify signal exists and belongs to tenant
    signal = await db.get_signal(tenant_id=tenant.tenant_id, signal_id=signal_id)
    if not signal:
        raise HTTPException(status_code=404, detail="Signal not found")
    
    questions = await db.get_signal_questions(signal_id=signal_id, limit=limit)
    return {
        "signal_id": signal_id,
        "questions": questions,
        "total": len(questions),
    }


@router.get("/{signal_id}/similar")
async def get_similar_signals(
    signal_id: int,
    limit: int = Query(5, ge=1, le=20),
    tenant: TenantContext = Depends(get_current_tenant),
    db: DatabaseService = Depends(get_db),
):
    """
    Find signals similar to this one from other weeks.
    
    Uses embedding similarity to find related signals.
    """
    # Verify signal exists and belongs to tenant
    signal = await db.get_signal(tenant_id=tenant.tenant_id, signal_id=signal_id)
    if not signal:
        raise HTTPException(status_code=404, detail="Signal not found")
    
    similar = await db.get_similar_signals(signal_id=signal_id, limit=limit)
    return {
        "signal_id": signal_id,
        "similar": similar,
    }
