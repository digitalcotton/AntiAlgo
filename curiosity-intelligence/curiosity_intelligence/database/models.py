"""
Database Models

SQLAlchemy models for storing questions, clusters, and signals.
Uses pgvector for embedding storage.
Multi-tenant support with tenant_id on all tables.
"""

from datetime import datetime
from typing import List, Optional
from sqlalchemy import (
    Column, Integer, String, Text, Float, Boolean, 
    DateTime, JSON, ForeignKey, Index, UniqueConstraint
)
from sqlalchemy.orm import declarative_base, relationship
from pgvector.sqlalchemy import Vector

Base = declarative_base()


# ============================================
# TENANT MODEL
# ============================================

class Tenant(Base):
    """A tenant (organization/user) in the system."""
    __tablename__ = "tenants"
    
    id = Column(Integer, primary_key=True)
    external_id = Column(String(100), unique=True, nullable=False)  # UUID or auth provider ID
    name = Column(String(200), nullable=False)
    slug = Column(String(100), unique=True, nullable=False)  # URL-friendly name
    
    # Subscription
    plan = Column(String(50), default="free")  # free, pro, enterprise
    plan_expires_at = Column(DateTime)
    
    # Settings
    settings = Column(JSON, default={})  # Tenant-specific config
    
    # Limits
    max_runs_per_week = Column(Integer, default=1)
    max_signals_per_run = Column(Integer, default=10)
    
    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Relationships
    runs = relationship("Run", back_populates="tenant")
    api_keys = relationship("APIKey", back_populates="tenant")
    
    __table_args__ = (
        Index("ix_tenants_external_id", "external_id"),
        Index("ix_tenants_slug", "slug"),
    )


class APIKey(Base):
    """API key for tenant authentication."""
    __tablename__ = "api_keys"
    
    id = Column(Integer, primary_key=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=False)
    
    key_hash = Column(String(100), nullable=False)  # Hashed API key
    name = Column(String(100))  # User-friendly name
    
    # Permissions
    scopes = Column(JSON, default=["read"])  # read, write, admin
    
    # Usage tracking
    last_used_at = Column(DateTime)
    request_count = Column(Integer, default=0)
    
    # Lifecycle
    is_active = Column(Boolean, default=True)
    expires_at = Column(DateTime)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    # Relationships
    tenant = relationship("Tenant", back_populates="api_keys")
    
    __table_args__ = (
        Index("ix_api_keys_key_hash", "key_hash"),
        Index("ix_api_keys_tenant_id", "tenant_id"),
    )


# ============================================
# CORE MODELS (Multi-tenant)
# ============================================

class Run(Base):
    """A single pipeline run."""
    __tablename__ = "runs"
    
    id = Column(Integer, primary_key=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=False)
    
    week = Column(String(10), nullable=False)  # YYYY-WNN
    started_at = Column(DateTime, default=datetime.utcnow)
    completed_at = Column(DateTime)
    
    questions_ingested = Column(Integer, default=0)
    clusters_created = Column(Integer, default=0)
    signals_detected = Column(Integer, default=0)
    
    status = Column(String(20), default="running")  # running, completed, failed
    error_message = Column(Text)
    
    # Experiment assignments for this run
    experiment_assignments = Column(JSON, default={})
    
    # Relationships
    tenant = relationship("Tenant", back_populates="runs")
    questions = relationship("Question", back_populates="run", cascade="all, delete-orphan")
    clusters = relationship("Cluster", back_populates="run", cascade="all, delete-orphan")
    signals = relationship("Signal", back_populates="run", cascade="all, delete-orphan")
    
    __table_args__ = (
        Index("ix_runs_tenant_id", "tenant_id"),
        Index("ix_runs_week", "week"),
        Index("ix_runs_tenant_week", "tenant_id", "week"),
    )


class Question(Base):
    """An ingested question."""
    __tablename__ = "questions"
    
    id = Column(Integer, primary_key=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=False)
    run_id = Column(Integer, ForeignKey("runs.id"), nullable=False)
    
    # Source
    external_id = Column(String(100), nullable=False)
    platform = Column(String(50), nullable=False)
    source_url = Column(Text)
    
    # Content
    raw_text = Column(Text, nullable=False)
    normalized_text = Column(Text)
    embedding = Column(Vector(1536))  # OpenAI text-embedding-3-small
    
    # Engagement
    upvotes = Column(Integer, default=0)
    comments = Column(Integer, default=0)
    views = Column(Integer, default=0)
    
    # Timestamps
    external_created_at = Column(DateTime)
    ingested_at = Column(DateTime, default=datetime.utcnow)
    
    # Extra data
    extra_data = Column(JSON)
    
    # Cluster assignment
    cluster_id = Column(Integer, ForeignKey("clusters.id"))
    
    # Relationships
    run = relationship("Run", back_populates="questions")
    cluster = relationship("Cluster", back_populates="questions")
    
    __table_args__ = (
        Index("ix_questions_tenant_id", "tenant_id"),
        Index("ix_questions_platform", "platform"),
        Index("ix_questions_external_id", "external_id"),
    )


