# Semantic Matching Specification

## Overview

The Triangulation Engine detects when the **same curiosity** appears across multiple platforms simultaneously. This cross-platform signal is our core differentiation - it transforms commodity data into proprietary intelligence.

## How It Works

### 1. Embedding Generation

```
Question → Normalize → OpenAI Embedding → 1536-dim vector
```

- **Model**: `text-embedding-3-small`
- **Dimensions**: 1536
- **Cost**: $0.02 per 1M tokens (~$0.00001 per question)

### 2. Similarity Calculation

Two questions are considered "the same" if their cosine similarity exceeds **0.85**.

```python
similarity = dot(embedding_a, embedding_b) / (norm(a) * norm(b))

if similarity >= 0.85:
    # Same question, different phrasing
```

### 3. Why 0.85?

| Threshold | Behavior |
|-----------|----------|
| 0.95+ | Too strict - misses paraphrases |
| 0.90 | Catches most duplicates |
| **0.85** | **Optimal - catches semantic equivalence** |
| 0.80 | May include loosely related questions |
| 0.75 | Too loose - false positives |

Empirically tuned on AI questions dataset.

### 4. Cross-Platform Detection

```
                    ┌─────────────┐
Reddit:             │  How do I   │
"How do I use       │   use the   │ ──→ Cluster 1
GPT-4 Vision?"      │  GPT-4V API │
                    └─────────────┘
                           ↑
                    similarity = 0.91
                           ↓
                    ┌─────────────┐
Stack Exchange:     │  How do I   │
"How to call        │   use the   │ ──→ Same Cluster!
GPT-4V API?"        │  GPT-4V API │
                    └─────────────┘
```

When the same question appears on 2+ platforms within the same week:
- **Cross-platform score**: 0.7 (2 platforms) or 1.0 (3+ platforms)
- **Signal boost**: +25% weight to final score

## Clustering Algorithm

### HDBSCAN (Hierarchical Density-Based Spatial Clustering)

Why HDBSCAN over k-means:
1. **No k required** - automatically finds cluster count
2. **Noise handling** - outliers marked as noise (-1), not forced into clusters
3. **Variable density** - handles clusters of different sizes
4. **Hierarchical** - can zoom into sub-clusters if needed

```python
clusterer = HDBSCAN(
    min_cluster_size=3,      # Minimum questions to form cluster
    min_samples=2,           # Core sample density
    metric='euclidean',      # Works well with normalized embeddings
    cluster_selection_method='leaf',  # More granular clusters
)
```

### Output

Each cluster gets:
- **Canonical question**: Question closest to centroid (most representative)
- **Centroid**: Average embedding of all questions
- **Platform counts**: `{"reddit": 5, "stackexchange": 3}`
- **Engagement total**: Sum of upvotes + comments across all questions

## Implementation

```python
from curiosity_intelligence.processing import (
    QuestionNormalizer,
    QuestionEmbedder,
    QuestionClusterer,
)

# Normalize
normalizer = QuestionNormalizer()
normalized = normalizer.normalize("How do I use GPT-4 Vision???", platform="reddit")
# → "How do I use GPT-4 Vision?"

# Embed
embedder = QuestionEmbedder()
embedding = await embedder.embed(normalized)
# → [0.023, -0.041, 0.087, ...] (1536 dims)

# Cluster
clusterer = QuestionClusterer(similarity_threshold=0.85)
clusters = clusterer.cluster(questions_with_embeddings)
# → [QuestionCluster(canonical="How do I use GPT-4 Vision?", platforms=["reddit", "stackexchange"])]
```

## Edge Cases

| Case | Handling |
|------|----------|
| Question too short | Skip if < 15 chars |
| Non-English | Embedding handles, but normalize to English preferred |
| Code-heavy questions | Normalize strips code blocks, keeps intent |
| Duplicate from same user | Dedupe by external_id before clustering |
| Question with no embedding | Skip (API error handling) |

## Performance

| Metric | Value |
|--------|-------|
| Embedding latency | ~100ms per 100 questions (batched) |
| Clustering time | ~1s for 1000 questions |
| Memory | ~6MB per 1000 embeddings |
| API cost | ~$0.02 per 2000 questions |
