#!/usr/bin/env python3
"""Debug API query"""
from dotenv import load_dotenv
load_dotenv()
import os
from supabase import create_client

supabase = create_client(
    os.getenv('SUPABASE_URL'),
    os.getenv('SUPABASE_SERVICE_ROLE_KEY')
)

print('=== DEBUG SIGNAL QUERY ===')

# Check runs with tenant_id
runs = supabase.table('runs').select('id, tenant_id, week').execute()
print(f'\nRuns ({len(runs.data)}):')
for r in runs.data:
    print(f'  Run {r["id"]}: tenant_id={r["tenant_id"]}, week={r["week"]}')

# Check signals with run_id
signals = supabase.table('signals').select('id, run_id, canonical_question').execute()
print(f'\nSignals ({len(signals.data)}):')
for s in signals.data:
    print(f'  Signal {s["id"]}: run_id={s["run_id"]}, {s["canonical_question"][:40]}...')

# Try the actual query the API uses
print('\n=== QUERY TEST ===')
tenant_id = 1
result = supabase.table('signals').select(
    '*, runs!inner(week, tenant_id)', count='exact'
).eq('runs.tenant_id', tenant_id).execute()

print(f'Result count: {result.count}')
print(f'Data: {result.data[:2] if result.data else "NONE"}')

# Try simpler query
print('\n=== SIMPLE QUERY ===')
result2 = supabase.table('signals').select('*').execute()
print(f'All signals: {len(result2.data)}')
