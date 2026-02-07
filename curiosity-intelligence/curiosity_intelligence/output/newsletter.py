"""
Newsletter Template Generator

Generates email-ready HTML newsletters from curiosity signals.

Design Philosophy (Jobs + Ive + Woz):
- Jobs: Obsessive simplicity, emotional connection, "insanely great"
- Ive: Minimalist design, deliberate restraint, quiet confidence  
- Woz: Engineering excellence, clean functionality, works everywhere

Email Compatibility:
- Inline CSS (no external stylesheets)
- Table-based layout (works in Outlook, Gmail, Apple Mail)
- System fonts with fallbacks
- Max-width 600px for mobile
- Tested patterns from Litmus/Email on Acid
"""

from datetime import datetime
from typing import List, Dict, Optional
import html
import json
from pathlib import Path


class NewsletterGenerator:
    """
    Generates email-ready HTML newsletters.
    
    Sections:
    1. BREAKOUT - The #1 signal of the week (hero treatment)
    2. VELOCITY 5 - Top 5 rising signals  
    3. THE WEIRD ONE - Unexpected outlier that caught attention
    4. SPLIT - Where opinion is divided
    5. PREDICTION - What's coming next week
    """
    
    # Apple-inspired color palette
    COLORS = {
        'bg': '#ffffff',
        'bg_alt': '#f5f5f7',
        'text': '#1d1d1f',
        'text_secondary': '#86868b',
        'accent': '#0071e3',
        'accent_hover': '#0077ed',
        'success': '#34c759',
        'warning': '#ff9500',
        'breakout': '#ff375f',
        'border': '#d2d2d7',
    }
    
    # Typography (system fonts for email compatibility)
    FONTS = {
        'sans': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif',
        'mono': 'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
    }
    
    def __init__(self, output_dir: str = "./output"):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
    
    def _escape(self, text: str) -> str:
        """HTML escape text safely."""
        return html.escape(str(text)) if text else ""
    
    def _velocity_badge(self, velocity: float) -> str:
        """Generate velocity badge HTML."""
        if velocity > 100:
            color = self.COLORS['breakout']
            label = f"+{velocity:.0f}%"
        elif velocity > 50:
            color = self.COLORS['success']
            label = f"+{velocity:.0f}%"
        elif velocity > 0:
            color = self.COLORS['warning']
            label = f"+{velocity:.0f}%"
        else:
            color = self.COLORS['text_secondary']
            label = f"{velocity:.0f}%"
        
        return f'''<span style="
            display: inline-block;
            background: {color};
            color: white;
            font-size: 11px;
            font-weight: 600;
            padding: 2px 8px;
            border-radius: 12px;
            letter-spacing: 0.3px;
        ">{label}</span>'''
    
    def _tier_indicator(self, tier: str) -> str:
        """Generate tier indicator."""
        indicators = {
            'breakout': ('🔥', self.COLORS['breakout']),
            'strong': ('⚡', self.COLORS['accent']),
            'signal': ('📈', self.COLORS['success']),
            'noise': ('〰️', self.COLORS['text_secondary']),
        }
        emoji, color = indicators.get(tier.lower(), ('📊', self.COLORS['text_secondary']))
        return emoji
    
    def _generate_header(self, week: str, issue_number: int = 1) -> str:
        """Generate newsletter header."""
        return f'''
<!-- Header -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 32px;">
    <tr>
        <td align="center" style="padding: 40px 20px 24px;">
            <!-- Logo/Brand -->
            <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                    <td style="
                        font-family: {self.FONTS['sans']};
                        font-size: 28px;
                        font-weight: 700;
                        color: {self.COLORS['text']};
                        letter-spacing: -0.5px;
                    ">
                        🧠 Curiosity Intel
                    </td>
                </tr>
            </table>
        </td>
    </tr>
    <tr>
        <td align="center" style="padding: 0 20px;">
            <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                    <td style="
                        font-family: {self.FONTS['sans']};
                        font-size: 14px;
                        color: {self.COLORS['text_secondary']};
                        letter-spacing: 0.5px;
                    ">
                        Week {week} &nbsp;•&nbsp; Issue #{issue_number}
                    </td>
                </tr>
            </table>
        </td>
    </tr>
</table>
'''
    
    def _generate_intro(self, stats: Dict) -> str:
        """Generate intro paragraph."""
        questions = stats.get('questions_ingested', 0)
        platforms = stats.get('platform_count', 2)
        
        return f'''
<!-- Intro -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 40px;">
    <tr>
        <td style="padding: 0 24px;">
            <p style="
                font-family: {self.FONTS['sans']};
                font-size: 17px;
                line-height: 1.6;
                color: {self.COLORS['text']};
                margin: 0 0 16px;
            ">
                This week, we analyzed <strong>{questions:,}</strong> questions across <strong>{platforms}</strong> platforms to find what curious minds are asking about AI.
            </p>
            <p style="
                font-family: {self.FONTS['sans']};
                font-size: 17px;
                line-height: 1.6;
                color: {self.COLORS['text_secondary']};
                margin: 0;
            ">
                Here's what's rising, what's weird, and what's coming next.
            </p>
        </td>
    </tr>
</table>
'''
    
    def _generate_breakout_section(self, signal: Dict) -> str:
        """Generate the BREAKOUT hero section."""
        question = self._escape(signal.get('canonical_question', 'N/A'))
        velocity = signal.get('velocity_pct', 0)
        count = signal.get('question_count', signal.get('sample_count', 0))
        
        return f'''
<!-- BREAKOUT Section -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 48px;">
    <tr>
        <td style="padding: 0 24px;">
            <!-- Section Label -->
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom: 16px;">
                <tr>
                    <td style="
                        font-family: {self.FONTS['sans']};
                        font-size: 11px;
                        font-weight: 700;
                        letter-spacing: 1.5px;
                        color: {self.COLORS['breakout']};
                        text-transform: uppercase;
                    ">
                        🔥 BREAKOUT
                    </td>
                </tr>
            </table>
            
            <!-- Hero Card -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="
                background-color: #1d1d1f;
                border-radius: 16px;
            ">
                <tr>
                    <td style="padding: 32px;">
                        <!-- Question -->
                        <p style="
                            font-family: {self.FONTS['sans']};
                            font-size: 24px;
                            font-weight: 600;
                            line-height: 1.3;
                            color: #ffffff;
                            margin: 0 0 24px;
                            letter-spacing: -0.3px;
                        ">
                            "{question}"
                        </p>
                        
                        <!-- Stats Row -->
                        <table role="presentation" cellpadding="0" cellspacing="0">
                            <tr>
                                <td style="padding-right: 24px;">
                                    <span style="
                                        font-family: {self.FONTS['sans']};
                                        font-size: 32px;
                                        font-weight: 700;
                                        color: {self.COLORS['success']};
                                    ">+{velocity:.0f}%</span>
                                    <br/>
                                    <span style="
                                        font-family: {self.FONTS['sans']};
                                        font-size: 12px;
                                        color: #aaaaaa;
                                        letter-spacing: 0.5px;
                                    ">velocity</span>
                                </td>
                                <td style="padding-right: 24px;">
                                    <span style="
                                        font-family: {self.FONTS['sans']};
                                        font-size: 32px;
                                        font-weight: 700;
                                        color: #ffffff;
                                    ">{count}</span>
                                    <br/>
                                    <span style="
                                        font-family: {self.FONTS['sans']};
                                        font-size: 12px;
                                        color: #aaaaaa;
                                        letter-spacing: 0.5px;
                                    ">questions</span>
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </td>
    </tr>
</table>
'''
    
    def _generate_velocity_section(self, signals: List[Dict]) -> str:
        """Generate the VELOCITY 5 section."""
        rows = ""
        for i, signal in enumerate(signals[:5], 1):
            question = self._escape(signal.get('canonical_question', 'N/A'))
            velocity = signal.get('velocity_pct', 0)
            tier = signal.get('tier', 'signal')
            
            rows += f'''
            <tr>
                <td style="
                    padding: 16px 0;
                    border-bottom: 1px solid {self.COLORS['border']};
                ">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                            <td width="32" valign="top" style="
                                font-family: {self.FONTS['sans']};
                                font-size: 14px;
                                font-weight: 600;
                                color: {self.COLORS['text_secondary']};
                                padding-right: 12px;
                            ">
                                {i}.
                            </td>
                            <td valign="top">
                                <p style="
                                    font-family: {self.FONTS['sans']};
                                    font-size: 15px;
                                    font-weight: 500;
                                    line-height: 1.4;
                                    color: {self.COLORS['text']};
                                    margin: 0 0 6px;
                                ">
                                    {self._tier_indicator(tier)} {question}
                                </p>
                                {self._velocity_badge(velocity)}
                            </td>
                        </tr>
                    </table>
                </td>
            </tr>
'''
        
        return f'''
<!-- VELOCITY 5 Section -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 48px;">
    <tr>
        <td style="padding: 0 24px;">
            <!-- Section Label -->
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom: 16px;">
                <tr>
                    <td style="
                        font-family: {self.FONTS['sans']};
                        font-size: 11px;
                        font-weight: 700;
                        letter-spacing: 1.5px;
                        color: {self.COLORS['accent']};
                        text-transform: uppercase;
                    ">
                        ⚡ VELOCITY 5
                    </td>
                </tr>
                <tr>
                    <td style="
                        font-family: {self.FONTS['sans']};
                        font-size: 14px;
                        color: {self.COLORS['text_secondary']};
                        padding-top: 4px;
                    ">
                        The fastest rising questions this week
                    </td>
                </tr>
            </table>
            
            <!-- Signal List -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                {rows}
            </table>
        </td>
    </tr>
</table>
'''
    
    def _generate_weird_section(self, weird_pick: Dict) -> str:
        """Generate THE WEIRD ONE section."""
        if not weird_pick:
            return ""
        
        question = self._escape(weird_pick.get('canonical_question', weird_pick.get('question', 'N/A')))
        
        return f'''
<!-- THE WEIRD ONE Section -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 48px;">
    <tr>
        <td style="padding: 0 24px;">
            <!-- Section Label -->
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom: 16px;">
                <tr>
                    <td style="
                        font-family: {self.FONTS['sans']};
                        font-size: 11px;
                        font-weight: 700;
                        letter-spacing: 1.5px;
                        color: {self.COLORS['warning']};
                        text-transform: uppercase;
                    ">
                        🤔 THE WEIRD ONE
                    </td>
                </tr>
                <tr>
                    <td style="
                        font-family: {self.FONTS['sans']};
                        font-size: 14px;
                        color: {self.COLORS['text_secondary']};
                        padding-top: 4px;
                    ">
                        Doesn't fit the pattern, but caught our attention
                    </td>
                </tr>
            </table>
            
            <!-- Weird Card -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="
                background: {self.COLORS['bg_alt']};
                border-radius: 12px;
                border-left: 4px solid {self.COLORS['warning']};
            ">
                <tr>
                    <td style="padding: 20px 24px;">
                        <p style="
                            font-family: {self.FONTS['sans']};
                            font-size: 17px;
                            font-weight: 500;
                            line-height: 1.5;
                            color: {self.COLORS['text']};
                            margin: 0;
                            font-style: italic;
                        ">
                            "{question}"
                        </p>
                    </td>
                </tr>
            </table>
        </td>
    </tr>
</table>
'''
    
    def _generate_split_section(self, split_signal: Optional[Dict] = None) -> str:
        """Generate THE SPLIT section (where opinion is divided)."""
        if not split_signal:
            return ""
        
        question = self._escape(split_signal.get('canonical_question', 'N/A'))
        
        return f'''
<!-- THE SPLIT Section -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 48px;">
    <tr>
        <td style="padding: 0 24px;">
            <!-- Section Label -->
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom: 16px;">
                <tr>
                    <td style="
                        font-family: {self.FONTS['sans']};
                        font-size: 11px;
                        font-weight: 700;
                        letter-spacing: 1.5px;
                        color: #af52de;
                        text-transform: uppercase;
                    ">
                        ⚖️ THE SPLIT
                    </td>
                </tr>
                <tr>
                    <td style="
                        font-family: {self.FONTS['sans']};
                        font-size: 14px;
                        color: {self.COLORS['text_secondary']};
                        padding-top: 4px;
                    ">
                        Where the community is divided
                    </td>
                </tr>
            </table>
            
            <!-- Split Card -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="
                background: {self.COLORS['bg_alt']};
                border-radius: 12px;
            ">
                <tr>
                    <td style="padding: 20px 24px;">
                        <p style="
                            font-family: {self.FONTS['sans']};
                            font-size: 17px;
                            font-weight: 500;
                            line-height: 1.5;
                            color: {self.COLORS['text']};
                            margin: 0 0 16px;
                        ">
                            {question}
                        </p>
                        
                        <!-- Split Bar -->
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                            <tr>
                                <td style="
                                    background: {self.COLORS['accent']};
                                    height: 8px;
                                    border-radius: 4px 0 0 4px;
                                    width: 52%;
                                "></td>
                                <td style="
                                    background: #af52de;
                                    height: 8px;
                                    border-radius: 0 4px 4px 0;
                                    width: 48%;
                                "></td>
                            </tr>
                        </table>
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top: 8px;">
                            <tr>
                                <td style="
                                    font-family: {self.FONTS['sans']};
                                    font-size: 12px;
                                    color: {self.COLORS['accent']};
                                ">
                                    Yes: 52%
                                </td>
                                <td align="right" style="
                                    font-family: {self.FONTS['sans']};
                                    font-size: 12px;
                                    color: #af52de;
                                ">
                                    No: 48%
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </td>
    </tr>
</table>
'''
    
    def _generate_prediction_section(self, prediction: Optional[str] = None) -> str:
        """Generate PREDICTION section."""
        if not prediction:
            prediction = "Based on velocity trends, expect questions about AI coding assistants to surge next week as more tools enter the market."
        
        return f'''
<!-- PREDICTION Section -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 48px;">
    <tr>
        <td style="padding: 0 24px;">
            <!-- Section Label -->
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom: 16px;">
                <tr>
                    <td style="
                        font-family: {self.FONTS['sans']};
                        font-size: 11px;
                        font-weight: 700;
                        letter-spacing: 1.5px;
                        color: {self.COLORS['success']};
                        text-transform: uppercase;
                    ">
                        🔮 PREDICTION
                    </td>
                </tr>
                <tr>
                    <td style="
                        font-family: {self.FONTS['sans']};
                        font-size: 14px;
                        color: {self.COLORS['text_secondary']};
                        padding-top: 4px;
                    ">
                        What we think is coming next week
                    </td>
                </tr>
            </table>
            
            <!-- Prediction Card -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="
                background: linear-gradient(135deg, {self.COLORS['success']}15 0%, {self.COLORS['accent']}10 100%);
                background-color: {self.COLORS['bg_alt']};
                border-radius: 12px;
                border: 1px solid {self.COLORS['success']}30;
            ">
                <tr>
                    <td style="padding: 20px 24px;">
                        <p style="
                            font-family: {self.FONTS['sans']};
                            font-size: 16px;
                            font-weight: 400;
                            line-height: 1.6;
                            color: {self.COLORS['text']};
                            margin: 0;
                        ">
                            {self._escape(prediction)}
                        </p>
                    </td>
                </tr>
            </table>
        </td>
    </tr>
</table>
'''
    
    def _generate_footer(self, unsubscribe_url: str = "#") -> str:
        """Generate newsletter footer."""
        year = datetime.now().year
        
        return f'''
<!-- Footer -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="
    background: {self.COLORS['bg_alt']};
    border-top: 1px solid {self.COLORS['border']};
">
    <tr>
        <td style="padding: 32px 24px;">
            <!-- CTA -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px;">
                <tr>
                    <td align="center">
                        <a href="#" style="
                            display: inline-block;
                            background: {self.COLORS['text']};
                            color: white;
                            font-family: {self.FONTS['sans']};
                            font-size: 14px;
                            font-weight: 600;
                            text-decoration: none;
                            padding: 12px 24px;
                            border-radius: 8px;
                        ">
                            Share This Issue →
                        </a>
                    </td>
                </tr>
            </table>
            
            <!-- Social Links -->
            <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin-bottom: 24px;">
                <tr>
                    <td style="padding: 0 8px;">
                        <a href="#" style="
                            font-family: {self.FONTS['sans']};
                            font-size: 13px;
                            color: {self.COLORS['text_secondary']};
                            text-decoration: none;
                        ">Twitter</a>
                    </td>
                    <td style="color: {self.COLORS['border']};">|</td>
                    <td style="padding: 0 8px;">
                        <a href="#" style="
                            font-family: {self.FONTS['sans']};
                            font-size: 13px;
                            color: {self.COLORS['text_secondary']};
                            text-decoration: none;
                        ">LinkedIn</a>
                    </td>
                    <td style="color: {self.COLORS['border']};">|</td>
                    <td style="padding: 0 8px;">
                        <a href="#" style="
                            font-family: {self.FONTS['sans']};
                            font-size: 13px;
                            color: {self.COLORS['text_secondary']};
                            text-decoration: none;
                        ">Website</a>
                    </td>
                </tr>
            </table>
            
            <!-- Legal -->
            <table role="presentation" cellpadding="0" cellspacing="0" align="center">
                <tr>
                    <td style="
                        font-family: {self.FONTS['sans']};
                        font-size: 12px;
                        color: {self.COLORS['text_secondary']};
                        text-align: center;
                        line-height: 1.6;
                    ">
                        You're receiving this because you subscribed to Curiosity Intel.<br/>
                        <a href="{unsubscribe_url}" style="color: {self.COLORS['text_secondary']};">Unsubscribe</a>
                        &nbsp;•&nbsp;
                        <a href="#" style="color: {self.COLORS['text_secondary']};">Preferences</a>
                        <br/><br/>
                        © {year} Curiosity Intelligence. All rights reserved.
                    </td>
                </tr>
            </table>
        </td>
    </tr>
</table>
'''
    
    def generate_html(
        self,
        signals: List[Dict],
        weird_picks: List[Dict],
        week: str,
        stats: Dict,
        issue_number: int = 1,
        prediction: Optional[str] = None,
        split_signal: Optional[Dict] = None,
    ) -> str:
        """
        Generate complete email-ready HTML newsletter.
        
        Args:
            signals: List of signal dicts (top signals)
            weird_picks: List of weird/unexpected signals
            week: Week identifier (YYYY-WNN)
            stats: Pipeline statistics
            issue_number: Newsletter issue number
            prediction: Optional prediction text
            split_signal: Optional "split opinion" signal
            
        Returns:
            Complete HTML string
        """
        # Get breakout (top signal)
        breakout = signals[0] if signals else {}
        
        # Get velocity 5 (next 5 after breakout)
        velocity_5 = signals[1:6] if len(signals) > 1 else signals[:5]
        
        # Get weird pick
        weird_pick = weird_picks[0] if weird_picks else None
        
        # Assemble sections
        header = self._generate_header(week, issue_number)
        intro = self._generate_intro(stats)
        breakout_section = self._generate_breakout_section(breakout) if breakout else ""
        velocity_section = self._generate_velocity_section(velocity_5) if velocity_5 else ""
        weird_section = self._generate_weird_section(weird_pick)
        split_section = self._generate_split_section(split_signal)
        prediction_section = self._generate_prediction_section(prediction)
        footer = self._generate_footer()
        
        # Complete HTML document
        html = f'''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="x-apple-disable-message-reformatting">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>Curiosity Intel - Week {week}</title>
    
    <!--[if mso]>
    <style>
        table {{ border-collapse: collapse; }}
        td {{ font-family: Arial, sans-serif; }}
    </style>
    <![endif]-->
    
    <style>
        /* Reset */
        body, table, td, p, a {{ -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }}
        table, td {{ mso-table-lspace: 0pt; mso-table-rspace: 0pt; }}
        img {{ -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }}
        body {{ margin: 0; padding: 0; width: 100%; height: 100%; }}
        
        /* Dark mode overrides */
        @media (prefers-color-scheme: dark) {{
            .email-bg {{ background-color: #1d1d1f !important; }}
        }}
        
        /* Mobile */
        @media screen and (max-width: 600px) {{
            .email-container {{ width: 100% !important; max-width: 100% !important; }}
            .stack {{ display: block !important; width: 100% !important; }}
        }}
    </style>
</head>
<body style="
    margin: 0;
    padding: 0;
    background-color: {self.COLORS['bg_alt']};
    font-family: {self.FONTS['sans']};
">
    <!-- Preheader (hidden preview text) -->
    <div style="display: none; max-height: 0; overflow: hidden;">
        🔥 This week's breakout: {self._escape(breakout.get('canonical_question', 'See what curious minds are asking')[:60])}...
        &nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
    </div>
    
    <!-- Email Container -->
    <table role="presentation" class="email-bg" width="100%" cellpadding="0" cellspacing="0" style="
        background-color: {self.COLORS['bg_alt']};
    ">
        <tr>
            <td align="center" style="padding: 24px 16px;">
                
                <!-- Main Content -->
                <table role="presentation" class="email-container" width="600" cellpadding="0" cellspacing="0" style="
                    max-width: 600px;
                    background-color: {self.COLORS['bg']};
                    border-radius: 16px;
                    box-shadow: 0 4px 24px rgba(0,0,0,0.08);
                ">
                    <tr>
                        <td>
                            {header}
                            {intro}
                            {breakout_section}
                            {velocity_section}
                            {weird_section}
                            {split_section}
                            {prediction_section}
                            {footer}
                        </td>
                    </tr>
                </table>
                
            </td>
        </tr>
    </table>
</body>
</html>'''
        
        return html
    
    def save_newsletter(
        self,
        signals: List[Dict],
        weird_picks: List[Dict],
        week: str,
        stats: Dict,
        issue_number: int = 1,
        prediction: Optional[str] = None,
        split_signal: Optional[Dict] = None,
    ) -> Dict[str, str]:
        """
        Save newsletter to files.
        
        Returns:
            Dict with file paths
        """
        week_dir = self.output_dir / week.replace("-", "_")
        week_dir.mkdir(parents=True, exist_ok=True)
        
        # Generate HTML
        html_content = self.generate_html(
            signals=signals,
            weird_picks=weird_picks,
            week=week,
            stats=stats,
            issue_number=issue_number,
            prediction=prediction,
            split_signal=split_signal,
        )
        
        # Save HTML
        html_path = week_dir / "newsletter.html"
        html_path.write_text(html_content)
        
        # Save JSON data
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
        
        return {
            "html": str(html_path),
            "json": str(json_path),
        }


