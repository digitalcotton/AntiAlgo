"""
Database Service Layer

Provides async database operations for the API.
Abstracts Supabase/SQLAlchemy operations from route handlers.
"""

import os
import logging
from typing import Optional, List, Dict, Any
from datetime import datetime
from contextlib import asynccontextmanager

try:
    from supabase import create_client, Client
except ImportError:
    create_client = None
    Client = None

from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy import select, func, and_, or_, desc

# Use standard logging as fallback
try:
    from ...infra.observability import logger
except ImportError:
    import structlog
    logger = structlog.get_logger(__name__)


# =============================================================================
# DATABASE CONNECTION
# =============================================================================

class DatabaseService:
    """
    Async database service for Curiosity Intelligence.
    
    Supports both Supabase client (for RLS) and direct SQLAlchemy (for admin ops).
    """
    
    _instance: Optional['DatabaseService'] = None
    
    def __init__(self):
        self._supabase: Any = None
        self._engine = None
        self._session_factory = None
        self._initialized = False
    
    @classmethod
    def get_instance(cls) -> 'DatabaseService':
        """Get singleton instance."""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance
    
    async def initialize(self):
        """Initialize database connections."""
        if self._initialized:
            return
        
        # Supabase client
        supabase_url = os.environ.get('SUPABASE_URL')
        supabase_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY') or os.environ.get('SUPABASE_KEY')
        
        if supabase_url and supabase_key:
            self._supabase = create_client(supabase_url, supabase_key)
            logger.info("supabase_connected", url=supabase_url[:30] + "...")
        
        # SQLAlchemy async engine (optional, for complex queries)
        database_url = os.environ.get('DATABASE_URL')
        if database_url:
            # Convert postgres:// to postgresql+asyncpg://
            if database_url.startswith('postgres://'):
                database_url = database_url.replace('postgres://', 'postgresql+asyncpg://', 1)
            elif database_url.startswith('postgresql://'):
                database_url = database_url.replace('postgresql://', 'postgresql+asyncpg://', 1)
            
            self._engine = create_async_engine(
                database_url,
                echo=os.environ.get('LOG_LEVEL') == 'DEBUG',
                pool_size=5,
                max_overflow=10,
            )
            self._session_factory = async_sessionmaker(
                self._engine,
                class_=AsyncSession,
                expire_on_commit=False,
            )
            logger.info("sqlalchemy_connected")
        
        self._initialized = True
    
    @asynccontextmanager
    async def session(self):
        """Get an async session context."""
        if not self._session_factory:
            raise RuntimeError("Database not initialized. Call initialize() first.")
        
        async with self._session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise
    
    async def health_check(self) -> Dict[str, Any]:
        """Check database connectivity."""
        result = {"connected": False, "latency_ms": None}
        
        if self._supabase:
            try:
                start = datetime.utcnow()
                # Simple query to check connection
                self._supabase.table('tenants').select('id').limit(1).execute()
                latency = (datetime.utcnow() - start).total_seconds() * 1000
                result = {"connected": True, "latency_ms": round(latency, 2)}
            except Exception as e:
                logger.error("db_health_check_failed", error=str(e))
                result = {"connected": False, "error": str(e)}
        
        return result
    
    # =========================================================================
    # TENANT OPERATIONS
    # =========================================================================
    
    async def get_tenant_by_id(self, tenant_id: int) -> Optional[Dict]:
        """Get tenant by ID."""
        if not self._supabase:
            return None
        
        result = self._supabase.table('tenants').select('*').eq('id', tenant_id).single().execute()
        return result.data if result.data else None
    
    async def get_tenant_by_external_id(self, external_id: str) -> Optional[Dict]:
        """Get tenant by external ID (Supabase Auth user ID)."""
        if not self._supabase:
            return None
        
        result = self._supabase.table('tenants').select('*').eq('external_id', external_id).single().execute()
        return result.data if result.data else None
    
    # =========================================================================
    # API KEY OPERATIONS
    # =========================================================================
    
    async def get_api_key_by_hash(self, key_hash: str) -> Optional[Dict]:
        """Get API key by hash."""
        if not self._supabase:
            return None
        
        result = self._supabase.table('api_keys').select(
            '*, tenants(*)'
        ).eq('key_hash', key_hash).eq('is_active', True).single().execute()
        
        return result.data if result.data else None
    
    async def update_api_key_last_used(self, key_id: int):
        """Update API key last_used_at timestamp."""
        if not self._supabase:
            return
        
        self._supabase.table('api_keys').update({
            'last_used_at': datetime.utcnow().isoformat()
        }).eq('id', key_id).execute()
    
    async def list_api_keys(self, tenant_id: int) -> List[Dict]:
        """List all API keys for a tenant."""
        if not self._supabase:
            return []
        
        result = self._supabase.table('api_keys').select(
            'id, name, scopes, created_at, last_used_at, expires_at'
        ).eq('tenant_id', tenant_id).eq('is_active', True).order('created_at', desc=True).execute()
        
        return result.data or []
    
    async def create_api_key(
        self, 
        tenant_id: int, 
        key_hash: str, 
        name: str, 
        scopes: List[str]
    ) -> Dict:
        """Create a new API key."""
        if not self._supabase:
            raise RuntimeError("Database not available")
        
        result = self._supabase.table('api_keys').insert({
            'tenant_id': tenant_id,
            'key_hash': key_hash,
            'name': name,
            'scopes': scopes,
            'is_active': True,
        }).execute()
        
        return result.data[0] if result.data else {}
    
    async def revoke_api_key(self, tenant_id: int, key_id: int) -> bool:
        """Revoke (soft delete) an API key."""
        if not self._supabase:
            return False
        
        result = self._supabase.table('api_keys').update({
            'is_active': False
        }).eq('id', key_id).eq('tenant_id', tenant_id).execute()
        
        return len(result.data) > 0 if result.data else False
    
    # =========================================================================
    # RUN OPERATIONS
    # =========================================================================
    
    async def list_runs(
        self,
        tenant_id: int,
        limit: int = 20,
        offset: int = 0,
        status: Optional[str] = None,
        week: Optional[str] = None,
    ) -> List[Dict]:
        """List runs for a tenant."""
        if not self._supabase:
            return []
        
        query = self._supabase.table('runs').select('*').eq('tenant_id', tenant_id)
        
        if status:
            query = query.eq('status', status)
        if week:
            query = query.eq('week', week)
        
        result = query.order('started_at', desc=True).range(offset, offset + limit - 1).execute()
        return result.data or []
    
    async def get_run(self, tenant_id: int, run_id: int) -> Optional[Dict]:
        """Get a specific run."""
        if not self._supabase:
            return None
        
        result = self._supabase.table('runs').select('*').eq(
            'id', run_id
        ).eq('tenant_id', tenant_id).single().execute()
        
        return result.data if result.data else None
    
    async def create_run(
        self, 
        tenant_id: int, 
        week: Optional[str] = None,
        dry_run: bool = False,
    ) -> Dict:
        """Create a new run."""
        if not self._supabase:
            raise RuntimeError("Database not available")
        
        # Default to current week if not specified
        if not week:
            from datetime import date
            today = date.today()
            week = f"{today.year}-W{today.isocalendar()[1]:02d}"
        
        result = self._supabase.table('runs').insert({
            'tenant_id': tenant_id,
            'week': week,
            'status': 'queued',
            'started_at': datetime.utcnow().isoformat(),
            'dry_run': dry_run,
        }).execute()
        
        return result.data[0] if result.data else {}
    
    async def delete_run(self, tenant_id: int, run_id: int) -> bool:
        """Delete a run and its associated data."""
        if not self._supabase:
            return False
        
        # First verify ownership
        run = await self.get_run(tenant_id=tenant_id, run_id=run_id)
        if not run:
            return False
        
        # Delete associated signals first (cascade)
        self._supabase.table('signals').delete().eq('run_id', run_id).execute()
        
        # Delete the run
        result = self._supabase.table('runs').delete().eq('id', run_id).eq('tenant_id', tenant_id).execute()
        return len(result.data) > 0 if result.data else False
    
    async def get_run_digest(self, tenant_id: int, run_id: int) -> Dict:
        """Get the generated digest for a run."""
        if not self._supabase:
            return {}
        
        # Get signals for this run
        signals = await self.list_signals(
            tenant_id=tenant_id,
            page=1,
            per_page=50,
        )
        
        # Get weird picks (low score but high velocity signals)
        result = self._supabase.table('signals').select(
            '*, runs!inner(week, tenant_id)'
        ).eq('run_id', run_id).eq('runs.tenant_id', tenant_id).order(
            'velocity_pct', desc=True
        ).limit(3).execute()
        
        weird_picks = result.data or []
        
        # Generate markdown content
        markdown_lines = [
            "# Weekly Curiosity Digest",
            "",
            "## Top Signals",
            "",
        ]
        
        for signal in signals.get("signals", [])[:10]:
            markdown_lines.append(f"- **{signal.get('canonical_question', 'N/A')}** (Score: {signal.get('final_score', 0):.2f})")
        
        markdown_lines.extend([
            "",
            "## Weird Picks",
            "",
        ])
        
        for pick in weird_picks:
            markdown_lines.append(f"- {pick.get('canonical_question', 'N/A')}")
        
        return {
            "signals": signals.get("signals", []),
            "weird_picks": weird_picks,
            "markdown_content": "\n".join(markdown_lines),
        }
    
    async def update_run(self, run_id: int, updates: Dict) -> Dict:
        """Update a run."""
        if not self._supabase:
            raise RuntimeError("Database not available")
        
        result = self._supabase.table('runs').update(updates).eq('id', run_id).execute()
        return result.data[0] if result.data else {}
    
    # =========================================================================
    # SIGNAL OPERATIONS
    # =========================================================================
    
    async def list_signals(
        self,
        tenant_id: int,
        page: int = 1,
        per_page: int = 20,
        tier: Optional[str] = None,
        week: Optional[str] = None,
        min_score: Optional[float] = None,
        search: Optional[str] = None,
        run_id: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> Dict:
        """List signals with filtering and pagination."""
        if not self._supabase:
            return {"signals": [], "total": 0, "page": page, "per_page": per_page}
        
        # Use limit if provided (for run-specific queries), else use per_page
        actual_limit = limit if limit is not None else per_page
        offset = (page - 1) * actual_limit
        
        query = self._supabase.table('signals').select(
            '*, runs!inner(week, tenant_id)', count='exact'
        ).eq('runs.tenant_id', tenant_id)
        
        if run_id:
            query = query.eq('run_id', run_id)
        
        if tier:
            query = query.eq('tier', tier)
        if week:
            query = query.eq('runs.week', week)
        if min_score:
            query = query.gte('final_score', min_score)
        if search:
            query = query.ilike('canonical_question', f'%{search}%')
        
        result = query.order('final_score', desc=True).range(offset, offset + per_page - 1).execute()
        
        # Transform signals to include required fields
        signals = []
        for s in (result.data or []):
            # Extract week from joined runs data
            week = s.get('runs', {}).get('week', '') if isinstance(s.get('runs'), dict) else ''
            
            signals.append({
                **s,
                'week': week,
                'platforms': ['stackexchange'],  # Default for now
                'sample_questions': [],  # TODO: Fetch from questions table
            })
        
        return {
            "signals": signals,
            "total": result.count or 0,
            "page": page,
            "per_page": per_page,
        }
    
    async def get_signal(self, tenant_id: int, signal_id: int) -> Optional[Dict]:
        """Get a specific signal."""
        if not self._supabase:
            return None
        
        result = self._supabase.table('signals').select(
            '*, runs!inner(week, tenant_id)'
        ).eq('id', signal_id).eq('runs.tenant_id', tenant_id).single().execute()
        
        return result.data if result.data else None
    
    async def get_trending_signals(self, tenant_id: int, limit: int = 10) -> List[Dict]:
        """Get trending signals by velocity."""
        if not self._supabase:
            return []
        
        result = self._supabase.table('signals').select(
            '*, runs!inner(week, tenant_id)'
        ).eq('runs.tenant_id', tenant_id).order(
            'velocity_pct', desc=True
        ).limit(limit).execute()
        
        return result.data or []
    
    async def get_signal_questions(self, signal_id: int, limit: int = 50) -> List[Dict]:
        """Get questions that contributed to a signal."""
        if not self._supabase:
            return []
        
        result = self._supabase.table('questions').select(
            'id, platform, raw_text, source_url, upvotes, comments, created_at'
        ).eq('signal_id', signal_id).limit(limit).execute()
        
        return result.data or []
    
    async def get_similar_signals(self, signal_id: int, limit: int = 5) -> List[Dict]:
        """Find signals similar to this one using embedding similarity."""
        if not self._supabase:
            return []
        
        # Get the signal's embedding
        signal = self._supabase.table('signals').select('embedding').eq('id', signal_id).single().execute()
        if not signal.data or not signal.data.get('embedding'):
            return []
        
        # Use pgvector similarity search
        result = self._supabase.rpc(
            'match_similar_signals',
            {
                'query_embedding': signal.data['embedding'],
                'match_threshold': 0.7,
                'match_count': limit,
                'exclude_id': signal_id,
            }
        ).execute()
        
        return result.data or []
    
    # =========================================================================
    # EXPERIMENT OPERATIONS
    # =========================================================================
    
    async def get_experiment_assignment(
        self, 
        tenant_id: int, 
        experiment_name: str
    ) -> Optional[Dict]:
        """Get experiment assignment for a tenant."""
        if not self._supabase:
            return None
        
        result = self._supabase.table('experiment_assignments').select('*').eq(
            'tenant_id', tenant_id
        ).eq('experiment_name', experiment_name).single().execute()
        
        return result.data if result.data else None
    
    async def set_experiment_assignment(
        self,
        tenant_id: int,
        experiment_name: str,
        variant_name: str,
    ) -> Dict:
        """Set or update experiment assignment."""
        if not self._supabase:
            raise RuntimeError("Database not available")
        
        # Upsert
        result = self._supabase.table('experiment_assignments').upsert({
            'tenant_id': tenant_id,
            'experiment_name': experiment_name,
            'variant_name': variant_name,
            'assigned_at': datetime.utcnow().isoformat(),
        }, on_conflict='tenant_id,experiment_name').execute()
        
        return result.data[0] if result.data else {}
    
    async def track_experiment_event(
        self,
        tenant_id: int,
        experiment_name: str,
        variant_name: str,
        event_name: str,
        value: Optional[float] = None,
        extra_data: Optional[Dict] = None,
    ):
        """Track an experiment event."""
        if not self._supabase:
            return
        
        self._supabase.table('experiment_events').insert({
            'tenant_id': tenant_id,
            'experiment_name': experiment_name,
            'variant_name': variant_name,
            'event_name': event_name,
            'value': value,
            'extra_data': extra_data or {},
        }).execute()
    
    # =========================================================================
    # USAGE OPERATIONS
    # =========================================================================
    
    async def get_usage(self, tenant_id: int) -> Dict:
        """Get usage statistics for a tenant."""
        if not self._supabase:
            return {}
        
        # Get run count this week
        from datetime import timedelta
        week_start = datetime.utcnow() - timedelta(days=datetime.utcnow().weekday())
        
        runs_result = self._supabase.table('runs').select(
            'id', count='exact'
        ).eq('tenant_id', tenant_id).gte(
            'started_at', week_start.isoformat()
        ).execute()
        
        # Get total questions and signals
        totals_result = self._supabase.rpc('get_tenant_usage', {'p_tenant_id': tenant_id}).execute()
        
        tenant = await self.get_tenant_by_id(tenant_id)
        
        return {
            "runs": {
                "used": runs_result.count or 0,
                "limit": tenant.get('max_runs_per_week', 10) if tenant else 10,
            },
            "questions_ingested": totals_result.data.get('questions', 0) if totals_result.data else 0,
            "signals_detected": totals_result.data.get('signals', 0) if totals_result.data else 0,
            "api_requests": {
                "used": 0,  # Would track via Redis
                "limit": 10000,
            },
        }


# Singleton instance
db = DatabaseService.get_instance()


async def get_db() -> DatabaseService:
    """Dependency to get database service."""
    if not db._initialized:
        await db.initialize()
    return db
