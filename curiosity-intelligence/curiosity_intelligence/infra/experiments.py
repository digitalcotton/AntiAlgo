"""
A/B Testing Framework

Provides:
- Feature flag management
- Variant assignment with consistent hashing
- Experiment tracking
- Result analysis
"""

import os
import hashlib
import time
from typing import Optional, Any, List, Dict
from dataclasses import dataclass, field
from enum import Enum


# ============================================
# EXPERIMENT DEFINITIONS
# ============================================

@dataclass
class Variant:
    """A variant in an experiment."""
    name: str
    weight: float = 1.0  # Relative weight for assignment
    config: dict = field(default_factory=dict)


@dataclass
class Experiment:
    """An A/B test experiment."""
    name: str
    description: str
    variants: List[Variant]
    enabled: bool = True
    start_time: Optional[float] = None
    end_time: Optional[float] = None
    
    def is_active(self) -> bool:
        """Check if experiment is currently active."""
        if not self.enabled:
            return False
        now = time.time()
        if self.start_time and now < self.start_time:
            return False
        if self.end_time and now > self.end_time:
            return False
        return True
    
    @property
    def control(self) -> Variant:
        """Get the control variant (first one)."""
        return self.variants[0] if self.variants else None


# Built-in experiments
EXPERIMENTS = {
    # Digest format experiment
    "digest_format": Experiment(
        name="digest_format",
        description="Test different newsletter formats",
        variants=[
            Variant("control", weight=1.0, config={
                "emoji_tiers": True,
                "show_velocity": True,
                "max_signals": 10,
                "show_weird_picks": True,
            }),
            Variant("minimal", weight=1.0, config={
                "emoji_tiers": False,
                "show_velocity": False,
                "max_signals": 5,
                "show_weird_picks": False,
            }),
            Variant("detailed", weight=1.0, config={
                "emoji_tiers": True,
                "show_velocity": True,
                "max_signals": 15,
                "show_weird_picks": True,
                "show_breakdown": True,
                "show_sample_questions": True,
            }),
        ],
    ),
    
    # Signal threshold experiment
    "signal_threshold": Experiment(
        name="signal_threshold",
        description="Test different signal score thresholds",
        variants=[
            Variant("control", weight=2.0, config={"threshold": 0.70}),
            Variant("strict", weight=1.0, config={"threshold": 0.75}),
            Variant("relaxed", weight=1.0, config={"threshold": 0.65}),
        ],
    ),
    
    # Weird picks count
    "weird_picks_count": Experiment(
        name="weird_picks_count",
        description="Test number of weird picks to show",
        variants=[
            Variant("three", weight=1.0, config={"count": 3}),
            Variant("five", weight=1.0, config={"count": 5}),
            Variant("none", weight=1.0, config={"count": 0}),
        ],
    ),
    
    # Velocity weight in signal formula
    "velocity_weight": Experiment(
        name="velocity_weight",
        description="Test velocity importance in signal scoring",
        variants=[
            Variant("control", weight=2.0, config={"weight": 0.35}),
            Variant("high", weight=1.0, config={"weight": 0.45}),
            Variant("low", weight=1.0, config={"weight": 0.25}),
        ],
    ),
}


# ============================================
# EXPERIMENT MANAGER
# ============================================

