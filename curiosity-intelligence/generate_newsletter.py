#!/usr/bin/env python3
"""
Generate Newsletter

Generates an email-ready HTML newsletter from the signals in Supabase.
Embodies the design philosophy of Jobs, Ive, and Wozniak:
- Obsessive simplicity
- Deliberate restraint  
- Engineering excellence
"""

import os
import sys
from datetime import date
from pathlib import Path

# Load env first
from dotenv import load_dotenv
load_dotenv()

# Supabase client
from supabase import create_client

# Add project root to path and import just the newsletter module (not the full pipeline)
sys.path.insert(0, str(Path(__file__).parent))

# Direct import to avoid loading heavy dependencies
from curiosity_intelligence.output.newsletter import NewsletterGenerator


def generate_newsletter_from_db():
    """Generate newsletter from actual database signals."""
    
    load_dotenv()
    
    # Connect to Supabase
    supabase_url = os.environ.get('SUPABASE_URL')
    supabase_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY') or os.environ.get('SUPABASE_KEY')
    
    if not supabase_url or not supabase_key:
        print("❌ Missing Supabase credentials in .env")
        return None
    
    client = create_client(supabase_url, supabase_key)
    
    # Get current week
    today = date.today()
    week = f"{today.year}-W{today.isocalendar()[1]:02d}"
    
    print(f"📰 Generating newsletter for week {week}...")
    
    # Fetch signals ordered by score
    result = client.table('signals').select(
        '*, runs!inner(week)'
    ).order('final_score', desc=True).limit(20).execute()
    
    signals = result.data or []
    print(f"   Found {len(signals)} signals")
    
    if not signals:
        print("⚠️  No signals found. Running sample generator instead...")
        from curiosity_intelligence.output.newsletter import generate_sample_newsletter
        return generate_sample_newsletter()
    
    # Transform signals to expected format
    formatted_signals = []
    for s in signals:
        formatted_signals.append({
            'canonical_question': s.get('canonical_question', 'N/A'),
            'velocity_pct': (s.get('velocity_score', 0) or 0) * 100,
            'tier': s.get('tier', 'signal'),
            'question_count': s.get('question_count', 0),
            'sample_count': s.get('sample_count', 0),
        })
    
    # Get questions count for stats
    questions_result = client.table('questions').select('id', count='exact').execute()
    questions_count = questions_result.count or 0
    
    # Identify weird pick (low score but has questions)
    weird_picks = []
    for s in reversed(signals[-5:]):
        if s.get('question_count', 0) > 2:
            weird_picks.append({
                'canonical_question': s.get('canonical_question', 'N/A'),
                'velocity_pct': (s.get('velocity_score', 0) or 0) * 100,
                'tier': s.get('tier', 'noise'),
            })
            break
    
    # Stats
    stats = {
        'questions_ingested': questions_count,
        'platform_count': 1,  # Just Stack Exchange for now
        'signals_detected': len(signals),
    }
    
    # Prediction based on top signals
    top_question = formatted_signals[0]['canonical_question'] if formatted_signals else ""
    prediction = f"Based on this week's velocity, expect continued interest in local LLMs and agent frameworks. The breakout around '{top_question[:50]}...' suggests developers are actively building with these tools."
    
    # Generate newsletter
    generator = NewsletterGenerator(output_dir="./output")
    
    result = generator.save_newsletter(
        signals=formatted_signals,
        weird_picks=weird_picks,
        week=week,
        stats=stats,
        issue_number=1,
        prediction=prediction,
        split_signal=None,  # TODO: Detect split signals
    )
    
    print(f"\n✅ Newsletter generated!")
    print(f"   HTML: {result['html']}")
    print(f"   JSON: {result['json']}")
    
    # Print preview
    print(f"\n📋 Preview:")
    print(f"   BREAKOUT: {formatted_signals[0]['canonical_question'][:60]}...")
    print(f"   Velocity: +{formatted_signals[0]['velocity_pct']:.0f}%")
    print(f"   Total signals: {len(formatted_signals)}")
    
    return result


if __name__ == "__main__":
    generate_newsletter_from_db()
