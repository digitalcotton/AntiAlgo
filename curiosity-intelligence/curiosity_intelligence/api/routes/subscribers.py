"""
Subscriber Routes — Public endpoints for newsletter subscription.

No auth required. Rate-limited via Redis.
Handles: subscribe, double opt-in confirm, unsubscribe, referral stats,
         editorial (referral-gated), prediction, newsletter archive.
"""

import os
import secrets
import hashlib
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from ..services import get_db, DatabaseService
from ..services.email import get_email_service
from ...infra.observability import logger

router = APIRouter()


# ═══════════════════════════════════════════════════════
# SCHEMAS
# ═══════════════════════════════════════════════════════

class SubscribeRequest(BaseModel):
    email: str = Field(..., min_length=5, max_length=320)
    name: Optional[str] = Field(None, max_length=100)
    source: Optional[str] = Field("website", max_length=50)
    referral_code: Optional[str] = Field(None, max_length=50)


class UnsubscribeRequest(BaseModel):
    token: Optional[str] = Field(None, min_length=1)
    email: Optional[str] = Field(None, min_length=5, max_length=320)


# ═══════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════

def _generate_token() -> str:
    """Generate a URL-safe token for confirmation/unsubscribe links."""
    return secrets.token_urlsafe(32)


def _generate_referral_code() -> str:
    """Generate a short, memorable referral code."""
    return f"ci_{secrets.token_urlsafe(6)}"


def _basic_email_validation(email: str) -> bool:
    """Quick email format check."""
    return '@' in email and '.' in email.split('@')[-1] and len(email) >= 5


# ═══════════════════════════════════════════════════════
# SUBSCRIBE (Double opt-in — step 1: create pending subscriber)
# ═══════════════════════════════════════════════════════

@router.post("/subscribe", status_code=status.HTTP_201_CREATED)
async def subscribe(request: SubscribeRequest):
    """
    Subscribe to the newsletter.
    
    Creates a pending subscriber and returns a confirmation token.
    The email service (external) will use this token to send the
    double opt-in confirmation email.
    
    Public endpoint — no auth required.
    """
    email = request.email.lower().strip()

    if not _basic_email_validation(email):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid email address.",
        )

    db: DatabaseService = await get_db()

    if not db._supabase:
        raise HTTPException(status_code=503, detail="Database unavailable")

    # Check if already subscribed
    existing = db._supabase.table('subscribers').select(
        'id, status, confirmation_token'
    ).eq('email', email).limit(1).execute()

    if existing.data:
        row = existing.data[0]
        if row['status'] == 'active':
            return {
                "message": "You're already subscribed!",
                "status": "already_subscribed",
            }
        elif row['status'] == 'pending_confirmation':
            # Return existing token so email service can re-send
            return {
                "message": "Check your inbox — we already sent a confirmation email.",
                "status": "pending_confirmation",
                "confirmation_token": row['confirmation_token'],
            }

    # Create new subscriber (pending)
    confirmation_token = _generate_token()
    unsubscribe_token = _generate_token()

    insert_data = {
        'email': email,
        'name': request.name,
        'status': 'pending_confirmation',
        'confirmation_token': confirmation_token,
        'unsubscribe_token': unsubscribe_token,
        'source': request.source or 'website',
        'referred_by': request.referral_code,
    }

    try:
        db._supabase.table('subscribers').insert(insert_data).execute()
    except Exception as e:
        logger.error("subscribe_failed", email=email, error=str(e))
        raise HTTPException(status_code=500, detail="Failed to subscribe. Try again.")

    logger.info("subscriber_created", email=email, source=request.source)

    # Send confirmation email
    email_service = get_email_service()
    email_sent = await email_service.send_confirmation_email(
        to_email=email,
        confirmation_token=confirmation_token,
        name=request.name,
    )

    return {
        "message": "Almost there! Check your email to confirm your subscription.",
        "status": "pending_confirmation",
        "confirmation_token": confirmation_token,
        "email_sent": email_sent,
    }


