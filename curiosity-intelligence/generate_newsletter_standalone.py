#!/usr/bin/env python3
"""
Generate Newsletter - Standalone

Generates an email-ready HTML newsletter from Supabase signals.
Direct imports to avoid loading heavy dependencies (sklearn, hdbscan).
"""

import os
import sys
from datetime import date, datetime
from pathlib import Path
import json
import html

# Load environment
from dotenv import load_dotenv
load_dotenv()

from supabase import create_client


# =============================================================================
# NEWSLETTER GENERATOR (Inline to avoid import chain)
# =============================================================================

class NewsletterGenerator:
    """Email-ready HTML newsletter generator."""
    
    COLORS = {
        'bg': '#ffffff',
        'bg_alt': '#f5f5f7',
        'text': '#1d1d1f',
        'text_secondary': '#86868b',
        'accent': '#0071e3',
        'success': '#34c759',
        'warning': '#ff9500',
        'breakout': '#ff375f',
        'border': '#d2d2d7',
    }
    
    FONTS = {
        'sans': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }
    
    def __init__(self, output_dir: str = "./output"):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
    
    def _escape(self, text: str) -> str:
        return html.escape(str(text)) if text else ""
    
    def _velocity_badge(self, velocity: float) -> str:
        if velocity > 100:
            color = self.COLORS['breakout']
        elif velocity > 50:
            color = self.COLORS['success']
        elif velocity > 0:
            color = self.COLORS['warning']
        else:
            color = self.COLORS['text_secondary']
        
        label = f"+{velocity:.0f}%" if velocity > 0 else f"{velocity:.0f}%"
        
        return f'''<span style="display:inline-block;background:{color};color:white;font-size:11px;font-weight:600;padding:2px 8px;border-radius:12px;">{label}</span>'''
    
    def _tier_indicator(self, tier: str) -> str:
        indicators = {
            'breakout': '🔥',
            'strong': '⚡',
            'signal': '📈',
            'noise': '〰️',
        }
        return indicators.get(tier.lower(), '📊')

    def generate_html(
        self,
        signals: list,
        weird_picks: list,
        week: str,
        stats: dict,
        issue_number: int = 1,
        prediction: str = None,
    ) -> str:
        """Generate complete email-ready HTML newsletter."""
        
        breakout = signals[0] if signals else {}
        velocity_5 = signals[1:6] if len(signals) > 1 else signals[:5]
        weird_pick = weird_picks[0] if weird_picks else None
        
        # Breakout section
        breakout_html = ""
        if breakout:
            breakout_html = f'''
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:48px;">
    <tr><td style="padding:0 24px;">
        <p style="font-family:{self.FONTS['sans']};font-size:11px;font-weight:700;letter-spacing:1.5px;color:{self.COLORS['breakout']};text-transform:uppercase;margin:0 0 16px;">🔥 BREAKOUT</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f7;border-radius:16px;border-left:6px solid #ff375f;">
            <tr><td style="padding:32px;">
                <p style="font-family:{self.FONTS['sans']};font-size:24px;font-weight:600;line-height:1.3;color:#1d1d1f;margin:0 0 24px;">&ldquo;{self._escape(breakout.get('canonical_question', 'N/A'))}&rdquo;</p>
                <table cellpadding="0" cellspacing="0">
                    <tr>
                        <td style="padding-right:24px;">
                            <span style="font-family:{self.FONTS['sans']};font-size:32px;font-weight:700;color:#ff375f;">+{breakout.get('velocity_pct', 0):.0f}%</span><br/>
                            <span style="font-family:{self.FONTS['sans']};font-size:12px;color:#86868b;">velocity</span>
                        </td>
                        <td>
                            <span style="font-family:{self.FONTS['sans']};font-size:32px;font-weight:700;color:#1d1d1f;">{breakout.get('question_count', 0)}</span><br/>
                            <span style="font-family:{self.FONTS['sans']};font-size:12px;color:#86868b;">questions</span>
                        </td>
                    </tr>
                </table>
            </td></tr>
        </table>
    </td></tr>
</table>'''
        
        # Velocity 5 section
        velocity_rows = ""
        for i, s in enumerate(velocity_5, 1):
            velocity_rows += f'''
            <tr><td style="padding:16px 0;border-bottom:1px solid {self.COLORS['border']};">
                <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                        <td width="32" valign="top" style="font-family:{self.FONTS['sans']};font-size:14px;font-weight:600;color:{self.COLORS['text_secondary']};padding-right:12px;">{i}.</td>
                        <td valign="top">
                            <p style="font-family:{self.FONTS['sans']};font-size:15px;font-weight:500;line-height:1.4;color:{self.COLORS['text']};margin:0 0 6px;">{self._tier_indicator(s.get('tier', 'signal'))} {self._escape(s.get('canonical_question', 'N/A'))}</p>
                            {self._velocity_badge(s.get('velocity_pct', 0))}
                        </td>
                    </tr>
                </table>
            </td></tr>'''
        
        velocity_html = f'''
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:48px;">
    <tr><td style="padding:0 24px;">
        <p style="font-family:{self.FONTS['sans']};font-size:11px;font-weight:700;letter-spacing:1.5px;color:{self.COLORS['accent']};text-transform:uppercase;margin:0;">⚡ VELOCITY 5</p>
        <p style="font-family:{self.FONTS['sans']};font-size:14px;color:{self.COLORS['text_secondary']};margin:4px 0 16px;">The fastest rising questions this week</p>
        <table width="100%" cellpadding="0" cellspacing="0">{velocity_rows}</table>
    </td></tr>
</table>'''
        
        # Weird pick section
        weird_html = ""
        if weird_pick:
            weird_html = f'''
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:48px;">
    <tr><td style="padding:0 24px;">
        <p style="font-family:{self.FONTS['sans']};font-size:11px;font-weight:700;letter-spacing:1.5px;color:{self.COLORS['warning']};text-transform:uppercase;margin:0;">🤔 THE WEIRD ONE</p>
        <p style="font-family:{self.FONTS['sans']};font-size:14px;color:{self.COLORS['text_secondary']};margin:4px 0 16px;">Doesn't fit the pattern, but caught our attention</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:{self.COLORS['bg_alt']};border-radius:12px;border-left:4px solid {self.COLORS['warning']};">
            <tr><td style="padding:20px 24px;">
                <p style="font-family:{self.FONTS['sans']};font-size:17px;font-weight:500;line-height:1.5;color:{self.COLORS['text']};margin:0;font-style:italic;">"{self._escape(weird_pick.get('canonical_question', 'N/A'))}"</p>
            </td></tr>
        </table>
    </td></tr>
</table>'''
        
        # Prediction section
        prediction_html = ""
        if prediction:
            prediction_html = f'''
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:48px;">
    <tr><td style="padding:0 24px;">
        <p style="font-family:{self.FONTS['sans']};font-size:11px;font-weight:700;letter-spacing:1.5px;color:{self.COLORS['success']};text-transform:uppercase;margin:0;">🔮 PREDICTION</p>
        <p style="font-family:{self.FONTS['sans']};font-size:14px;color:{self.COLORS['text_secondary']};margin:4px 0 16px;">What we think is coming next week</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:{self.COLORS['bg_alt']};border-radius:12px;">
            <tr><td style="padding:20px 24px;">
                <p style="font-family:{self.FONTS['sans']};font-size:16px;line-height:1.6;color:{self.COLORS['text']};margin:0;">{self._escape(prediction)}</p>
            </td></tr>
        </table>
    </td></tr>
</table>'''
        
        questions = stats.get('questions_ingested', 0)
        platforms = stats.get('platform_count', 1)
        
        return f'''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="x-apple-disable-message-reformatting">
    <title>Curiosity Intel - Week {week}</title>
    <style>
        body {{ color-scheme: light; }}
        .dark-card {{ background-color: #000000 !important; }}
        .white-text {{ color: #FFFFFF !important; }}
        .light-gray {{ color: #CCCCCC !important; }}
    </style>
</head>
<body style="margin:0;padding:0;background-color:{self.COLORS['bg_alt']};font-family:{self.FONTS['sans']};color-scheme:light;">
    
    <!-- Preheader -->
    <div style="display:none;max-height:0;overflow:hidden;">🔥 This week's breakout: {self._escape(breakout.get('canonical_question', 'See what curious minds are asking')[:60])}...</div>
    
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:{self.COLORS['bg_alt']};">
        <tr><td align="center" style="padding:24px 16px;">
            
            <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:{self.COLORS['bg']};border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
                <tr><td>
                    
                    <!-- Header -->
                    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
                        <tr><td align="center" style="padding:40px 20px 24px;">
                            <p style="font-family:{self.FONTS['sans']};font-size:28px;font-weight:700;color:{self.COLORS['text']};letter-spacing:-0.5px;margin:0;">🧠 Curiosity Intel</p>
                        </td></tr>
                        <tr><td align="center" style="padding:0 20px;">
                            <p style="font-family:{self.FONTS['sans']};font-size:14px;color:{self.COLORS['text_secondary']};margin:0;">Week {week} &nbsp;•&nbsp; Issue #{issue_number}</p>
                        </td></tr>
                    </table>
                    
                    <!-- Intro -->
                    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:40px;">
                        <tr><td style="padding:0 24px;">
                            <p style="font-family:{self.FONTS['sans']};font-size:17px;line-height:1.6;color:{self.COLORS['text']};margin:0 0 16px;">This week, we analyzed <strong>{questions:,}</strong> questions across <strong>{platforms}</strong> platform(s) to find what curious minds are asking about AI.</p>
                            <p style="font-family:{self.FONTS['sans']};font-size:17px;line-height:1.6;color:{self.COLORS['text_secondary']};margin:0;">Here's what's rising, what's weird, and what's coming next.</p>
                        </td></tr>
                    </table>
                    
                    {breakout_html}
                    {velocity_html}
                    {weird_html}
                    {prediction_html}
                    
                    <!-- Footer -->
                    <table width="100%" cellpadding="0" cellspacing="0" style="background:{self.COLORS['bg_alt']};border-top:1px solid {self.COLORS['border']};">
                        <tr><td style="padding:32px 24px;">
                            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                                <tr><td align="center">
                                    <a href="#" style="display:inline-block;background:{self.COLORS['text']};color:white;font-family:{self.FONTS['sans']};font-size:14px;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:8px;">Share This Issue →</a>
                                </td></tr>
                            </table>
                            <p style="font-family:{self.FONTS['sans']};font-size:12px;color:{self.COLORS['text_secondary']};text-align:center;margin:0;">
                                You're receiving this because you subscribed to Curiosity Intel.<br/>
                                <a href="#" style="color:{self.COLORS['text_secondary']};">Unsubscribe</a> • <a href="#" style="color:{self.COLORS['text_secondary']};">Preferences</a><br/><br/>
                                © {datetime.now().year} Curiosity Intelligence. All rights reserved.
                            </p>
                        </td></tr>
                    </table>
                    
                </td></tr>
            </table>
            
        </td></tr>
    </table>
</body>
</html>'''

    def save_newsletter(self, signals, weird_picks, week, stats, issue_number=1, prediction=None):
        """Save newsletter to files."""
        week_dir = self.output_dir / week.replace("-", "_")
        week_dir.mkdir(parents=True, exist_ok=True)
        
        html_content = self.generate_html(signals, weird_picks, week, stats, issue_number, prediction)
        
        html_path = week_dir / "newsletter.html"
        html_path.write_text(html_content)
        
        json_data = {
            "week": week,
            "issue_number": issue_number,
            "generated_at": datetime.utcnow().isoformat(),
            "stats": stats,
            "breakout": signals[0] if signals else None,
            "velocity_5": signals[1:6] if len(signals) > 1 else signals[:5],
            "weird_pick": weird_picks[0] if weird_picks else None,
            "prediction": prediction,
        }
        
        json_path = week_dir / "newsletter_data.json"
        json_path.write_text(json.dumps(json_data, indent=2, default=str))
        
        return {"html": str(html_path), "json": str(json_path)}


