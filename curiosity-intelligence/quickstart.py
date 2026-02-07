#!/usr/bin/env python3
"""
Quick Start Script

Sets up and runs Curiosity Intelligence in demo mode.
"""

import asyncio
import os
import sys
from pathlib import Path

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).parent))


def check_environment():
    """Check required environment variables."""
    print("🔍 Checking environment...\n")
    
    required = ["OPENAI_API_KEY"]
    optional = ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "NEWSAPI_KEY", "SUPABASE_URL", "SUPABASE_KEY"]
    
    missing_required = []
    missing_optional = []
    
    for var in required:
        if os.environ.get(var):
            print(f"  ✓ {var}")
        else:
            print(f"  ✗ {var} (REQUIRED)")
            missing_required.append(var)
    
    print()
    
    for var in optional:
        if os.environ.get(var):
            print(f"  ✓ {var}")
        else:
            print(f"  ○ {var} (optional)")
            missing_optional.append(var)
    
    print()
    
    if missing_required:
        print("❌ Missing required environment variables!")
        print("   Copy .env.example to .env and fill in the values:")
        print("   cp .env.example .env")
        return False
    
    if missing_optional:
        print("⚠️  Some optional features won't work:")
        if "REDDIT_CLIENT_ID" in missing_optional:
            print("   - Reddit ingestion disabled")
        if "NEWSAPI_KEY" in missing_optional:
            print("   - News correlation disabled")
        if "SUPABASE_URL" in missing_optional:
            print("   - Database persistence disabled")
    
    print()
    return True


def run_demo():
    """Run with mock data for demonstration."""
    print("🎮 Running demo with mock data...\n")
    
    # Import and run test
    from tests.test_pipeline import test_full_pipeline_mock
    asyncio.run(test_full_pipeline_mock())


async def run_live():
    """Run live pipeline with real data."""
    print("🚀 Running live pipeline...\n")
    
    from curiosity_intelligence.pipeline import CuriosityPipeline, PipelineConfig
    
    config = PipelineConfig(
        week_start=None,  # Current week
        dry_run=not os.environ.get("SUPABASE_URL"),  # Skip DB if not configured
    )
    
    pipeline = CuriosityPipeline(config)
    results = await pipeline.run()
    
    return results


def main():
    print("=" * 60)
    print("🧠 CURIOSITY INTELLIGENCE ENGINE")
    print("=" * 60)
    print()
    
    # Check environment
    if not check_environment():
        print("\n💡 Run in demo mode to test without API keys:")
        print("   python quickstart.py demo")
        return
    
    # Parse args
    mode = sys.argv[1] if len(sys.argv) > 1 else "live"
    
    if mode == "demo":
        run_demo()
    elif mode == "live":
        asyncio.run(run_live())
    elif mode == "check":
        print("✓ Environment check complete")
    else:
        print(f"Unknown mode: {mode}")
        print("Usage: python quickstart.py [demo|live|check]")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n👋 Interrupted")
    except Exception as e:
        print(f"\n❌ Error: {e}")
        raise