# ═══════════════════════════════════════════════════════
# CONFIRM (Double opt-in — step 2: activate subscriber)
# ═══════════════════════════════════════════════════════

@router.post("/confirm/{token}")
async def confirm_subscription(token: str):
    """
    Confirm email subscription (double opt-in step 2).
    
    Activates the subscriber, assigns a referral code, and
    increments the referrer's count if applicable.
    """
    db: DatabaseService = await get_db()

    if not db._supabase:
        raise HTTPException(status_code=503, detail="Database unavailable")

    # Find subscriber by confirmation token
    result = db._supabase.table('subscribers').select(
        'id, email, name, status, referred_by'
    ).eq('confirmation_token', token).limit(1).execute()

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Invalid or expired confirmation link.",
        )

    subscriber = result.data[0]

    if subscriber['status'] == 'active':
        # Already confirmed — just return referral code
        existing = db._supabase.table('subscribers').select(
            'referral_code'
        ).eq('id', subscriber['id']).single().execute()
        return {
            "message": "Already confirmed!",
            "referral_code": existing.data.get('referral_code', ''),
        }

    # Activate subscriber + assign referral code
    referral_code = _generate_referral_code()

    db._supabase.table('subscribers').update({
        'status': 'active',
        'confirmed_at': datetime.utcnow().isoformat(),
        'referral_code': referral_code,
        'confirmation_token': None,  # One-time use
    }).eq('id', subscriber['id']).execute()

    # Credit the referrer and send notification
    referrer_email = None
    referrer_name = None
    new_referral_count = 0
    
    if subscriber.get('referred_by'):
        try:
            # Get referrer info before incrementing
            referrer_result = db._supabase.table('subscribers').select(
                'email, name, referral_count'
            ).eq('referral_code', subscriber['referred_by']).limit(1).execute()
            
            if referrer_result.data:
                referrer = referrer_result.data[0]
                referrer_email = referrer['email']
                referrer_name = referrer.get('name')
                new_referral_count = (referrer.get('referral_count') or 0) + 1
            
            # Increment the count
            db._supabase.rpc(
                'increment_referral_count',
                {'p_referral_code': subscriber['referred_by']}
            ).execute()
            
            logger.info("referral_credited", referrer=subscriber['referred_by'], new_subscriber=subscriber['email'])
        except Exception as e:
            logger.error("referral_credit_failed", error=str(e))

    logger.info("subscriber_confirmed", email=subscriber['email'], referral_code=referral_code)

    # Send welcome email
    email_service = get_email_service()
    await email_service.send_welcome_email(
        to_email=subscriber['email'],
        referral_code=referral_code,
        name=subscriber.get('name'),
    )
    
    # Notify referrer if applicable
    if referrer_email:
        unlocked_tier = None
        if new_referral_count == 1:
            unlocked_tier = "early_access"
        elif new_referral_count == 3:
            unlocked_tier = "signal_takes"
        elif new_referral_count == 10:
            unlocked_tier = "deep_dives"
        
        await email_service.send_referral_notification(
            to_email=referrer_email,
            referrer_name=referrer_name,
            new_referral_count=new_referral_count,
            unlocked_tier=unlocked_tier,
        )

    return {
        "message": "You're in! Welcome to AntiAlgo.",
        "referral_code": referral_code,
    }


# ═══════════════════════════════════════════════════════
# UNSUBSCRIBE
# ═══════════════════════════════════════════════════════