# =============================================================================
# MAIN
# =============================================================================

def main():
    """Generate newsletter from database signals."""
    
    supabase_url = os.environ.get('SUPABASE_URL')
    supabase_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY') or os.environ.get('SUPABASE_KEY')
    
    if not supabase_url or not supabase_key:
        print("❌ Missing Supabase credentials in .env")
        return None
    
    client = create_client(supabase_url, supabase_key)
    
    today = date.today()
    week = f"{today.year}-W{today.isocalendar()[1]:02d}"
    
    print(f"📰 Generating newsletter for week {week}...")
    
    # Fetch signals
    result = client.table('signals').select('*').order('final_score', desc=True).limit(20).execute()
    signals = result.data or []
    print(f"   Found {len(signals)} signals")
    
    if not signals:
        print("⚠️  No signals found. Using sample data...")
        signals = [
            {"canonical_question": "How to use local LLMs to build autonomous agents", "velocity_pct": 127, "tier": "breakout", "question_count": 42},
            {"canonical_question": "Best practices for RAG with vector databases", "velocity_pct": 89, "tier": "strong", "question_count": 38},
            {"canonical_question": "Fine-tuning vs prompting for code generation", "velocity_pct": 72, "tier": "strong", "question_count": 31},
        ]
    else:
        # Transform signals
        formatted = []
        for s in signals:
            formatted.append({
                'canonical_question': s.get('canonical_question', 'N/A'),
                'velocity_pct': (s.get('velocity_score', 0) or 0) * 100,
                'tier': s.get('tier', 'signal'),
                'question_count': s.get('question_count', 0),
            })
        signals = formatted
    
    # Stats
    questions_result = client.table('questions').select('id', count='exact').execute()
    stats = {
        'questions_ingested': questions_result.count or 0,
        'platform_count': 1,
        'signals_detected': len(signals),
    }
    
    # Weird pick
    weird_picks = []
    if len(signals) > 5:
        weird_picks = [signals[-1]]
    
    # Prediction
    prediction = f"Based on velocity trends, expect continued interest in local LLMs and agent frameworks as developers seek more control over their AI infrastructure."
    
    # Generate
    generator = NewsletterGenerator(output_dir="./output")
    result = generator.save_newsletter(
        signals=signals,
        weird_picks=weird_picks,
        week=week,
        stats=stats,
        issue_number=1,
        prediction=prediction,
    )
    
    print(f"\n✅ Newsletter generated!")
    print(f"   HTML: {result['html']}")
    print(f"   JSON: {result['json']}")
    
    if signals:
        print(f"\n📋 Preview:")
        print(f"   BREAKOUT: {signals[0]['canonical_question'][:60]}...")
        print(f"   Velocity: +{signals[0]['velocity_pct']:.0f}%")
    
    return result


if __name__ == "__main__":
    main()