class Cluster(Base):
    """A cluster of similar questions."""
    __tablename__ = "clusters"
    
    id = Column(Integer, primary_key=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=False)
    run_id = Column(Integer, ForeignKey("runs.id"), nullable=False)
    
    # Identification
    cluster_index = Column(Integer)  # HDBSCAN label
    canonical_question = Column(Text, nullable=False)
    centroid = Column(Vector(1536))
    
    # Metrics
    question_count = Column(Integer, default=0)
    cross_platform_count = Column(Integer, default=0)
    total_engagement = Column(Integer, default=0)
    
    # Platforms
    platform_counts = Column(JSON)  # {"reddit": 5, "stackexchange": 3}
    
    # Time range
    earliest_seen = Column(DateTime)
    latest_seen = Column(DateTime)
    
    # Relationships
    run = relationship("Run", back_populates="clusters")
    questions = relationship("Question", back_populates="cluster")
    signal = relationship("Signal", back_populates="cluster", uselist=False)
    
    __table_args__ = (
        Index("ix_clusters_tenant_id", "tenant_id"),
        Index("ix_clusters_run_id", "run_id"),
    )


class Signal(Base):
    """A detected curiosity signal."""
    __tablename__ = "signals"
    
    id = Column(Integer, primary_key=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=False)
    run_id = Column(Integer, ForeignKey("runs.id"), nullable=False)
    cluster_id = Column(Integer, ForeignKey("clusters.id"))
    
    # Identification
    canonical_question = Column(Text, nullable=False)
    
    # Scores
    velocity_score = Column(Float, default=0.0)
    cross_platform_score = Column(Float, default=0.0)
    engagement_score = Column(Float, default=0.0)
    novelty_score = Column(Float, default=0.0)
    weirdness_bonus = Column(Float, default=0.0)
    final_score = Column(Float, default=0.0)
    
    # Classification
    tier = Column(String(20))  # breakout, strong, signal, noise
    is_signal = Column(Boolean, default=False)
    
    # Metrics
    velocity_pct = Column(Float, default=0.0)
    question_count = Column(Integer, default=0)
    platform_count = Column(Integer, default=0)
    
    # News correlation
    news_trigger = Column(JSON)
    
    # Relationships
    run = relationship("Run", back_populates="signals")
    cluster = relationship("Cluster", back_populates="signal")
    
    __table_args__ = (
        Index("ix_signals_tenant_id", "tenant_id"),
        Index("ix_signals_run_id", "run_id"),
        Index("ix_signals_tier", "tier"),
        Index("ix_signals_final_score", "final_score"),
    )


# ============================================
# EXPERIMENT TRACKING
# ============================================

class ExperimentAssignment(Base):
    """Tracks which variant a tenant was assigned for an experiment."""
    __tablename__ = "experiment_assignments"
    
    id = Column(Integer, primary_key=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=False)
    
    experiment_name = Column(String(100), nullable=False)
    variant_name = Column(String(100), nullable=False)
    
    assigned_at = Column(DateTime, default=datetime.utcnow)
    
    __table_args__ = (
        UniqueConstraint("tenant_id", "experiment_name", name="uq_tenant_experiment"),
        Index("ix_experiment_assignments_tenant", "tenant_id"),
    )


class ExperimentEvent(Base):
    """Tracks events for experiment analysis."""
    __tablename__ = "experiment_events"
    
    id = Column(Integer, primary_key=True)
    tenant_id = Column(Integer, ForeignKey("tenants.id"), nullable=False)
    
    experiment_name = Column(String(100), nullable=False)
    variant_name = Column(String(100), nullable=False)
    event_name = Column(String(100), nullable=False)
    
    value = Column(Float)
    extra_data = Column(JSON)
    
    created_at = Column(DateTime, default=datetime.utcnow)
    
    __table_args__ = (
        Index("ix_experiment_events_tenant", "tenant_id"),
        Index("ix_experiment_events_experiment", "experiment_name"),
    )
