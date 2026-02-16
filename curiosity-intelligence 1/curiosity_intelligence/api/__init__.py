"""
Admin API Module

FastAPI-based REST API for managing Curiosity Intelligence:
- Tenant management
- Run history and status
- Signal browsing
- Experiment configuration
"""

from .main import app, create_app
from .auth import get_current_tenant, require_scope

__all__ = [
    "app",
    "create_app",
    "get_current_tenant",
    "require_scope",
]
