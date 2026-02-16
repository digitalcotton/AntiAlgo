#!/usr/bin/env python3
"""Debug the actual StackExchangeIngester class"""

import asyncio
import os
from datetime import datetime, timedelta
from dotenv import load_dotenv

# Load env FIRST before importing the ingester
load_dotenv()

print(f"After load_dotenv, STACKEXCHANGE_KEY: {os.environ.get('STACKEXCHANGE_KEY', 'NOT SET')[:15]}...")

from curiosity_intelligence.ingestion import StackExchangeIngester

async def debug():
    ingester = StackExchangeIngester()
    print(f"Ingester API key: {ingester.api_key[:15] if ingester.api_key else 'NOT SET'}...")
    print(f"Sites: {ingester.sites}")
    print(f"Tags: {ingester.tags[:5]}... ({len(ingester.tags)} total)")
    
    since = datetime.utcnow() - timedelta(days=30)
    print(f"\nFetching since: {since.date()}")
    
    questions = await ingester.ingest(since)
    print(f"\nTotal questions fetched: {len(questions)}")
    
    if questions:
        print("\nSample questions:")
        for q in questions[:3]:
            print(f"  - {q['raw_text'][:60]}...")
    
    await ingester.close()

if __name__ == "__main__":
    asyncio.run(debug())
