"""
Pipeline Run Routes
"""

from typing import Optional, List
from datetime import datetime
from enum import Enum

from fastapi import APIRouter, Depends, HTTPException, Query, status, BackgroundTasks
from pydantic import BaseModel, Field

from ..auth import get_current_tenant, TenantContext
from ..services import get_db, DatabaseService


router = APIRouter()


# ============================================
# SCHEMAS
# ============================================

class RunStatus(str, Enum):
    running = "running"
    completed = "completed"
    failed = "failed"


class RunSummary(BaseModel):
    id: int
    week: str
    status: RunStatus
    questions_ingested: int
    clusters_created: int
    signals_detected: int
    started_at: datetime
    completed_at: Optional[datetime]


class RunDetail(RunSummary):
    error_message: Optional[str]
    experiment_assignments: dict
    signals: List[dict] = []


class RunCreateRequest(BaseModel):
    week: Optional[str] = Field(None, description="Week to process (YYYY-WNN). Defaults to current week.")
    dry_run: bool = Field(False, description="Run without saving to database")


class RunCreateResponse(BaseModel):
    id: int
    status: str
    message: str


# ============================================
# ROUTES
# ============================================

@router.get("", response_model=List[RunSummary])
async def list_runs(
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    status: Optional[RunStatus] = None,
    week: Optional[str] = None,
    tenant: TenantContext = Depends(get_current_tenant),
    db: DatabaseService = Depends(get_db),
):
    """List pipeline runs for current tenant."""
    runs = await db.list_runs(
        tenant_id=tenant.tenant_id,
        limit=limit,
        offset=offset,
        status=status.value if status else None,
        week=week,
    )
    return runs


@router.get("/{run_id}", response_model=RunDetail)
async def get_run(
    run_id: int,
    tenant: TenantContext = Depends(get_current_tenant),
    db: DatabaseService = Depends(get_db),
):
    """Get details for a specific run."""
    run = await db.get_run(run_id=run_id, tenant_id=tenant.tenant_id)
    if not run:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Run {run_id} not found",
        )
    return run


@router.post("", response_model=RunCreateResponse, status_code=status.HTTP_202_ACCEPTED)
async def create_run(
    request: RunCreateRequest,
    background_tasks: BackgroundTasks,
    tenant: TenantContext = Depends(get_current_tenant),
    db: DatabaseService = Depends(get_db),
):
    """
    Trigger a new pipeline run.
    
    The run executes in the background. Use GET /runs/{id} to check status.
    """
    # Create run record in database
    run = await db.create_run(
        tenant_id=tenant.tenant_id,
        week=request.week,
        dry_run=request.dry_run,
    )
    
    # TODO: Queue background task for actual pipeline execution
    # background_tasks.add_task(run_pipeline, run_id=run["id"], tenant_id=tenant.tenant_id)
    
    return {
        "id": run["id"],
        "status": run["status"],
        "message": f"Pipeline run queued for week {request.week or 'current'}",
    }


@router.delete("/{run_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_run(
    run_id: int,
    tenant: TenantContext = Depends(get_current_tenant),
    db: DatabaseService = Depends(get_db),
):
    """Delete a run and all associated data."""
    deleted = await db.delete_run(run_id=run_id, tenant_id=tenant.tenant_id)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Run {run_id} not found",
        )


@router.get("/{run_id}/signals")
async def get_run_signals(
    run_id: int,
    tier: Optional[str] = Query(None, description="Filter by tier (breakout, strong, signal)"),
    limit: int = Query(20, ge=1, le=100),
    tenant: TenantContext = Depends(get_current_tenant),
    db: DatabaseService = Depends(get_db),
):
    """Get signals from a specific run."""
    # Verify run exists and belongs to tenant
    run = await db.get_run(run_id=run_id, tenant_id=tenant.tenant_id)
    if not run:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Run {run_id} not found",
        )
    
    signals = await db.list_signals(
        tenant_id=tenant.tenant_id,
        run_id=run_id,
        tier=tier,
        limit=limit,
    )
    
    return {
        "run_id": run_id,
        "signals": signals.get("signals", []),
        "total": signals.get("total", 0),
    }


@router.get("/{run_id}/digest")
async def get_run_digest(
    run_id: int,
    format: str = Query("json", pattern="^(json|markdown)$"),
    tenant: TenantContext = Depends(get_current_tenant),
    db: DatabaseService = Depends(get_db),
):
    """Get the generated digest for a run."""
    # Verify run exists and belongs to tenant
    run = await db.get_run(run_id=run_id, tenant_id=tenant.tenant_id)
    if not run:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Run {run_id} not found",
        )
    
    # Get digest from database
    digest = await db.get_run_digest(run_id=run_id, tenant_id=tenant.tenant_id)
    
    if format == "markdown":
        return {
            "format": "markdown",
            "content": digest.get("markdown_content", "# Weekly Curiosity Digest\n\nNo digest generated yet."),
        }
    
    return {
        "format": "json",
        "week": run.get("week", ""),
        "signals": digest.get("signals", []),
        "weird_picks": digest.get("weird_picks", []),
        "stats": {
            "questions_ingested": run.get("questions_ingested", 0),
            "clusters_created": run.get("clusters_created", 0),
            "signals_detected": run.get("signals_detected", 0),
        },
    }
