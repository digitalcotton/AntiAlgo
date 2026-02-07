#!/usr/bin/env python3
"""Quick smoke test for subscribers and predictions tables."""
import os, sys
sys.path.insert(0, '.')

from dotenv import load_dotenv
load_dotenv()

from supabase import create_client

url = os.environ.get('SUPABASE_URL')
key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY') or os.environ.get('SUPABASE_KEY')
print(f"URL: {url[:30]}...")
print(f"Key: {key[:10]}... (using {'service role' if 'SUPABASE_SERVICE_ROLE_KEY' in os.environ else 'anon'})")

client = create_client(url, key)

print("\n═══ TABLE ACCESS ═══")
for table in ['subscribers', 'predictions']:
    try:
        result = client.table(table).select('id').limit(1).execute()
        print(f"  ✅ {table}: accessible ({len(result.data)} rows)")
    except Exception as e:
        print(f"  ❌ {table}: {e}")

print("\n═══ SUBSCRIBE FLOW ═══")

# Step 1: Subscribe
print("\n1️⃣  Subscribing test@curiosityintel.dev...")
try:
    import secrets
    token = secrets.token_urlsafe(32)
    unsub_token = secrets.token_urlsafe(32)
    result = client.table('subscribers').insert({
        'email': 'test@curiosityintel.dev',
        'name': 'Test User',
        'status': 'pending_confirmation',
        'confirmation_token': token,
        'unsubscribe_token': unsub_token,
        'source': 'smoke_test',
    }).execute()
    row = result.data[0]
    print(f"   ✅ Created subscriber id={row['id']}")
    print(f"   confirmation_token: {token[:20]}...")
except Exception as e:
    print(f"   ❌ {e}")
    # If already exists, fetch it
    result = client.table('subscribers').select('*').eq('email', 'test@curiosityintel.dev').limit(1).execute()
    if result.data:
        row = result.data[0]
        token = row.get('confirmation_token', '')
        print(f"   ℹ️  Already exists (id={row['id']}, status={row['status']})")
    else:
        print("   Fatal: cannot proceed")
        sys.exit(1)

# Step 2: Confirm
print(f"\n2️⃣  Confirming with token...")
if token:
    try:
        ref_code = f"ci_{secrets.token_urlsafe(6)}"
        from datetime import datetime
        client.table('subscribers').update({
            'status': 'active',
            'confirmed_at': datetime.utcnow().isoformat(),
            'referral_code': ref_code,
            'confirmation_token': None,
        }).eq('email', 'test@curiosityintel.dev').execute()
        print(f"   ✅ Confirmed! referral_code: {ref_code}")
    except Exception as e:
        print(f"   ❌ {e}")
else:
    print("   ⏭️  Skipped (already confirmed)")
    ref_code = row.get('referral_code', '')

# Step 3: Count
print(f"\n3️⃣  Checking subscriber count...")
try:
    result = client.table('subscribers').select('id', count='exact').eq('status', 'active').execute()
    print(f"   ✅ Active subscribers: {result.count}")
except Exception as e:
    print(f"   ❌ {e}")

# Step 4: Referral stats
print(f"\n4️⃣  Checking referral stats for {ref_code}...")
try:
    result = client.table('subscribers').select('referral_code, referral_count, name').eq('referral_code', ref_code).limit(1).execute()
    if result.data:
        print(f"   ✅ {result.data[0]}")
    else:
        print(f"   ⚠️  No data returned for code {ref_code}")
except Exception as e:
    print(f"   ❌ {e}")

# Step 5: Test referral subscription
print(f"\n5️⃣  Subscribing a referred user...")
try:
    token2 = secrets.token_urlsafe(32)
    unsub2 = secrets.token_urlsafe(32)
    result = client.table('subscribers').insert({
        'email': 'referred@example.com',
        'name': 'Referred Friend',
        'status': 'pending_confirmation',
        'confirmation_token': token2,
        'unsubscribe_token': unsub2,
        'source': 'referral',
        'referred_by': ref_code,
    }).execute()
    print(f"   ✅ Created referred subscriber id={result.data[0]['id']}")

    # Confirm the referred user
    ref_code2 = f"ci_{secrets.token_urlsafe(6)}"
    client.table('subscribers').update({
        'status': 'active',
        'confirmed_at': datetime.utcnow().isoformat(),
        'referral_code': ref_code2,
        'confirmation_token': None,
    }).eq('email', 'referred@example.com').execute()

    # Increment referrer's count
    client.rpc('increment_referral_count', {'p_referral_code': ref_code}).execute()
    
    # Check referrer's updated count
    result = client.table('subscribers').select('referral_count').eq('referral_code', ref_code).limit(1).execute()
    print(f"   ✅ Referrer count now: {result.data[0]['referral_count']}")
except Exception as e:
    print(f"   ❌ {e}")

# Step 6: Final count
print(f"\n6️⃣  Final subscriber count...")
try:
    result = client.table('subscribers').select('id', count='exact').eq('status', 'active').execute()
    print(f"   ✅ Total active: {result.count}")
except Exception as e:
    print(f"   ❌ {e}")

# Cleanup
print(f"\n🧹 Cleaning up test data...")
try:
    client.table('subscribers').delete().eq('email', 'test@curiosityintel.dev').execute()
    client.table('subscribers').delete().eq('email', 'referred@example.com').execute()
    print("   ✅ Test subscribers removed")
except Exception as e:
    print(f"   ❌ {e}")

print("\n═══ DONE ═══")
