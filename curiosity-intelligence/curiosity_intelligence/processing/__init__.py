"""
Processing Module

Transforms raw questions into analyzed, clustered signals:
- Normalizer: Clean and standardize question text
- Embedder: Generate vector embeddings via OpenAI
- Clusterer: Group similar questions using HDBSCAN
"""

from .normalizer import QuestionNormalizer
from .embedder import QuestionEmbedder
from .clusterer import QuestionClusterer

__all__ = [
    "QuestionNormalizer",
    "QuestionEmbedder",
    "QuestionClusterer",
]