# =============================================================================
# CLI Entry Point
# =============================================================================

def generate_sample_newsletter():
    """Generate a sample newsletter for testing."""
    
    # Sample data
    signals = [
        {
            "canonical_question": "How to use local LLMs with LM Studio to build autonomous agents",
            "velocity_pct": 127,
            "tier": "breakout",
            "question_count": 42,
        },
        {
            "canonical_question": "Best practices for RAG with vector databases in production",
            "velocity_pct": 89,
            "tier": "strong",
            "question_count": 38,
        },
        {
            "canonical_question": "Fine-tuning small models vs using large models with prompts",
            "velocity_pct": 72,
            "tier": "strong",
            "question_count": 31,
        },
        {
            "canonical_question": "How to reduce hallucinations in code generation",
            "velocity_pct": 65,
            "tier": "strong",
            "question_count": 28,
        },
        {
            "canonical_question": "MCP protocol for connecting AI agents to external tools",
            "velocity_pct": 58,
            "tier": "signal",
            "question_count": 24,
        },
        {
            "canonical_question": "Cost optimization strategies for OpenAI API calls",
            "velocity_pct": 45,
            "tier": "signal",
            "question_count": 19,
        },
    ]
    
    weird_picks = [
        {
            "canonical_question": "Can AI help me write poetry for my grandmother's 90th birthday?",
            "velocity_pct": 12,
            "tier": "noise",
        }
    ]
    
    split_signal = {
        "canonical_question": "Should AI-generated code require disclosure in open source projects?",
    }
    
    stats = {
        "questions_ingested": 2847,
        "platform_count": 4,
        "signals_detected": 42,
    }
    
    prediction = "Based on velocity patterns, expect a surge in questions about AI coding assistants and IDE integrations next week as GitHub Copilot X and Cursor continue to gain traction."
    
    generator = NewsletterGenerator(output_dir="./output")
    
    result = generator.save_newsletter(
        signals=signals,
        weird_picks=weird_picks,
        week="2026-W06",
        stats=stats,
        issue_number=1,
        prediction=prediction,
        split_signal=split_signal,
    )
    
    print(f"✅ Newsletter generated!")
    print(f"   HTML: {result['html']}")
    print(f"   JSON: {result['json']}")
    
    return result


if __name__ == "__main__":
    generate_sample_newsletter()
