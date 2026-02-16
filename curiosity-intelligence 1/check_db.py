#!/usr/bin/env python3
"""Check Supabase data"""
from dotenv import load_dotenv
load_dotenv()
import os
from supabase import create_client

supabase = create_client(
    os.getenv('SUPABASE_URL'),
    os.getenv('SUPABASE_SERVICE_ROLE_KEY')
)

print('=== TENANTS ===')
tenants = supabase.table('tenants').select('*').execute()
print(f'Count: {len(tenants.data)}')

print('\n=== RUNS ===')
runs = supabase.table('runs').select('*').execute()
print(f'Count: {len(runs.data)}')
for r in runs.data:
    print(f'  Run {r["id"]}: {r["status"]} - {r.get("questions_ingested", 0)} questions')

print('\n=== QUESTIONS ===')
questions = supabase.table('questions').select('id, raw_text').limit(3).execute()
print(f'Count: {len(questions.data)} (showing 3)')
for q in questions.data[:3]:
    print(f'  {q["id"]}: {q["raw_text"][:50]}...')

print('\n=== SIGNALS ===')
signals = supabase.table('signals').select('*').execute()
print(f'Count: {len(signals.data)}')
for s in signals.data:
    print(f'  {s["tier"]}: {s["canonical_question"][:50]}...')
