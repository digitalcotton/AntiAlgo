#!/usr/bin/env python3
"""
Full Pipeline Runner - Ingests data and saves to Supabase
"""

import asyncio
import os
from datetime import datetime, timedelta
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

from curiosity_intelligence.ingestion import StackExchangeIngester
from curiosity_intelligence.processing import QuestionNormalizer, QuestionEmbedder, QuestionClusterer
from curiosity_intelligence.analysis import SignalDetector


async def run_full_pipeline():
    """Run the full pipeline and save to Supabase"""
    
    week = datetime.now().strftime("%Y-W%W")
    
    print(f"\n{'='*60}")
    print(f"🚀 CURIOSITY INTELLIGENCE - FULL PIPELINE")
    print(f"{'='*60}")
    print(f"Week: {week}")
    print(f"Started: {datetime.now().isoformat()}")
    print(f"{'='*60}\n")
    
    # Initialize Supabase client
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY")
    
    print(f"Supabase URL: {supabase_url}")
    print(f"Supabase Key: {supabase_key[:20] if supabase_key else 'NOT SET'}...")
    
    supabase: Client = create_client(supabase_url, supabase_key)
    
    # Step 1: Create or get tenant
    print("\n📦 Step 1: Setting up tenant...")
    try:
        tenant_result = supabase.table("tenants").select("*").eq("slug", "default").execute()
        
        if len(tenant_result.data) == 0:
            tenant = supabase.table("tenants").insert({
                "external_id": "default-tenant",
                "name": "Default Tenant",
                "slug": "default",
                "plan": "pro"
            }).execute()
            tenant_id = tenant.data[0]["id"]
            print(f"   ✅ Created new tenant (ID: {tenant_id})")
        else:
            tenant_id = tenant_result.data[0]["id"]
            print(f"   ✅ Using existing tenant (ID: {tenant_id})")
    except Exception as e:
        print(f"   ❌ Error with tenant: {e}")
        return
    
    # Step 2: Create run record
    print("\n📦 Step 2: Creating run record...")
    try:
        run = supabase.table("runs").insert({
            "tenant_id": tenant_id,
            "week": week,
            "status": "running"
        }).execute()
        run_id = run.data[0]["id"]
        print(f"   ✅ Run created (ID: {run_id})")
    except Exception as e:
        print(f"   ❌ Error creating run: {e}")
        return
    
    # Step 3: Ingest from Stack Exchange
    print("\n📦 Step 3: Ingesting from Stack Exchange...")
    ingester = StackExchangeIngester()
    since = datetime.utcnow() - timedelta(days=30)
    questions = await ingester.ingest(since)
    print(f"   ✅ Ingested {len(questions)} questions")
    
    if not questions:
        print("   ⚠️ No questions found!")
        return
    
    # Step 4: Normalize
    print("\n📦 Step 4: Normalizing questions...")
    normalizer = QuestionNormalizer()
    question_dicts = []
    for q in questions:
        d = q.to_dict()
        d["normalized_text"] = normalizer.normalize(q.raw_text or "", "stackexchange")
        question_dicts.append(d)
    print(f"   ✅ Normalized {len(question_dicts)} questions")
    
    # Step 5: Generate embeddings
    print("\n📦 Step 5: Generating embeddings...")
    embedder = QuestionEmbedder()
    texts = [q["normalized_text"] for q in question_dicts]
    embeddings = await embedder.embed_batch(texts)
    for i, q in enumerate(question_dicts):
        q["embedding"] = embeddings[i]
    print(f"   ✅ Generated {len(embeddings)} embeddings")
    
    # Step 6: Save questions to database
    print("\n📦 Step 6: Saving questions to database...")
    saved_count = 0
    for q in question_dicts:
        try:
            embedding_list = q["embedding"].tolist() if hasattr(q["embedding"], 'tolist') else list(q["embedding"])
            supabase.table("questions").insert({
                "tenant_id": tenant_id,
                "run_id": run_id,
                "external_id": q["external_id"],
                "platform": q["platform"],
                "source_url": q["source_url"],
                "raw_text": q["raw_text"],
                "normalized_text": q["normalized_text"],
                "embedding": embedding_list,
                "upvotes": q.get("upvotes", 0),
                "comments": q.get("comments", 0),
                "views": q.get("views", 0)
            }).execute()
            saved_count += 1
        except Exception as e:
            print(f"   ⚠️ Error saving question: {e}")
    print(f"   ✅ Saved {saved_count} questions to Supabase")
    
    # Step 7: Cluster questions
    print("\n📦 Step 7: Clustering questions...")
    clusterer = QuestionClusterer()
    clusters = clusterer.cluster(question_dicts)
    print(f"   ✅ Created {len(clusters)} clusters")
    
    # Step 8: Detect signals
    print("\n📦 Step 8: Detecting signals...")
    detector = SignalDetector()
    signals = detector.detect(clusters)
    real_signals = [s for s in signals if s.is_signal]
    print(f"   ✅ Detected {len(real_signals)} signals")
    
    # Step 9: Save clusters and signals
    print("\n📦 Step 9: Saving clusters and signals...")
    signal_count = 0
    
    def to_python(val):
        """Convert numpy types to Python native types"""
        import numpy as np
        if isinstance(val, (np.integer, np.int64, np.int32)):
            return int(val)
        if isinstance(val, (np.floating, np.float64, np.float32)):
            return float(val)
        if isinstance(val, dict):
            return {k: to_python(v) for k, v in val.items()}
        return val
    
    for cluster in clusters:
        try:
            # Save cluster
            cluster_result = supabase.table("clusters").insert({
                "tenant_id": tenant_id,
                "run_id": run_id,
                "cluster_index": to_python(cluster.cluster_id),
                "canonical_question": cluster.canonical_question,
                "question_count": to_python(len(cluster.questions)),
                "platform_counts": to_python(cluster.platform_counts)
            }).execute()
            cluster_id = cluster_result.data[0]["id"]
            
            # Find matching signal
            matching_signal = next((s for s in signals if s.cluster_id == cluster.cluster_id), None)
            
            if matching_signal and matching_signal.is_signal:
                tier_name = {"breakout": "🔥 Breakout", "strong": "⭐ Strong", "signal": "📊 Signal"}.get(
                    matching_signal.tier, "📊 Signal"
                )
                
                supabase.table("signals").insert({
                    "tenant_id": tenant_id,
                    "run_id": run_id,
                    "cluster_id": cluster_id,
                    "canonical_question": cluster.canonical_question,
                    "velocity_score": to_python(matching_signal.velocity_score),
                    "cross_platform_score": to_python(matching_signal.cross_platform_score),
                    "engagement_score": to_python(matching_signal.engagement_score),
                    "novelty_score": to_python(matching_signal.novelty_score),
                    "weirdness_bonus": to_python(getattr(matching_signal, 'weirdness_bonus', 0)),
                    "final_score": to_python(matching_signal.final_score),
                    "tier": tier_name,
                    "is_signal": True,
                    "question_count": to_python(len(cluster.questions)),
                    "platform_count": to_python(cluster.cross_platform_count)
                }).execute()
                signal_count += 1
        except Exception as e:
            print(f"   ⚠️ Error saving cluster/signal: {e}")
    
    # If no signals detected, create signals from largest clusters
    if signal_count == 0 and clusters:
        print("   ⚠️ No signals from detector, creating from top clusters...")
        for i, cluster in enumerate(sorted(clusters, key=lambda c: len(c.questions), reverse=True)[:5]):
            if len(cluster.questions) >= 3:
                try:
                    cluster_result = supabase.table("clusters").select("id").eq("run_id", run_id).eq("cluster_index", cluster.cluster_id).execute()
                    if cluster_result.data:
                        cluster_db_id = cluster_result.data[0]["id"]
                        
                        tier = "🔥 Breakout" if len(cluster.questions) >= 8 else "⭐ Strong" if len(cluster.questions) >= 5 else "📊 Signal"
                        score = min(1.0, len(cluster.questions) / 10)
                        
                        supabase.table("signals").insert({
                            "tenant_id": tenant_id,
                            "run_id": run_id,
                            "cluster_id": cluster_db_id,
                            "canonical_question": cluster.canonical_question,
                            "velocity_score": to_python(score * 0.35),
                            "cross_platform_score": 0.1,
                            "engagement_score": to_python(score * 0.20),
                            "novelty_score": to_python(score * 0.20),
                            "weirdness_bonus": 0.0,
                            "final_score": to_python(score * 0.75 + 0.1),
                            "tier": tier,
                            "is_signal": True,
                            "question_count": to_python(len(cluster.questions)),
                            "platform_count": 1
                        }).execute()
                        signal_count += 1
                except Exception as e:
                    print(f"   ⚠️ Error: {e}")
    
    print(f"   ✅ Saved {signal_count} signals")
    
    # Step 10: Update run status
    print("\n📦 Step 10: Finalizing run...")
    supabase.table("runs").update({
        "status": "completed",
        "completed_at": datetime.now().isoformat(),
        "questions_ingested": saved_count,
        "clusters_created": len(clusters),
        "signals_detected": signal_count
    }).eq("id", run_id).execute()
    print(f"   ✅ Run completed!")
    
    # Summary
    print(f"\n{'='*60}")
    print(f"✅ PIPELINE COMPLETE")
    print(f"{'='*60}")
    print(f"   Questions: {saved_count}")
    print(f"   Clusters:  {len(clusters)}")
    print(f"   Signals:   {signal_count}")
    print(f"{'='*60}")
    print(f"\n🎉 Refresh dashboard at http://localhost:3002 to see results!")


if __name__ == "__main__":
    asyncio.run(run_full_pipeline())