@router.post("/unsubscribe")
async def unsubscribe(request: UnsubscribeRequest):
    """
    Unsubscribe from the newsletter.
    
    Accepts either an unsubscribe token or an email address.
    """
    db: DatabaseService = await get_db()

    if not db._supabase:
        raise HTTPException(status_code=503, detail="Database unavailable")

    token_or_email = (request.token or request.email or "").strip()

    if not token_or_email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide either 'token' or 'email'.",
        )

    # Try as unsubscribe token first
    result = db._supabase.table('subscribers').select('id, email').eq(
        'unsubscribe_token', token_or_email
    ).limit(1).execute()

    # Fall back to email lookup
    if not result.data:
        result = db._supabase.table('subscribers').select('id, email').eq(
            'email', token_or_email.lower()
        ).limit(1).execute()

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Subscriber not found.",
        )

    subscriber = result.data[0]

    db._supabase.table('subscribers').update({
        'status': 'unsubscribed',
    }).eq('id', subscriber['id']).execute()

    logger.info("subscriber_unsubscribed", email=subscriber['email'])

    return {"message": "You've been unsubscribed. We're sorry to see you go."}


# ═══════════════════════════════════════════════════════
# SUBSCRIBER COUNT (Public — social proof)
# ═══════════════════════════════════════════════════════

@router.get("/count")
async def get_subscriber_count():
    """
    Get the current active subscriber count.
    Public endpoint for social proof on the landing page.
    """
    db: DatabaseService = await get_db()

    if not db._supabase:
        return {"count": 0, "goal": 40000}

    try:
        result = db._supabase.rpc('get_subscriber_count', {'p_tenant_id': 1}).execute()
        count = result.data if isinstance(result.data, int) else 0
    except Exception:
        # Fallback: direct count
        result = db._supabase.table('subscribers').select(
            'id', count='exact'
        ).eq('status', 'active').execute()
        count = result.count or 0

    return {"count": count, "goal": 40000}


# ═══════════════════════════════════════════════════════
# REFERRAL STATS
# ═══════════════════════════════════════════════════════

@router.get("/referral/{code}")
async def get_referral_stats(code: str):
    """
    Get referral stats for a referral code.
    Public — used on the /r/:code referral page.
    """
    db: DatabaseService = await get_db()

    if not db._supabase:
        raise HTTPException(status_code=503, detail="Database unavailable")

    result = db._supabase.table('subscribers').select(
        'referral_code, referral_count, name'
    ).eq('referral_code', code).eq('status', 'active').limit(1).execute()

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Referral code not found.",
        )

    sub = result.data[0]
    count = sub.get('referral_count', 0)

    # Determine unlocked tiers
    tiers = []
    if count >= 1:
        tiers.append('early_access')
    if count >= 3:
        tiers.append('editorial')
    if count >= 10:
        tiers.append('deep_dive')

    return {
        "referral_code": code,
        "referral_count": count,
        "name": sub.get('name'),
        "unlocked_tiers": tiers,
    }


# ═══════════════════════════════════════════════════════
# EDITORIAL (Steve Jobs takes — referral-gated)
# ═══════════════════════════════════════════════════════

@router.get("/editorial")
async def get_editorial(ref: Optional[str] = Query(None)):
    """
    Get Steve Jobs editorial takes on trending signals.
    
    Requires a referral code with 3+ referrals to unlock.
    Returns empty if not unlocked.
    """
    db: DatabaseService = await get_db()

    if not db._supabase:
        return {"editorial": [], "locked": True}

    # Check if referral code has enough referrals
    unlocked = False
    if ref:
        result = db._supabase.table('subscribers').select(
            'referral_count'
        ).eq('referral_code', ref).eq('status', 'active').limit(1).execute()
        if result.data and result.data[0].get('referral_count', 0) >= 3:
            unlocked = True

    if not unlocked:
        return {
            "editorial": [],
            "locked": True,
            "message": "Refer 3 friends to unlock Steve Jobs editorial takes.",
        }

    # Get trending signals
    trending = db._supabase.table('signals').select(
        'id, canonical_question, final_score, velocity_pct, tier, question_count, platform_count'
    ).order('final_score', desc=True).limit(5).execute()

    signals = trending.data or []

    # Generate editorial takes
    # In production, call the Steve Jobs agent via the orchestrator.
    # For now, use curated one-liners based on signal tier.
    editorial = []
    for s in signals:
        take = _generate_editorial_take(s)
        editorial.append({
            **s,
            'editorial_take': take,
        })

    return {"editorial": editorial, "locked": False}


