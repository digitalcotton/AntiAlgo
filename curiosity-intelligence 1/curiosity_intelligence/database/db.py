"""
Database Connection

Manages connection to Supabase/PostgreSQL with pgvector.
"""

import os
from datetime import datetime
from typing import List, Optional

from supabase import create_client, Client
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from .models import Base, Run, Question, Cluster, Signal


class Database:
    """
    Database interface for Curiosity Intelligence.
    
    Uses Supabase for:
    - PostgreSQL database
    - pgvector extension for embeddings
    - Row-level security
    - Real-time subscriptions (future)
    """
    
    def __init__(self):
        """Initialize database connections."""
        self.supabase_url = os.environ.get("SUPABASE_URL")
        self.supabase_key = os.environ.get("SUPABASE_KEY")
        
        # Supabase client for auth and realtime
        if self.supabase_url and self.supabase_key:
            self.supabase: Client = create_client(
                self.supabase_url,
                self.supabase_key,
            )
        else:
            self.supabase = None
        
        # SQLAlchemy for direct PostgreSQL access
        db_url = os.environ.get("DATABASE_URL")
        if db_url:
            self.engine = create_engine(db_url)
            self.Session = sessionmaker(bind=self.engine)
        else:
            self.engine = None
            self.Session = None
    
    def create_tables(self):
        """Create database tables if they don't exist."""
        if self.engine:
            Base.metadata.create_all(self.engine)
    
    async def save_run(
        self,
        results: dict,
        clusters: List,
        signals: List,
    ) -> int:
        """
        Save a complete pipeline run to the database.
        
        Args:
            results: Pipeline results dict
            clusters: List of QuestionCluster objects
            signals: List of CuriositySignal objects
            
        Returns:
            Run ID
        """
        if not self.Session:
            print("Database not configured, skipping save")
            return None
        
        session = self.Session()
        
        try:
            # Create run record
            run = Run(
                week=datetime.fromisoformat(results["week"]).strftime("%Y-W%W"),
                questions_ingested=results["questions_ingested"],
                clusters_created=results["clusters_created"],
                signals_detected=results["signals_detected"],
                status="completed",
                completed_at=datetime.utcnow(),
            )
            session.add(run)
            session.flush()  # Get run.id
            
            # Save clusters
            cluster_map = {}  # cluster_id -> db_id
            for cluster in clusters:
                db_cluster = Cluster(
                    run_id=run.id,
                    cluster_index=cluster.cluster_id,
                    canonical_question=cluster.canonical_question,
                    centroid=cluster.centroid,
                    question_count=len(cluster.questions),
                    cross_platform_count=cluster.cross_platform_count,
                    total_engagement=cluster.total_engagement,
                    platform_counts=cluster.platform_counts,
                    earliest_seen=cluster.earliest_seen,
                    latest_seen=cluster.latest_seen,
                )
                session.add(db_cluster)
                session.flush()
                cluster_map[cluster.cluster_id] = db_cluster.id
                
                # Save questions in cluster
                for q in cluster.questions:
                    db_question = Question(
                        run_id=run.id,
                        cluster_id=db_cluster.id,
                        external_id=q["external_id"],
                        platform=q["platform"],
                        source_url=q.get("source_url"),
                        raw_text=q["raw_text"],
                        normalized_text=q.get("normalized_text"),
                        embedding=q.get("embedding"),
                        upvotes=q.get("upvotes", 0),
                        comments=q.get("comments", 0),
                        views=q.get("views", 0),
                        external_created_at=q.get("external_created_at"),
                        metadata=q.get("metadata"),
                    )
                    session.add(db_question)
            
            # Save signals
            for signal in signals:
                db_signal = Signal(
                    run_id=run.id,
                    cluster_id=cluster_map.get(signal.cluster_id),
                    canonical_question=signal.canonical_question,
                    velocity_score=signal.velocity_score,
                    cross_platform_score=signal.cross_platform_score,
                    engagement_score=signal.engagement_score,
                    novelty_score=signal.novelty_score,
                    weirdness_bonus=signal.weirdness_bonus,
                    final_score=signal.final_score,
                    tier=signal.tier,
                    is_signal=signal.is_signal,
                    velocity_pct=signal.velocity_pct,
                    question_count=signal.question_count,
                    platform_count=signal.platform_count,
                    news_trigger=signal.news_trigger,
                )
                session.add(db_signal)
            
            session.commit()
            return run.id
            
        except Exception as e:
            session.rollback()
            raise e
        finally:
            session.close()
    
    async def get_historical_data(self, weeks_back: int = 1) -> dict:
        """
        Get historical cluster data for velocity calculation.
        
        Args:
            weeks_back: Number of weeks to look back
            
        Returns:
            Dict mapping question keys to counts
        """
        if not self.Session:
            return {}
        
        session = self.Session()
        
        try:
            # Get recent clusters
            clusters = session.query(Cluster).join(Run).filter(
                Run.status == "completed"
            ).order_by(Run.completed_at.desc()).limit(1000).all()
            
            historical = {}
            for cluster in clusters:
                key = cluster.canonical_question[:50].lower().strip()
                historical[key] = cluster.question_count
            
            return historical
            
        finally:
            session.close()
    
    async def get_signals_for_week(self, week: str) -> List[dict]:
        """
        Get all signals for a specific week.
        
        Args:
            week: Week identifier (YYYY-WNN)
            
        Returns:
            List of signal dicts
        """
        if not self.Session:
            return []
        
        session = self.Session()
        
        try:
            signals = session.query(Signal).join(Run).filter(
                Run.week == week,
                Signal.is_signal == True,
            ).order_by(Signal.final_score.desc()).all()
            
            return [
                {
                    "question": s.canonical_question,
                    "score": s.final_score,
                    "tier": s.tier,
                    "velocity_pct": s.velocity_pct,
                    "platforms": s.platform_count,
                    "news_trigger": s.news_trigger,
                }
                for s in signals
            ]
            
        finally:
            session.close()
