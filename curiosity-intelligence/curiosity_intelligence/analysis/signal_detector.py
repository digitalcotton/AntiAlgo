"""
Signal Detector

Scores and classifies curiosity signals using the weighted formula:
- Velocity: 35% (week-over-week growth)
- Cross-Platform: 25% (appears on multiple platforms)
- Engagement: 20% (total upvotes + comments)
- Novelty: 20% (first time seeing this pattern)
- Weirdness Bonus: up to +20% (unexpected patterns)
"""

from typing import List, Optional
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from ..processing.clusterer import QuestionCluster


@dataclass
class CuriositySignal:
    """A scored curiosity signal derived from a cluster."""
    cluster_id: int
    canonical_question: str
    
    # Raw scores (0-1)
    velocity_score: float = 0.0
    cross_platform_score: float = 0.0
    engagement_score: float = 0.0
    novelty_score: float = 0.0
    weirdness_bonus: float = 0.0
    
    # Computed
    final_score: float = 0.0
    tier: str = "noise"  # breakout, strong, signal, noise
    is_signal: bool = False
    
    # Metrics
    question_count: int = 0
    platform_count: int = 0
    total_engagement: int = 0
    velocity_pct: float = 0.0  # % change from last week
    
    # Context
    platforms: List[str] = field(default_factory=list)
    sample_questions: List[str] = field(default_factory=list)
    news_trigger: Optional[dict] = None
    
    def to_dict(self) -> dict:
        return {
            "question": self.canonical_question,
            "score": round(self.final_score, 3),
            "tier": self.tier,
            "is_signal": self.is_signal,
            "velocity_pct": round(self.velocity_pct, 1),
            "platforms": self.platforms,
            "platform_count": self.platform_count,
            "question_count": self.question_count,
            "engagement": self.total_engagement,
            "breakdown": {
                "velocity": round(self.velocity_score, 3),
                "cross_platform": round(self.cross_platform_score, 3),
                "engagement": round(self.engagement_score, 3),
                "novelty": round(self.novelty_score, 3),
                "weirdness": round(self.weirdness_bonus, 3),
            },
            "news_trigger": self.news_trigger,
            "sample_questions": self.sample_questions[:3],
        }


