#!/usr/bin/env python3
"""
Quick ingestion script - runs Stack Exchange only (Reddit pending approval)
"""

import asyncio
import os
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv()

from curiosity_intelligence.ingestion import StackExchangeIngester
from curiosity_intelligence.processing import QuestionNormalizer, QuestionEmbedder, QuestionClusterer
from curiosity_intelligence.analysis import SignalDetector


async def run():
    print("🧠 Running Stack Exchange Only Pipeline")
    print("=" * 60)
    
    # Step 1: Ingest from Stack Exchange with 30-day lookback
    ingester = StackExchangeIngester()
    since = datetime.utcnow() - timedelta(days=30)
    print(f"Fetching questions since {since.date()}...")
    
    questions = await ingester.ingest(since)
    print(f"✓ Ingested {len(questions)} questions")
    
    if not questions:
        print("No questions found!")
        return
    
    # Step 2: Normalize - convert to dicts for downstream processing
    normalizer = QuestionNormalizer()
    question_dicts = []
    for q in questions:
        d = q.to_dict()
        d["normalized_text"] = normalizer.normalize(q.raw_text or "", "stackexchange")
        question_dicts.append(d)
    print(f"✓ Normalized {len(question_dicts)} questions")
    
    # Step 3: Embed
    embedder = QuestionEmbedder()
    texts = [q["normalized_text"] for q in question_dicts]
    print("Generating embeddings...")
    embeddings = await embedder.embed_batch(texts)
    for i, q in enumerate(question_dicts):
        q["embedding"] = embeddings[i]
    print(f"✓ Generated {len(embeddings)} embeddings")
    
    # Step 4: Cluster
    clusterer = QuestionClusterer()
    clusters = clusterer.cluster(question_dicts)
    print(f"✓ Created {len(clusters)} clusters")
    
    # Step 5: Detect signals
    detector = SignalDetector()
    signals = detector.detect(clusters)
    real_signals = [s for s in signals if s.is_signal]
    print(f"✓ Detected {len(real_signals)} signals")
    
    # Print top signals
    print()
    print("=" * 60)
    print("TOP SIGNALS:")
    print("=" * 60)
    for i, signal in enumerate(real_signals[:5], 1):
        tier_emoji = {"breakout": "🔥", "strong": "⭐", "signal": "📊"}.get(signal.tier, "📈")
        q_text = signal.canonical_question[:60] if signal.canonical_question else "Unknown"
        print(f"{i}. {tier_emoji} {q_text}...")
        print(f"   Velocity: {signal.velocity_pct:+.0f}% | Questions: {signal.question_count}")
        print()
    
    if not real_signals:
        print("No significant signals detected (need more data or lower thresholds)")
        print("\nClusters found:")
        for i, cluster in enumerate(clusters[:5], 1):
            print(f"  {i}. {len(cluster.questions)} questions: {cluster.canonical_question[:50]}...")


if __name__ == "__main__":
    asyncio.run(run())
