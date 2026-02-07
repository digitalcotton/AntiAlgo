"""Quick script to create the predictions table in Supabase."""
import os
from dotenv import load_dotenv
load_dotenv()
from supabase import create_client

url = os.environ.get('SUPABASE_URL')
key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY') or os.environ.get('SUPABASE_KEY')
client = create_client(url, key)

# Check if table exists
try:
    result = client.table('predictions').select('*').limit(1).execute()
    print(f"✅ predictions table already exists! Rows: {len(result.data)}")
except Exception as e:
    print(f"❌ predictions table does not exist yet.")
    print(f"   Error: {e}")
    print(f"\n   Please run this SQL in your Supabase SQL editor:")
    print(f"   https://supabase.com/dashboard/project/agtyswbnagvfdsjhifwc/sql/new")
    print(f"\n   SQL file: database/predictions.sql")