class ExperimentManager:
    """
    Manages experiment assignment and tracking.
    
    Uses consistent hashing to ensure same user always
    gets same variant for a given experiment.
    """
    
    def __init__(
        self,
        experiments: Dict[str, Experiment] = None,
        db = None,
    ):
        """
        Initialize manager.
        
        Args:
            experiments: Override default experiments
            db: Database for persisting assignments
        """
        self.experiments = experiments or EXPERIMENTS
        self.db = db
        self._assignments: Dict[str, Dict[str, str]] = {}  # user_id -> {exp: variant}
    
    def get_variant(
        self,
        experiment_name: str,
        user_id: str,
    ) -> Optional[Variant]:
        """
        Get assigned variant for a user.
        
        Args:
            experiment_name: Name of the experiment
            user_id: User/tenant identifier
            
        Returns:
            Assigned variant or None if experiment not found
        """
        experiment = self.experiments.get(experiment_name)
        if not experiment or not experiment.is_active():
            return None
        
        # Check cached assignment
        cache_key = f"{user_id}:{experiment_name}"
        if user_id in self._assignments:
            if experiment_name in self._assignments[user_id]:
                variant_name = self._assignments[user_id][experiment_name]
                return self._find_variant(experiment, variant_name)
        
        # Calculate consistent assignment
        variant = self._assign_variant(experiment, user_id)
        
        # Cache it
        if user_id not in self._assignments:
            self._assignments[user_id] = {}
        self._assignments[user_id][experiment_name] = variant.name
        
        return variant
    
    def _assign_variant(
        self,
        experiment: Experiment,
        user_id: str,
    ) -> Variant:
        """
        Assign a variant using consistent hashing.
        
        Uses SHA256 hash of user_id + experiment to get deterministic
        bucket assignment.
        """
        # Calculate hash
        hash_input = f"{user_id}:{experiment.name}"
        hash_bytes = hashlib.sha256(hash_input.encode()).digest()
        hash_value = int.from_bytes(hash_bytes[:4], "big")
        
        # Normalize to 0-1 range
        bucket = (hash_value % 10000) / 10000.0
        
        # Calculate cumulative weights
        total_weight = sum(v.weight for v in experiment.variants)
        cumulative = 0.0
        
        for variant in experiment.variants:
            cumulative += variant.weight / total_weight
            if bucket < cumulative:
                return variant
        
        # Fallback to last variant
        return experiment.variants[-1]
    
    def _find_variant(
        self,
        experiment: Experiment,
        variant_name: str,
    ) -> Optional[Variant]:
        """Find variant by name."""
        for variant in experiment.variants:
            if variant.name == variant_name:
                return variant
        return None
    
    def get_config(
        self,
        experiment_name: str,
        user_id: str,
        key: str,
        default: Any = None,
    ) -> Any:
        """
        Get a config value from assigned variant.
        
        Usage:
            threshold = manager.get_config("signal_threshold", user_id, "threshold", 0.70)
        """
        variant = self.get_variant(experiment_name, user_id)
        if variant:
            return variant.config.get(key, default)
        return default
    
    def track_event(
        self,
        experiment_name: str,
        user_id: str,
        event: str,
        value: Optional[float] = None,
        metadata: Optional[dict] = None,
    ):
        """
        Track an event for experiment analysis.
        
        Args:
            experiment_name: Name of the experiment
            user_id: User identifier
            event: Event name (e.g., "newsletter_opened", "link_clicked")
            value: Optional numeric value
            metadata: Optional additional data
        """
        variant = self.get_variant(experiment_name, user_id)
        if not variant:
            return
        
        # TODO: Persist to database
        event_data = {
            "experiment": experiment_name,
            "variant": variant.name,
            "user_id": user_id,
            "event": event,
            "value": value,
            "metadata": metadata,
            "timestamp": time.time(),
        }
        
        # For now, just log
        from .observability import logger
        logger.info("experiment_event", **event_data)
    
    def get_all_assignments(self, user_id: str) -> Dict[str, str]:
        """Get all experiment assignments for a user."""
        assignments = {}
        for name, experiment in self.experiments.items():
            if experiment.is_active():
                variant = self.get_variant(name, user_id)
                if variant:
                    assignments[name] = variant.name
        return assignments
    
    def override_variant(
        self,
        experiment_name: str,
        user_id: str,
        variant_name: str,
    ):
        """
        Override variant assignment (for testing).
        
        Args:
            experiment_name: Experiment to override
            user_id: User to override for
            variant_name: Variant to assign
        """
        if user_id not in self._assignments:
            self._assignments[user_id] = {}
        self._assignments[user_id][experiment_name] = variant_name


# Global instance
_experiment_manager: Optional[ExperimentManager] = None


def get_experiment_manager() -> ExperimentManager:
    """Get global experiment manager."""
    global _experiment_manager
    if _experiment_manager is None:
        _experiment_manager = ExperimentManager()
    return _experiment_manager


def get_variant(experiment_name: str, user_id: str) -> Optional[Variant]:
    """Convenience function to get variant."""
    return get_experiment_manager().get_variant(experiment_name, user_id)


def get_experiment_config(
    experiment_name: str,
    user_id: str,
    key: str,
    default: Any = None,
) -> Any:
    """Convenience function to get experiment config value."""
    return get_experiment_manager().get_config(experiment_name, user_id, key, default)
