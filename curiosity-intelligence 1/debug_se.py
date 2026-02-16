#!/usr/bin/env python3
"""Debug script to trace Stack Exchange ingestion"""

import asyncio
import os
from datetime import datetime, timedelta
from dotenv import load_dotenv

# Load env FIRST
load_dotenv()

import httpx

API_BASE = "https://api.stackexchange.com/2.3"

async def debug_fetch():
    api_key = os.environ.get("STACKEXCHANGE_KEY") or os.environ.get("STACKEXCHANGE_API_KEY")
    print(f"API Key loaded: {bool(api_key)}")
    if api_key:
        print(f"Key starts with: {api_key[:10]}...")
    
    since = datetime.utcnow() - timedelta(days=30)
    since_timestamp = int(since.timestamp())
    print(f"Since timestamp: {since_timestamp} ({since.date()})")
    
    # Test one simple query
    params = {
        "site": "stackoverflow",
        "tagged": "openai-api",
        "fromdate": since_timestamp,
        "sort": "activity",
        "order": "desc",
        "pagesize": 10,
    }
    
    if api_key:
        params["key"] = api_key
    
    print(f"\nRequest params: {params}")
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(f"{API_BASE}/questions", params=params)
        print(f"Response status: {response.status_code}")
        
        data = response.json()
        print(f"Items returned: {len(data.get('items', []))}")
        print(f"Quota remaining: {data.get('quota_remaining')}")
        
        if data.get("items"):
            print("\nFirst question:")
            item = data["items"][0]
            print(f"  Title: {item.get('title', 'N/A')[:60]}...")
            print(f"  Tags: {item.get('tags', [])}")

if __name__ == "__main__":
    asyncio.run(debug_fetch())
