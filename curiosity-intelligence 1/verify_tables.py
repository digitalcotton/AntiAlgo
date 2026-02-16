#!/usr/bin/env python3
"""Verify tables exist in Supabase and check PostgREST schema cache."""
import os
import requests
from dotenv import load_dotenv

load_dotenv()

url = os.getenv('SUPABASE_URL')
key = os.getenv('SUPABASE_SERVICE_ROLE_KEY')

print(f"URL: {url[:40]}...")
headers = {
    'apikey': key,
    'Authorization': f'Bearer {key}',
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
}

# 1. Check root endpoint for available tables
print("\n=== PostgREST Schema Cache ===")
resp = requests.get(f'{url}/rest/v1/', headers=headers)
print(f"Root: {resp.status_code}")
if resp.status_code == 200:
    try:
        data = resp.json()
        if isinstance(data, dict):
            print(f"Known objects: {sorted(data.keys())}")
        elif isinstance(data, list):
            print(f"Objects: {[d.get('name', d) for d in data[:20]]}")
    except Exception:
        print(f"Response: {resp.text[:300]}")

# 2. Try direct table access
print("\n=== Direct Table Access ===")
for table in ['subscribers', 'predictions', 'signals', 'tenants']:
    resp = requests.get(
        f'{url}/rest/v1/{table}',
        params={'select': 'count', 'limit': '0'},
        headers=headers
    )
    status = "✅" if resp.status_code == 200 else "❌"
    print(f"  {status} {table}: {resp.status_code} {resp.text[:100] if resp.status_code != 200 else 'OK'}")

# 3. Try RPC functions
print("\n=== RPC Functions ===")
resp = requests.post(
    f'{url}/rest/v1/rpc/get_subscriber_count',
    json={'p_tenant_id': 1},
    headers=headers
)
print(f"  get_subscriber_count: {resp.status_code} {resp.text[:100]}")

# 4. Try SQL via Supabase's pg_net or check if tables are in pg_catalog
# Use the postgrest introspection approach
print("\n=== Check via SQL (information_schema) ===")
from supabase import create_client
client = create_client(url, key)
try:
    # This is a creative workaround - query if the function exists
    result = client.rpc('get_subscriber_count', {'p_tenant_id': 1}).execute()
    print(f"  RPC via client: {result.data}")
except Exception as e:
    print(f"  RPC via client error: {e}")
