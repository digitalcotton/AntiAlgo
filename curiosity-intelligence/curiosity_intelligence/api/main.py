"""
API Main Application

FastAPI application setup with routes, middleware, and error handling.
"""

import os
from contextlib import asynccontextmanager
from typing import Optional

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from ..infra.observability import init_observability, logger, metrics


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    # Startup
    init_observability(service_name="curiosity-intelligence-api")
    logger.info("api_starting", version="1.0.0")
    
    yield
    
    # Shutdown
    logger.info("api_stopping")


def create_app() -> FastAPI:
    """Create and configure FastAPI application."""
    
    app = FastAPI(
        title="Curiosity Intelligence API",
        description="API for managing curiosity signal detection and analysis",
        version="1.0.0",
        docs_url="/docs",
        redoc_url="/redoc",
        lifespan=lifespan,
    )
    
    # CORS middleware - include both www and non-www versions
    cors_origins = os.environ.get(
        "CORS_ORIGINS", 
        "http://localhost:3000,http://localhost:3001,http://localhost:3002"
    ).split(",")
    # Always include production domains
    production_origins = [
        "https://antialgo.ai",
        "https://www.antialgo.ai", 
        "https://anti-algo.vercel.app",
    ]
    all_origins = list(set(cors_origins + production_origins))
    
    app.add_middleware(
        CORSMiddleware,
        allow_origins=all_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    
    # Request logging middleware
    @app.middleware("http")
    async def log_requests(request: Request, call_next):
        start_time = __import__("time").time()
        
        response = await call_next(request)
        
        duration = __import__("time").time() - start_time
        logger.info(
            "http_request",
            method=request.method,
            path=request.url.path,
            status=response.status_code,
            duration_ms=round(duration * 1000, 2),
        )
        
        metrics.increment("http_requests", tags={"path": request.url.path, "status": response.status_code})
        metrics.histogram("http_duration_ms", duration * 1000, tags={"path": request.url.path})
        
        return response
    
    # Exception handlers
    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException):
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": exc.detail, "status_code": exc.status_code},
        )
    
    @app.exception_handler(Exception)
    async def general_exception_handler(request: Request, exc: Exception):
        logger.error("unhandled_exception", error=str(exc), path=request.url.path)
        return JSONResponse(
            status_code=500,
            content={"error": "Internal server error", "status_code": 500},
        )
    
    # Register routers
    from .routes import runs, signals, tenants, experiments, health, subscribers
    
    app.include_router(health.router, tags=["Health"])
    app.include_router(tenants.router, prefix="/api/v1/tenants", tags=["Tenants"])
    app.include_router(runs.router, prefix="/api/v1/runs", tags=["Runs"])
    app.include_router(signals.router, prefix="/api/v1/signals", tags=["Signals"])
    app.include_router(experiments.router, prefix="/api/v1/experiments", tags=["Experiments"])
    app.include_router(subscribers.router, prefix="/api/v1/subscribers", tags=["Subscribers"])
    
    return app


# Default app instance
app = create_app()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "curiosity_intelligence.api.main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8000)),
        reload=os.environ.get("ENVIRONMENT", "development") == "development",
    )
