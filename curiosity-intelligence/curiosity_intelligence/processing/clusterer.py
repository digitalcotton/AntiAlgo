"""
Question Clusterer

Groups similar questions using HDBSCAN for density-based clustering.
"""

import numpy as np
from typing import List, Dict, Any
from dataclasses import dataclass, field
from datetime import datetime

import hdbscan


@dataclass
class QuestionCluster:
    """A cluster of semantically similar questions."""
    cluster_id: int
    canonical_question: str  # Most representative question
    questions: List[Dict[str, Any]] = field(default_factory=list)
    centroid: List[float] = None
    platform_counts: Dict[str, int] = field(default_factory=dict)
    total_engagement: int = 0
    earliest_seen: datetime = None
    latest_seen: datetime = None
    
    @property
    def cross_platform_count(self) -> int:
        """Number of platforms this question appears on."""
        return len(self.platform_counts)
    
    @property
    def is_cross_platform(self) -> bool:
        """True if question appears on 2+ platforms."""
        return self.cross_platform_count >= 2
    
    def to_dict(self) -> dict:
        return {
            "cluster_id": self.cluster_id,
            "canonical_question": self.canonical_question,
            "question_count": len(self.questions),
            "platforms": list(self.platform_counts.keys()),
            "cross_platform_count": self.cross_platform_count,
            "total_engagement": self.total_engagement,
            "earliest_seen": self.earliest_seen.isoformat() if self.earliest_seen else None,
            "latest_seen": self.latest_seen.isoformat() if self.latest_seen else None,
        }


class QuestionClusterer:
    """
    Clusters questions by semantic similarity using HDBSCAN.
    
    HDBSCAN advantages:
    - No need to specify number of clusters (k)
    - Handles varying densities
    - Identifies noise points (outliers)
    - Works well with high-dimensional embeddings
    """
    
    def __init__(
        self,
        min_cluster_size: int = 3,
        min_samples: int = 2,
        metric: str = "euclidean",
        similarity_threshold: float = 0.85,
    ):
        """
        Initialize clusterer.
        
        Args:
            min_cluster_size: Minimum questions to form a cluster
            min_samples: Core sample count for density estimation
            metric: Distance metric
            similarity_threshold: Cosine similarity threshold for "same question"
        """
        self.min_cluster_size = min_cluster_size
        self.min_samples = min_samples
        self.metric = metric
        self.similarity_threshold = similarity_threshold
    
    def cluster(self, questions: List[Dict[str, Any]]) -> List[QuestionCluster]:
        """
        Cluster questions by their embeddings.
        
        Args:
            questions: List of question dicts with 'embedding' key
            
        Returns:
            List of QuestionCluster objects
        """
        if not questions or len(questions) < self.min_cluster_size:
            return []
        
        # Extract embeddings
        embeddings = np.array([q["embedding"] for q in questions])
        
        # Run HDBSCAN
        clusterer = hdbscan.HDBSCAN(
            min_cluster_size=self.min_cluster_size,
            min_samples=self.min_samples,
            metric=self.metric,
            cluster_selection_method="leaf",  # More granular clusters
        )
        
        labels = clusterer.fit_predict(embeddings)
        
        # Group questions by cluster
        cluster_map = {}
        for idx, label in enumerate(labels):
            if label == -1:  # Noise point
                continue
            
            if label not in cluster_map:
                cluster_map[label] = []
            cluster_map[label].append(questions[idx])
        
        # Build QuestionCluster objects
        clusters = []
        for label, cluster_questions in cluster_map.items():
            cluster = self._build_cluster(label, cluster_questions, embeddings, labels)
            clusters.append(cluster)
        
        # Sort by engagement
        clusters.sort(key=lambda c: c.total_engagement, reverse=True)
        
        return clusters
    
    def _build_cluster(
        self,
        cluster_id: int,
        questions: List[Dict[str, Any]],
        all_embeddings: np.ndarray,
        labels: np.ndarray,
    ) -> QuestionCluster:
        """
        Build a QuestionCluster from grouped questions.
        """
        # Calculate centroid
        cluster_mask = labels == cluster_id
        cluster_embeddings = all_embeddings[cluster_mask]
        centroid = np.mean(cluster_embeddings, axis=0).tolist()
        
        # Find canonical question (closest to centroid)
        distances = np.linalg.norm(cluster_embeddings - centroid, axis=1)
        canonical_idx = np.argmin(distances)
        canonical = questions[canonical_idx]["normalized_text"]
        
        # Count platforms
        platform_counts = {}
        for q in questions:
            platform = q.get("platform", "unknown")
            platform_counts[platform] = platform_counts.get(platform, 0) + 1
        
        # Calculate total engagement
        total_engagement = sum(
            q.get("upvotes", 0) + q.get("comments", 0)
            for q in questions
        )
        
        # Get time range
        dates = [
            q.get("external_created_at") 
            for q in questions 
            if q.get("external_created_at")
        ]
        earliest = min(dates) if dates else None
        latest = max(dates) if dates else None
        
        return QuestionCluster(
            cluster_id=cluster_id,
            canonical_question=canonical,
            questions=questions,
            centroid=centroid,
            platform_counts=platform_counts,
            total_engagement=total_engagement,
            earliest_seen=earliest,
            latest_seen=latest,
        )
    
    def find_similar(
        self,
        query_embedding: List[float],
        clusters: List[QuestionCluster],
        top_k: int = 5,
    ) -> List[tuple]:
        """
        Find clusters most similar to a query embedding.
        
        Returns:
            List of (cluster, similarity_score) tuples
        """
        query = np.array(query_embedding)
        
        results = []
        for cluster in clusters:
            if cluster.centroid:
                centroid = np.array(cluster.centroid)
                # Cosine similarity
                similarity = np.dot(query, centroid) / (
                    np.linalg.norm(query) * np.linalg.norm(centroid)
                )
                results.append((cluster, float(similarity)))
        
        results.sort(key=lambda x: x[1], reverse=True)
        return results[:top_k]