def _generate_editorial_take(signal: dict) -> str:
    """
    Generate a Steve Jobs-style one-liner for a signal.
    
    TODO: Replace with actual Steve Jobs agent call via orchestrator.
    For now, uses rule-based generation.
    """
    tier = signal.get('tier', 'signal')
    question = signal.get('canonical_question', '')
    velocity = signal.get('velocity_pct', 0)

    if tier == 'breakout':
        return f"This isn't a trend — it's a platform shift. When developers ask this many questions this fast, the market is about to move."
    elif tier == 'strong' and velocity > 75:
        return f"Watch this one. The velocity tells you everything — developers are building, not just browsing."
    elif tier == 'strong':
        return f"Strong signal, but the question is: who ships the answer first? That's where the opportunity lives."
    elif velocity > 50:
        return f"The acceleration is the story here. This went from curiosity to urgency in one week."
    else:
        return f"Interesting signal. The best products come from questions nobody else is paying attention to."


# ═══════════════════════════════════════════════════════
# PREDICTION (Latest graded prediction)
# ═══════════════════════════════════════════════════════

@router.get("/prediction/latest")
async def get_latest_prediction():
    """
    Get the most recent graded prediction for the 'Last week we said' section.
    Public endpoint.
    """
    db: DatabaseService = await get_db()

    if not db._supabase:
        return {"prediction": None}

    # Try to get most recent graded prediction
    result = db._supabase.table('predictions').select('*').not_.is_(
        'grade', 'null'
    ).order('graded_at', desc=True).limit(1).execute()

    if result.data:
        p = result.data[0]
        grade_map = {
            'hit': '✅ Hit',
            'miss': '❌ Miss',
            'too_early': '🤷 Too early to tell',
        }
        return {
            "prediction": {
                "prediction_text": p.get('prediction_text', ''),
                "confidence": p.get('confidence', ''),
                "week": p.get('week', ''),
                "grade_display": grade_map.get(p.get('grade', ''), ''),
                "grade_explanation": p.get('grade_explanation', ''),
            }
        }

    # Fall back to most recent ungraded prediction
    result = db._supabase.table('predictions').select('*').order(
        'created_at', desc=True
    ).limit(1).execute()

    if result.data:
        p = result.data[0]
        return {
            "prediction": {
                "prediction_text": p.get('prediction_text', ''),
                "confidence": p.get('confidence', ''),
                "week": p.get('week', ''),
                "grade_display": '',
                "grade_explanation": '',
            }
        }

    return {"prediction": None}


# ═══════════════════════════════════════════════════════
# NEWSLETTER ARCHIVE
# ═══════════════════════════════════════════════════════

@router.get("/newsletter/{week}")
async def get_newsletter_archive(week: str):
    """
    Get a past newsletter by week for the public archive.
    
    Reads from the output directory.
    """
    import json
    from pathlib import Path

    # Sanitize week input
    if not all(c in '0123456789-W' for c in week):
        raise HTTPException(status_code=400, detail="Invalid week format. Use YYYY-WNN.")

    # Try multiple output directory paths
    base_dirs = [
        Path("./output"),
        Path("./curiosity-intelligence/output"),
        Path(os.path.dirname(__file__)).parent.parent.parent / "output",
    ]

    html_content = None
    meta = None

    for base in base_dirs:
        week_dir = base / week.replace('-', '_')
        html_path = week_dir / "newsletter.html"
        json_path = week_dir / "newsletter_data.json"

        if html_path.exists():
            html_content = html_path.read_text()
            if json_path.exists():
                try:
                    meta = json.loads(json_path.read_text())
                except Exception:
                    pass
            break

    if not html_content:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Newsletter for week {week} not found.",
        )

    return {
        "html": html_content,
        "meta": meta or {
            "week": week,
            "issue_number": 1,
            "generated_at": "",
            "stats": {
                "total_signals": 0,
                "questions_analyzed": 0,
                "platforms_monitored": 0,
            },
        },
    }
