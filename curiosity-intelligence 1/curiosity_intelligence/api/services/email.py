"""
Email Service — Powered by Resend.

Handles transactional emails:
- Double opt-in confirmation
- Welcome email (after confirmation)
- Referral notifications
- Weekly newsletter delivery
"""

import os
from typing import Optional

import resend

from ...infra.observability import logger

# Initialize Resend
resend.api_key = os.getenv("RESEND_API_KEY", "")

# Email configuration
FROM_EMAIL = os.getenv("FROM_EMAIL", "AntiAlgo <hello@antialgo.ai>")
SITE_URL = os.getenv("SITE_URL", "http://localhost:3002")


class EmailService:
    """Transactional email service using Resend."""

    def __init__(self):
        self.from_email = FROM_EMAIL
        self.site_url = SITE_URL
        self.enabled = bool(resend.api_key)

        if not self.enabled:
            logger.warning("email_disabled", reason="RESEND_API_KEY not set")

    async def send_confirmation_email(
        self,
        to_email: str,
        confirmation_token: str,
        name: Optional[str] = None,
    ) -> bool:
        """
        Send double opt-in confirmation email.
        
        Returns True if sent successfully, False otherwise.
        """
        if not self.enabled:
            logger.info("email_skipped", type="confirmation", to=to_email)
            return False

        confirm_url = f"{self.site_url}/confirm/{confirmation_token}"
        
        greeting = f"Hey {name}," if name else "Hey there,"

        html = f"""
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif; background: #fafafa; padding: 40px 20px; margin: 0;">
    <div style="max-width: 480px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
        
        <h1 style="font-size: 24px; font-weight: 600; color: #1a1a1a; margin: 0 0 24px 0;">
            Confirm your subscription
        </h1>
        
        <p style="font-size: 16px; line-height: 1.6; color: #4a4a4a; margin: 0 0 16px 0;">
            {greeting}
        </p>
        
        <p style="font-size: 16px; line-height: 1.6; color: #4a4a4a; margin: 0 0 24px 0;">
            You're one click away from seeing what the algorithm hides. Confirm your email to join the AntiAlgo newsletter.
        </p>
        
        <a href="{confirm_url}" style="display: inline-block; background: #1a1a1a; color: #fff; font-size: 16px; font-weight: 500; padding: 14px 28px; border-radius: 8px; text-decoration: none;">
            Confirm my subscription →
        </a>
        
        <p style="font-size: 14px; line-height: 1.6; color: #888; margin: 32px 0 0 0;">
            If you didn't request this, just ignore this email.
        </p>
        
        <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
        
        <p style="font-size: 12px; color: #888; margin: 0;">
            AntiAlgo.ai — Built with signal, not noise.
        </p>
        
    </div>
</body>
</html>
"""

        text = f"""
{greeting}

You're one click away from seeing what the algorithm hides.

Confirm your subscription: {confirm_url}

If you didn't request this, just ignore this email.

—
AntiAlgo.ai
"""

        try:
            params = {
                "from": self.from_email,
                "to": [to_email],
                "subject": "Confirm your AntiAlgo subscription",
                "html": html,
                "text": text,
            }
            
            result = resend.Emails.send(params)
            
            logger.info("email_sent", type="confirmation", to=to_email, id=result.get("id"))
            return True

        except Exception as e:
            logger.error("email_failed", type="confirmation", to=to_email, error=str(e))
            return False

    async def send_welcome_email(
        self,
        to_email: str,
        referral_code: str,
        name: Optional[str] = None,
    ) -> bool:
        """
        Send welcome email after confirmation with referral link.
        """
        if not self.enabled:
            logger.info("email_skipped", type="welcome", to=to_email)
            return False

        referral_url = f"{self.site_url}/?ref={referral_code}"
        
        greeting = f"Welcome, {name}!" if name else "Welcome!"

        html = f"""
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif; background: #fafafa; padding: 40px 20px; margin: 0;">
    <div style="max-width: 480px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
        
        <h1 style="font-size: 24px; font-weight: 600; color: #1a1a1a; margin: 0 0 24px 0;">
            {greeting}
        </h1>
        
        <p style="font-size: 16px; line-height: 1.6; color: #4a4a4a; margin: 0 0 16px 0;">
            You're in. Every Friday, you'll get the signals the algorithm doesn't want you to see.
        </p>
        
        <p style="font-size: 16px; line-height: 1.6; color: #4a4a4a; margin: 0 0 24px 0;">
            While you wait for the first issue, here's your unique referral link:
        </p>
        
        <div style="background: #f5f5f5; border-radius: 8px; padding: 16px; margin: 0 0 24px 0;">
            <code style="font-size: 14px; color: #1a1a1a; word-break: break-all;">{referral_url}</code>
        </div>
        
        <p style="font-size: 14px; line-height: 1.6; color: #4a4a4a; margin: 0 0 8px 0;">
            <strong>Share it to unlock:</strong>
        </p>
        
        <ul style="font-size: 14px; line-height: 1.8; color: #4a4a4a; margin: 0 0 24px 0; padding-left: 20px;">
            <li><strong>1 referral:</strong> 24-hour early access</li>
            <li><strong>3 referrals:</strong> The Signal's Take (exclusive analysis)</li>
            <li><strong>10 referrals:</strong> Deep dives + prediction methodology</li>
        </ul>
        
        <a href="{referral_url}" style="display: inline-block; background: #1a1a1a; color: #fff; font-size: 16px; font-weight: 500; padding: 14px 28px; border-radius: 8px; text-decoration: none;">
            Share your link →
        </a>
        
        <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
        
        <p style="font-size: 12px; color: #888; margin: 0;">
            AntiAlgo.ai — Built with signal, not noise.
        </p>
        
    </div>
</body>
</html>
"""

        text = f"""
{greeting}

You're in. Every Friday, you'll get the signals the algorithm doesn't want you to see.

Your unique referral link: {referral_url}

Share it to unlock:
• 1 referral: 24-hour early access
• 3 referrals: The Signal's Take (exclusive analysis)
• 10 referrals: Deep dives + prediction methodology

—
AntiAlgo.ai
"""

        try:
            params = {
                "from": self.from_email,
                "to": [to_email],
                "subject": "You're in. Here's your referral link.",
                "html": html,
                "text": text,
            }
            
            result = resend.Emails.send(params)
            
            logger.info("email_sent", type="welcome", to=to_email, id=result.get("id"))
            return True

        except Exception as e:
            logger.error("email_failed", type="welcome", to=to_email, error=str(e))
            return False

    async def send_referral_notification(
        self,
        to_email: str,
        referrer_name: Optional[str],
        new_referral_count: int,
        unlocked_tier: Optional[str] = None,
    ) -> bool:
        """
        Notify a referrer when someone confirms via their link.
        """
        if not self.enabled:
            return False

        greeting = f"Hey {referrer_name}," if referrer_name else "Hey,"
        
        tier_message = ""
        if unlocked_tier == "early_access":
            tier_message = "🎉 You've unlocked <strong>Early Access</strong>! You'll now get each issue 24 hours before everyone else."
        elif unlocked_tier == "signal_takes":
            tier_message = "🧠 You've unlocked <strong>The Signal's Take</strong>! Your next issue will include exclusive editorial analysis."
        elif unlocked_tier == "deep_dives":
            tier_message = "📊 You've unlocked <strong>Deep Dives</strong>! You now have access to our full prediction methodology."

        html = f"""
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif; background: #fafafa; padding: 40px 20px; margin: 0;">
    <div style="max-width: 480px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
        
        <h1 style="font-size: 24px; font-weight: 600; color: #1a1a1a; margin: 0 0 24px 0;">
            Someone joined via your link!
        </h1>
        
        <p style="font-size: 16px; line-height: 1.6; color: #4a4a4a; margin: 0 0 16px 0;">
            {greeting}
        </p>
        
        <p style="font-size: 16px; line-height: 1.6; color: #4a4a4a; margin: 0 0 24px 0;">
            A friend just confirmed their AntiAlgo subscription using your referral link.
            You now have <strong>{new_referral_count} referral{"s" if new_referral_count != 1 else ""}</strong>.
        </p>
        
        {f'<p style="font-size: 16px; line-height: 1.6; color: #4a4a4a; margin: 0 0 24px 0;">{tier_message}</p>' if tier_message else ''}
        
        <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
        
        <p style="font-size: 12px; color: #888; margin: 0;">
            AntiAlgo.ai — Built with signal, not noise.
        </p>
        
    </div>
</body>
</html>
"""

        try:
            params = {
                "from": self.from_email,
                "to": [to_email],
                "subject": f"🎉 New referral! You now have {new_referral_count}.",
                "html": html,
            }
            
            result = resend.Emails.send(params)
            logger.info("email_sent", type="referral_notification", to=to_email, id=result.get("id"))
            return True

        except Exception as e:
            logger.error("email_failed", type="referral_notification", to=to_email, error=str(e))
            return False


# Singleton
_email_service: Optional[EmailService] = None


def get_email_service() -> EmailService:
    """Get or create the email service singleton."""
    global _email_service
    if _email_service is None:
        _email_service = EmailService()
    return _email_service
