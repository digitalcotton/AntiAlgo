#!/usr/bin/env python3
"""
Test script for Curiosity Intelligence Engine

Run with: python -m tests.test_pipeline
"""

import asyncio
from datetime import datetime, timedelta

# Test data - simulated questions
MOCK_QUESTIONS = [
    # Cluster 1: GPT-4 vision
    {"raw_text": "How do I use GPT-4 Vision API?", "platform": "reddit", "upvotes": 150, "comments": 45},
    {"raw_text": "GPT-4V image analysis not working", "platform": "stackexchange", "upvotes": 30, "comments": 8},
    {"raw_text": "What can GPT-4 Vision see in images?", "platform": "reddit", "upvotes": 200, "comments": 60},
    
    # Cluster 2: Claude vs ChatGPT
    {"raw_text": "Is Claude better than ChatGPT for coding?", "platform": "reddit", "upvotes": 500, "comments": 120},
    {"raw_text": "Claude vs GPT-4 for programming tasks", "platform": "stackexchange", "upvotes": 80, "comments": 25},
    {"raw_text": "Which AI is best for code: Claude or ChatGPT?", "platform": "reddit", "upvotes": 300, "comments": 85},
    
    # Cluster 3: Local LLMs
    {"raw_text": "How to run Llama 3 locally on Mac?", "platform": "reddit", "upvotes": 400, "comments": 90},
    {"raw_text": "Best local LLM for coding assistance", "platform": "reddit", "upvotes": 250, "comments": 55},
    {"raw_text": "Ollama vs LM Studio comparison", "platform": "reddit", "upvotes": 180, "comments": 40},
    
    # Noise - single questions
    {"raw_text": "Random unrelated question about AI art", "platform": "reddit", "upvotes": 5, "comments": 2},
]


def test_normalizer():
    """Test question normalization."""
    from curiosity_intelligence.processing import QuestionNormalizer
    
    normalizer = QuestionNormalizer()
    
    test_cases = [
        ("[Discussion] How does GPT-4 work???", "How does GPT-4 work?"),
        ("ELI5 what is a neural network", "explain like I'm 5 what is a neural network?"),
        ("Is **Claude** better than *ChatGPT*?", "Is Claude better than ChatGPT?"),
    ]
    
    print("Testing Normalizer...")
    for raw, expected in test_cases:
        result = normalizer.normalize(raw, platform="reddit")
        status = "✓" if expected.lower() in result.lower() else "✗"
        print(f"  {status} '{raw[:30]}...' -> '{result[:40]}...'")
    
    print()


def test_clusterer():
    """Test question clustering (mock embeddings)."""
    from curiosity_intelligence.processing import QuestionClusterer
    import numpy as np
    
    print("Testing Clusterer...")
    
    # Create mock embeddings (random but grouped)
    np.random.seed(42)
    
    questions = []
    for i, q in enumerate(MOCK_QUESTIONS):
        # Create embedding that clusters similar questions
        if i < 3:  # Cluster 1
            embedding = np.random.randn(1536) * 0.1 + np.array([1.0] + [0.0] * 1535)
        elif i < 6:  # Cluster 2
            embedding = np.random.randn(1536) * 0.1 + np.array([0.0, 1.0] + [0.0] * 1534)
        elif i < 9:  # Cluster 3
            embedding = np.random.randn(1536) * 0.1 + np.array([0.0, 0.0, 1.0] + [0.0] * 1533)
        else:  # Noise
            embedding = np.random.randn(1536)
        
        questions.append({
            **q,
            "normalized_text": q["raw_text"],
            "embedding": embedding.tolist(),
            "external_id": str(i),
            "external_created_at": datetime.utcnow() - timedelta(days=i % 7),
        })
    
    clusterer = QuestionClusterer(min_cluster_size=2)
    clusters = clusterer.cluster(questions)
    
    print(f"  Created {len(clusters)} clusters from {len(questions)} questions")
    for c in clusters:
        print(f"    - Cluster {c.cluster_id}: {len(c.questions)} questions, platforms: {list(c.platform_counts.keys())}")
    
    print()
    return clusters


def test_signal_detector(clusters):
    """Test signal detection."""
    from curiosity_intelligence.analysis import SignalDetector
    
    print("Testing Signal Detector...")
    
    detector = SignalDetector(threshold=0.70)
    signals = detector.detect(clusters)
    
    print(f"  Detected {len([s for s in signals if s.is_signal])} signals from {len(clusters)} clusters")
    
    for s in signals[:5]:
        tier_emoji = {"breakout": "🔥", "strong": "⭐", "signal": "📊"}.get(s.tier, "📉")
        print(f"    {tier_emoji} [{s.tier}] {s.canonical_question[:40]}... (score: {s.final_score:.3f})")
    
    print()
    return signals


def test_digest_generator(signals):
    """Test digest generation."""
    from curiosity_intelligence.output import DigestGenerator
    
    print("Testing Digest Generator...")
    
    generator = DigestGenerator(output_dir="./test_output")
    
    signal_dicts = [s.to_dict() for s in signals if s.is_signal]
    weird_dicts = [s.to_dict() for s in signals if not s.is_signal][:2]
    
    stats = {
        "questions_ingested": len(MOCK_QUESTIONS),
        "platforms": 2,
    }
    
    md = generator.generate_markdown(
        signals=signal_dicts,
        weird_picks=weird_dicts,
        week="2024-W01",
        stats=stats,
    )
    
    print(f"  Generated markdown digest ({len(md)} chars)")
    print("  First 500 chars:")
    print("-" * 40)
    print(md[:500])
    print("-" * 40)
    
    print()


async def test_full_pipeline_mock():
    """Test the full pipeline with mocked data."""
    print("=" * 60)
    print("CURIOSITY INTELLIGENCE - TEST SUITE")
    print("=" * 60)
    print()
    
    # Run individual component tests
    test_normalizer()
    clusters = test_clusterer()
    signals = test_signal_detector(clusters)
    test_digest_generator(signals)
    
    print("=" * 60)
    print("✓ All tests completed!")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(test_full_pipeline_mock())
