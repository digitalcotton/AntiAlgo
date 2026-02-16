"""
Health Check Routes
"""

import os
from datetime import datetime

from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health_check():
    """Basic health check - always returns quickly."""
    return {
        "status": "healthy",
        "service": "curiosity-intelligence",
        "version": "1.0.0",
        "timestamp": datetime.utcnow().isoformat(),
    }


@router.get("/ready")
async def readiness_check():
    """
    Readiness check with dependency status.
    
    Used by load balancers to determine if the service can handle traffic.
    """
    from ..services.database import get_db
    
    checks = {
        "api": {"status": "ok"},
        "database": {"status": "unknown"},
        "redis": {"status": "unknown"},
    }
    
    overall_status = "ready"
    
    # Check database
    try:
        db = await get_db()
        db_health = await db.health_check()
        if db_health.get("connected"):
            checks["database"] = {
                "status": "ok",
                "latency_ms": db_health.get("latency_ms"),
            }
        else:
            checks["database"] = {
                "status": "error",
                "error": db_health.get("error", "Not connected"),
            }
            overall_status = "degraded"
    except Exception as e:
        checks["database"] = {"status": "error", "error": str(e)}
        overall_status = "degraded"
    
    # Check Redis (if configured)
    redis_url = os.environ.get("REDIS_URL")
    if redis_url:
        try:
            import redis.asyncio as redis
            r = redis.from_url(redis_url)
            await r.ping()
            checks["redis"] = {"status": "ok"}
            await r.close()
        except Exception as e:
            checks["redis"] = {"status": "error", "error": str(e)}
            # Redis is optional, don't mark as degraded
    else:
        checks["redis"] = {"status": "skipped", "reason": "Not configured"}
    
    return {
        "status": overall_status,
        "timestamp": datetime.utcnow().isoformat(),
        "checks": checks,
    }


@router.get("/live")
async def liveness_check():
    """
    Liveness check - verifies the process is running.
    
    Used by Kubernetes to determine if the container should be restarted.
    """
    return {"status": "alive"}
