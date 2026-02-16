"""
Analysis Module

Transforms clusters into actionable signals:
- SignalDetector: Score and classify curiosity signals
- NewsCorrelator: Find news triggers for spikes
"""

from .signal_detector import SignalDetector, CuriositySignal
from .news_correlator import NewsCorrelator

__all__ = [
    "SignalDetector",
    "CuriositySignal",
    "NewsCorrelator",
]