class SignalDetector:
    """
    Detects and scores curiosity signals from question clusters.
    
    Signal Formula:
    score = (velocity * 0.35) + (cross_platform * 0.25) + 
            (engagement * 0.20) + (novelty * 0.20) + weirdness_bonus
    
    Tiers:
    - Breakout: score >= 0.85 (🔥 major trend)
    - Strong: score >= 0.75 (⭐ significant)
    - Signal: score >= 0.70 (📊 notable)
    - Noise: score < 0.70 (below threshold)
    """
    
    # Weight configuration
    WEIGHT_VELOCITY = 0.35
    WEIGHT_CROSS_PLATFORM = 0.25
    WEIGHT_ENGAGEMENT = 0.20
    WEIGHT_NOVELTY = 0.20
    MAX_WEIRDNESS_BONUS = 0.20
    
    # Tier thresholds
    TIER_BREAKOUT = 0.85
    TIER_STRONG = 0.75
    TIER_SIGNAL = 0.70
    
    def __init__(
        self,
        threshold: float = 0.70,
        historical_data: dict = None,
    ):
        """
        Initialize signal detector.
        
        Args:
            threshold: Minimum score to be considered a signal
            historical_data: Previous week's cluster data for velocity calc
        """
        self.threshold = threshold
        self.historical_data = historical_data or {}
        
        # Cache for normalization
        self._max_engagement = 1
        self._max_count = 1
    
    def detect(self, clusters: List[QuestionCluster]) -> List[CuriositySignal]:
        """
        Detect signals from a list of clusters.
        
        Args:
            clusters: List of question clusters
            
        Returns:
            List of CuriositySignal objects, sorted by score
        """
        if not clusters:
            return []
        
        # Calculate normalization factors
        self._max_engagement = max(c.total_engagement for c in clusters) or 1
        self._max_count = max(len(c.questions) for c in clusters) or 1
        
        # Score each cluster
        signals = []
        for cluster in clusters:
            signal = self._score_cluster(cluster)
            signals.append(signal)
        
        # Sort by score
        signals.sort(key=lambda s: s.final_score, reverse=True)
        
        return signals
    
    def _score_cluster(self, cluster: QuestionCluster) -> CuriositySignal:
        """
        Calculate signal score for a cluster.
        """
        signal = CuriositySignal(
            cluster_id=cluster.cluster_id,
            canonical_question=cluster.canonical_question,
            question_count=len(cluster.questions),
            platform_count=cluster.cross_platform_count,
            total_engagement=cluster.total_engagement,
            platforms=list(cluster.platform_counts.keys()),
            sample_questions=[q["raw_text"] for q in cluster.questions[:5]],
        )
        
        # Calculate individual scores
        signal.velocity_score, signal.velocity_pct = self._calc_velocity(cluster)
        signal.cross_platform_score = self._calc_cross_platform(cluster)
        signal.engagement_score = self._calc_engagement(cluster)
        signal.novelty_score = self._calc_novelty(cluster)
        signal.weirdness_bonus = self._calc_weirdness(cluster)
        
        # Calculate weighted final score
        signal.final_score = (
            signal.velocity_score * self.WEIGHT_VELOCITY +
            signal.cross_platform_score * self.WEIGHT_CROSS_PLATFORM +
            signal.engagement_score * self.WEIGHT_ENGAGEMENT +
            signal.novelty_score * self.WEIGHT_NOVELTY +
            signal.weirdness_bonus
        )
        
        # Clamp to 0-1
        signal.final_score = min(1.0, max(0.0, signal.final_score))
        
        # Assign tier
        if signal.final_score >= self.TIER_BREAKOUT:
            signal.tier = "breakout"
        elif signal.final_score >= self.TIER_STRONG:
            signal.tier = "strong"
        elif signal.final_score >= self.TIER_SIGNAL:
            signal.tier = "signal"
        else:
            signal.tier = "noise"
        
        signal.is_signal = signal.final_score >= self.threshold
        
        return signal
    
    def _calc_velocity(self, cluster: QuestionCluster) -> tuple:
        """
        Calculate velocity score (week-over-week growth).
        
        Returns:
            (normalized_score, percentage_change)
        """
        current_count = len(cluster.questions)
        
        # Look up historical count
        historical_key = self._get_cluster_key(cluster)
        historical_count = self.historical_data.get(historical_key, 0)
        
        if historical_count == 0:
            # New cluster - high velocity
            return (0.8, 100.0)
        
        # Calculate percentage change
        pct_change = ((current_count - historical_count) / historical_count) * 100
        
        # Normalize: 100%+ growth = 1.0, 0% = 0.5, -50% = 0.0
        if pct_change >= 100:
            score = 1.0
        elif pct_change >= 0:
            score = 0.5 + (pct_change / 200)
        else:
            score = max(0.0, 0.5 + (pct_change / 100))
        
        return (score, pct_change)
    
    def _calc_cross_platform(self, cluster: QuestionCluster) -> float:
        """
        Calculate cross-platform score.
        
        1 platform: 0.0
        2 platforms: 0.7
        3+ platforms: 1.0
        """
        count = cluster.cross_platform_count
        if count >= 3:
            return 1.0
        elif count == 2:
            return 0.7
        else:
            return 0.0
    
    def _calc_engagement(self, cluster: QuestionCluster) -> float:
        """
        Calculate normalized engagement score.
        """
        if self._max_engagement == 0:
            return 0.0
        return min(1.0, cluster.total_engagement / self._max_engagement)
    
    def _calc_novelty(self, cluster: QuestionCluster) -> float:
        """
        Calculate novelty score (first time seeing this pattern).
        """
        historical_key = self._get_cluster_key(cluster)
        
        if historical_key not in self.historical_data:
            return 1.0  # Completely new
        
        # Seen before - lower novelty
        return 0.3
    
    def _calc_weirdness(self, cluster: QuestionCluster) -> float:
        """
        Calculate weirdness bonus for unexpected patterns.
        
        Weird = high engagement but not from typical sources
        """
        # Check for unexpected platform combinations
        platforms = set(cluster.platform_counts.keys())
        
        # Unusual if Stack Exchange + Reddit + others agree
        if len(platforms) >= 3:
            return self.MAX_WEIRDNESS_BONUS
        
        # Check for disproportionate engagement
        avg_engagement = cluster.total_engagement / len(cluster.questions)
        if avg_engagement > 50:  # High engagement per question
            return self.MAX_WEIRDNESS_BONUS * 0.5
        
        return 0.0
    
    def _get_cluster_key(self, cluster: QuestionCluster) -> str:
        """Generate a key for historical lookup."""
        # Use first 50 chars of canonical question
        return cluster.canonical_question[:50].lower().strip()
    
    def get_weird_picks(
        self, 
        clusters: List[QuestionCluster],
        count: int = 5,
    ) -> List[CuriositySignal]:
        """
        Find clusters that are weird/unexpected.
        
        These are low-volume but interesting patterns.
        """
        weird = []
        
        for cluster in clusters:
            signal = self._score_cluster(cluster)
            
            # Weird picks are below signal threshold but have weirdness
            if signal.weirdness_bonus > 0 and not signal.is_signal:
                weird.append(signal)
        
        weird.sort(key=lambda s: s.weirdness_bonus, reverse=True)
        return weird[:count]
