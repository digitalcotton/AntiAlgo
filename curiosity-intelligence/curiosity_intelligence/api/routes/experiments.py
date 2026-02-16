"""
Experiment Routes
"""

from typing import Optional, List
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..auth import get_current_tenant, require_scope, TenantContext
from ...infra.experiments import (
    get_experiment_manager,
    EXPERIMENTS,
    Experiment,
    Variant,
)


router = APIRouter()


# ============================================
# SCHEMAS
# ============================================

class VariantSchema(BaseModel):
    name: str
    weight: float
    config: dict


class ExperimentSchema(BaseModel):
    name: str
    description: str
    variants: List[VariantSchema]
    enabled: bool
    is_active: bool


class ExperimentAssignmentSchema(BaseModel):
    experiment: str
    variant: str
    config: dict


class ExperimentOverrideRequest(BaseModel):
    variant: str


class ExperimentEventRequest(BaseModel):
    event: str
    value: Optional[float] = None
    metadata: Optional[dict] = None


# ============================================
# ROUTES
# ============================================

@router.get("", response_model=List[ExperimentSchema])
async def list_experiments(
    tenant: TenantContext = Depends(get_current_tenant),
):
    """List all available experiments."""
    return [
        {
            "name": exp.name,
            "description": exp.description,
            "variants": [
                {"name": v.name, "weight": v.weight, "config": v.config}
                for v in exp.variants
            ],
            "enabled": exp.enabled,
            "is_active": exp.is_active(),
        }
        for exp in EXPERIMENTS.values()
    ]


@router.get("/assignments", response_model=List[ExperimentAssignmentSchema])
async def get_assignments(
    tenant: TenantContext = Depends(get_current_tenant),
):
    """Get current experiment assignments for this tenant."""
    manager = get_experiment_manager()
    user_id = tenant.external_id
    
    assignments = []
    for name, experiment in EXPERIMENTS.items():
        if experiment.is_active():
            variant = manager.get_variant(name, user_id)
            if variant:
                assignments.append({
                    "experiment": name,
                    "variant": variant.name,
                    "config": variant.config,
                })
    
    return assignments


@router.get("/{experiment_name}")
async def get_experiment(
    experiment_name: str,
    tenant: TenantContext = Depends(get_current_tenant),
):
    """Get details for a specific experiment."""
    experiment = EXPERIMENTS.get(experiment_name)
    if not experiment:
        raise HTTPException(status_code=404, detail="Experiment not found")
    
    manager = get_experiment_manager()
    current_variant = manager.get_variant(experiment_name, tenant.external_id)
    
    return {
        "name": experiment.name,
        "description": experiment.description,
        "variants": [
            {"name": v.name, "weight": v.weight, "config": v.config}
            for v in experiment.variants
        ],
        "enabled": experiment.enabled,
        "is_active": experiment.is_active(),
        "current_assignment": current_variant.name if current_variant else None,
        "current_config": current_variant.config if current_variant else None,
    }


@router.post("/{experiment_name}/override")
async def override_assignment(
    experiment_name: str,
    request: ExperimentOverrideRequest,
    tenant: TenantContext = Depends(require_scope("admin")),
):
    """
    Override experiment assignment (admin only).
    
    Useful for testing specific variants.
    """
    experiment = EXPERIMENTS.get(experiment_name)
    if not experiment:
        raise HTTPException(status_code=404, detail="Experiment not found")
    
    # Validate variant exists
    variant_names = [v.name for v in experiment.variants]
    if request.variant not in variant_names:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid variant. Options: {variant_names}",
        )
    
    manager = get_experiment_manager()
    manager.override_variant(experiment_name, tenant.external_id, request.variant)
    
    return {
        "experiment": experiment_name,
        "variant": request.variant,
        "status": "overridden",
    }


@router.delete("/{experiment_name}/override")
async def clear_override(
    experiment_name: str,
    tenant: TenantContext = Depends(require_scope("admin")),
):
    """Clear experiment override and revert to natural assignment."""
    # TODO: Clear override in database
    return {"status": "cleared"}


@router.post("/{experiment_name}/events")
async def track_event(
    experiment_name: str,
    request: ExperimentEventRequest,
    tenant: TenantContext = Depends(get_current_tenant),
):
    """
    Track an event for experiment analysis.
    
    Events are used to measure experiment success metrics.
    """
    manager = get_experiment_manager()
    manager.track_event(
        experiment_name=experiment_name,
        user_id=tenant.external_id,
        event=request.event,
        value=request.value,
        metadata=request.metadata,
    )
    
    return {"status": "tracked"}


@router.get("/{experiment_name}/results")
async def get_experiment_results(
    experiment_name: str,
    tenant: TenantContext = Depends(require_scope("admin")),
):
    """
    Get experiment results and analysis (admin only).
    
    Shows conversion rates, statistical significance, etc.
    """
    experiment = EXPERIMENTS.get(experiment_name)
    if not experiment:
        raise HTTPException(status_code=404, detail="Experiment not found")
    
    # TODO: Calculate from experiment_events table
    return {
        "experiment": experiment_name,
        "total_participants": 0,
        "variants": [
            {
                "name": v.name,
                "participants": 0,
                "events": {},
                "conversion_rate": 0.0,
            }
            for v in experiment.variants
        ],
        "winner": None,
        "confidence": 0.0,
    }
