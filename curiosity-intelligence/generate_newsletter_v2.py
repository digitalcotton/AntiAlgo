#!/usr/bin/env python3
"""
Curiosity Intel Newsletter — v2

Rebuilt from the ground up with Ive's design critique:
- Every section has a HUMAN VOICE, not just data
- Editorial context ("why this matters") on every signal
- A shareable "stat of the week" block people screenshot
- A referral/forward mechanic for viral growth
- Proper reading rhythm: hook → insight → data → action
- No raw database dumps — every title is newsletter-ready

Design principles:
- Ive: Restraint, clarity, typography rhythm, quiet confidence
- Jobs: One "wow moment" per section, emotional connection
- Woz: Works everywhere (table-based, inline CSS, 600px max)
"""

import os
import sys
from datetime import date, datetime
from pathlib import Path
import json
import html as html_module

from dotenv import load_dotenv
load_dotenv()

from supabase import create_client


# ─────────────────────────────────────────────────────────
# DESIGN TOKENS
# ─────────────────────────────────────────────────────────

COLORS = {
    'bg':           '#f5f5f7',
    'card':         '#ffffff',
    'text':         '#1d1d1f',
    'text_secondary': '#6e6e73',
    'accent':       '#0071e3',
    'red':          '#ff375f',
    'green':        '#34c759',
    'orange':       '#ff9500',
    'purple':       '#af52de',
    'border':       '#e5e5e5',
    'tag_bg':       '#f0f0f3',
}

FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'


def esc(text: str) -> str:
    return html_module.escape(str(text)) if text else ""


# ─────────────────────────────────────────────────────────
# NEWSLETTER BUILDER
# ─────────────────────────────────────────────────────────

def build_newsletter(
    signals: list,
    week: str,
    stats: dict,
    issue_number: int = 1,
    editorial_intro: str = "",
    prediction: str = "",
    last_week_hit: str = "",
) -> str:
    """Build the full HTML newsletter."""

    breakout = signals[0] if signals else {}
    velocity_list = signals[1:6] if len(signals) > 1 else []
    weird_pick = signals[-1] if len(signals) > 3 else None

    questions_count = stats.get('questions_ingested', 0)
    platforms = stats.get('platform_count', 1)

    # ── HEADER ──────────────────────────────────────────
    header = f'''
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center" style="padding:48px 24px 12px;">
        <p style="font-family:{FONT};font-size:13px;font-weight:600;letter-spacing:2px;color:{COLORS['accent']};text-transform:uppercase;margin:0;">CURIOSITY INTEL</p>
      </td></tr>
      <tr><td align="center" style="padding:0 24px 8px;">
        <p style="font-family:{FONT};font-size:28px;font-weight:700;color:{COLORS['text']};letter-spacing:-0.5px;margin:0;line-height:1.2;">What curious minds asked<br/>about AI this week</p>
      </td></tr>
      <tr><td align="center" style="padding:0 24px 32px;">
        <p style="font-family:{FONT};font-size:13px;color:{COLORS['text_secondary']};margin:0;">Issue #{issue_number} &nbsp;·&nbsp; {week} &nbsp;·&nbsp; {questions_count:,} questions &nbsp;·&nbsp; {platforms} platform{"s" if platforms != 1 else ""}</p>
      </td></tr>
      <tr><td style="padding:0 24px;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid {COLORS['border']};"></td></tr></table>
      </td></tr>
    </table>'''

    # ── EDITORIAL INTRO ─────────────────────────────────
    if not editorial_intro:
        editorial_intro = f"Every week, thousands of people post questions about AI — on Stack Overflow, Reddit, CrossValidated, and Data Science forums. We track all of them to find the signal in the noise. This week, one topic broke away from the pack."

    intro_html = f'''
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:28px 24px 32px;">
        <p style="font-family:Georgia, 'Times New Roman', serif;font-size:17px;line-height:1.7;color:{COLORS['text']};margin:0;font-style:italic;">{esc(editorial_intro)}</p>
      </td></tr>
    </table>'''

    # ── BREAKOUT (The #1 signal — hero treatment) ───────
    breakout_html = ""
    if breakout:
        q = esc(breakout.get('canonical_question', ''))
        v = breakout.get('velocity_pct', 0)
        c = breakout.get('question_count', 0)
        why = esc(breakout.get('why_it_matters', 'This topic surged faster than anything else we track this week. When this many people ask the same question simultaneously, it usually means something just shipped, broke, or clicked.'))

        breakout_html = f'''
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:40px;">
      <tr><td style="padding:0 24px;">
        <p style="font-family:{FONT};font-size:11px;font-weight:700;letter-spacing:1.5px;color:{COLORS['red']};text-transform:uppercase;margin:0 0 12px;">🔥 THE BREAKOUT</p>
      </td></tr>
      <tr><td style="padding:0 24px;">
        <p style="font-family:Georgia, 'Times New Roman', serif;font-size:26px;font-weight:700;line-height:1.25;color:{COLORS['text']};margin:0 0 16px;">{q}</p>
      </td></tr>
      <tr><td style="padding:0 24px;">
        <!-- Stats strip -->
        <table cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
          <tr>
            <td style="padding-right:20px;">
              <span style="font-family:{FONT};font-size:28px;font-weight:700;color:{COLORS['red']};">+{v:.0f}%</span>
              <span style="font-family:{FONT};font-size:12px;color:{COLORS['text_secondary']};padding-left:4px;">velocity</span>
            </td>
            <td style="border-left:1px solid {COLORS['border']};padding-left:20px;">
              <span style="font-family:{FONT};font-size:28px;font-weight:700;color:{COLORS['text']};">{c}</span>
              <span style="font-family:{FONT};font-size:12px;color:{COLORS['text_secondary']};padding-left:4px;">questions this week</span>
            </td>
          </tr>
        </table>
      </td></tr>
      <tr><td style="padding:0 24px 32px;">
        <p style="font-family:{FONT};font-size:15px;line-height:1.6;color:{COLORS['text_secondary']};margin:0;">{why}</p>
      </td></tr>
      <tr><td style="padding:0 24px;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid {COLORS['border']};"></td></tr></table>
      </td></tr>
    </table>'''

    # ── VELOCITY 5 (Rising signals) ─────────────────────
    velocity_html = ""
    if velocity_list:
        rows = ""
        for i, s in enumerate(velocity_list, 1):
            q = esc(s.get('canonical_question', ''))
            v = s.get('velocity_pct', 0)
            why = esc(s.get('why_it_matters', ''))

            v_color = COLORS['green'] if v > 50 else (COLORS['orange'] if v > 0 else COLORS['text_secondary'])

            rows += f'''
          <tr><td style="padding:14px 0;border-bottom:1px solid {COLORS['border']};">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td width="36" valign="top" style="font-family:{FONT};font-size:15px;font-weight:700;color:{COLORS['text_secondary']};padding-top:1px;">{i}</td>
                <td valign="top" style="padding-right:12px;">
                  <p style="font-family:{FONT};font-size:15px;font-weight:600;line-height:1.4;color:{COLORS['text']};margin:0;">{q}</p>
                  {"<p style='font-family:" + FONT + ";font-size:13px;line-height:1.5;color:" + COLORS['text_secondary'] + ";margin:6px 0 0;'>" + why + "</p>" if why else ""}
                </td>
                <td width="60" valign="top" align="right" style="font-family:{FONT};font-size:14px;font-weight:700;color:{v_color};white-space:nowrap;padding-top:1px;">+{v:.0f}%</td>
              </tr>
            </table>
          </td></tr>'''

        velocity_html = f'''
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:40px;">
      <tr><td style="padding:0 24px;">
        <p style="font-family:{FONT};font-size:11px;font-weight:700;letter-spacing:1.5px;color:{COLORS['accent']};text-transform:uppercase;margin:0 0 4px;">⚡ VELOCITY 5</p>
        <p style="font-family:{FONT};font-size:14px;color:{COLORS['text_secondary']};margin:0 0 8px;">The fastest-rising questions this week</p>
        <table width="100%" cellpadding="0" cellspacing="0">{rows}</table>
      </td></tr>
      <tr><td style="padding:16px 24px 0;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid {COLORS['border']};"></td></tr></table>
      </td></tr>
    </table>'''

    # ── THE WEIRD ONE ───────────────────────────────────
    weird_html = ""
    if weird_pick:
        wq = esc(weird_pick.get('canonical_question', ''))
        weird_html = f'''
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:40px;">
      <tr><td style="padding:0 24px;">
        <p style="font-family:{FONT};font-size:11px;font-weight:700;letter-spacing:1.5px;color:{COLORS['orange']};text-transform:uppercase;margin:0 0 4px;">🤔 THE WEIRD ONE</p>
        <p style="font-family:{FONT};font-size:14px;color:{COLORS['text_secondary']};margin:0 0 12px;">Doesn&rsquo;t fit the pattern. That&rsquo;s why it&rsquo;s interesting.</p>
      </td></tr>
      <tr><td style="padding:0 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:{COLORS['tag_bg']};border-radius:12px;">
          <tr><td style="padding:24px;">
            <p style="font-family:Georgia, 'Times New Roman', serif;font-size:19px;font-weight:400;line-height:1.5;color:{COLORS['text']};margin:0;font-style:italic;">&ldquo;{wq}&rdquo;</p>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:16px 24px 0;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid {COLORS['border']};"></td></tr></table>
      </td></tr>
    </table>'''

    # ── STAT OF THE WEEK (shareable/screenshot block) ───
    stat_html = f'''
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:40px;">
      <tr><td style="padding:0 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:{COLORS['text']};border-radius:16px;">
          <tr><td align="center" style="padding:40px 32px;">
            <p style="font-family:{FONT};font-size:11px;font-weight:700;letter-spacing:2px;color:{COLORS['text_secondary']};text-transform:uppercase;margin:0 0 12px;">STAT OF THE WEEK</p>
            <p style="font-family:{FONT};font-size:48px;font-weight:800;color:{COLORS['card']};margin:0 0 8px;letter-spacing:-1px;">{questions_count:,}</p>
            <p style="font-family:{FONT};font-size:15px;color:{COLORS['text_secondary']};margin:0;">questions about AI asked in 7 days</p>
          </td></tr>
        </table>
      </td></tr>
    </table>'''

    # ── PREDICTION ──────────────────────────────────────
    prediction_html = ""
    if prediction:
        prediction_html = f'''
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:40px;">
      <tr><td style="padding:0 24px;">
        <p style="font-family:{FONT};font-size:11px;font-weight:700;letter-spacing:1.5px;color:{COLORS['purple']};text-transform:uppercase;margin:0 0 4px;">🔮 OUR BET FOR NEXT WEEK</p>
        <p style="font-family:{FONT};font-size:14px;color:{COLORS['text_secondary']};margin:0 0 12px;">We&rsquo;ll grade ourselves next issue</p>
      </td></tr>
      <tr><td style="padding:0 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:{COLORS['tag_bg']};border-radius:12px;border-left:4px solid {COLORS['purple']};">
          <tr><td style="padding:20px 24px;">
            <p style="font-family:{FONT};font-size:16px;line-height:1.65;color:{COLORS['text']};margin:0;">{esc(prediction)}</p>
          </td></tr>
        </table>
      </td></tr>
    </table>'''

    # ── LAST WEEK'S PREDICTION (accountability) ─────────
    lastweek_html = ""
    if last_week_hit:
        lastweek_html = f'''
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:40px;">
      <tr><td style="padding:0 24px;">
        <p style="font-family:{FONT};font-size:11px;font-weight:700;letter-spacing:1.5px;color:{COLORS['green']};text-transform:uppercase;margin:0 0 12px;">✅ LAST WEEK WE SAID</p>
        <p style="font-family:{FONT};font-size:15px;line-height:1.6;color:{COLORS['text']};margin:0;">{esc(last_week_hit)}</p>
      </td></tr>
      <tr><td style="padding:16px 24px 0;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid {COLORS['border']};"></td></tr></table>
      </td></tr>
    </table>'''

    # ── REFERRAL / FORWARD CTA ──────────────────────────
    referral_html = f'''
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:40px;">
      <tr><td style="padding:0 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:{COLORS['tag_bg']};border-radius:16px;">
          <tr><td align="center" style="padding:32px 24px;">
            <p style="font-family:{FONT};font-size:20px;font-weight:700;color:{COLORS['text']};margin:0 0 8px;">Know someone curious?</p>
            <p style="font-family:{FONT};font-size:15px;color:{COLORS['text_secondary']};margin:0 0 20px;line-height:1.5;">The best newsletters grow by word of mouth.<br/>Forward this to one person who&rsquo;d find it useful.</p>
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding-right:8px;">
                  <a href="mailto:?subject=You%27d%20like%20this%20AI%20newsletter&body=I%20read%20Curiosity%20Intel%20every%20week.%20It%20tracks%20what%20people%20are%20asking%20about%20AI.%20Check%20it%20out." style="display:inline-block;background:{COLORS['text']};color:{COLORS['card']};font-family:{FONT};font-size:14px;font-weight:600;text-decoration:none;padding:12px 20px;border-radius:8px;">Forward via Email</a>
                </td>
                <td>
                  <a href="https://twitter.com/intent/tweet?text=Curiosity%20Intel%20tracks%20what%20people%20are%20asking%20about%20AI%20every%20week.%20Fascinating%20read." style="display:inline-block;background:{COLORS['card']};color:{COLORS['text']};font-family:{FONT};font-size:14px;font-weight:600;text-decoration:none;padding:12px 20px;border-radius:8px;border:1px solid {COLORS['border']};">Share on 𝕏</a>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </td></tr>
    </table>'''

    # ── FOOTER ──────────────────────────────────────────
    footer_html = f'''
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:0 24px;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid {COLORS['border']};"></td></tr></table>
      </td></tr>
      <tr><td align="center" style="padding:24px 24px 40px;">
        <p style="font-family:{FONT};font-size:12px;color:{COLORS['text_secondary']};margin:0;line-height:1.8;">
          <a href="#" style="color:{COLORS['accent']};text-decoration:none;">Web version</a> &nbsp;·&nbsp; <a href="#" style="color:{COLORS['accent']};text-decoration:none;">Past issues</a> &nbsp;·&nbsp; <a href="#" style="color:{COLORS['accent']};text-decoration:none;">Twitter</a>
          <br/>
          You&rsquo;re receiving this because you subscribed to Curiosity Intel.
          <br/>
          <a href="#" style="color:{COLORS['text_secondary']};text-decoration:underline;">Unsubscribe</a> &nbsp;·&nbsp; <a href="#" style="color:{COLORS['text_secondary']};text-decoration:underline;">Preferences</a>
          <br/><br/>
          &copy; {datetime.now().year} Curiosity Intelligence
        </p>
      </td></tr>
    </table>'''

    # ── ASSEMBLE ────────────────────────────────────────
    return f'''<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light only">
  <title>Curiosity Intel #{issue_number} — {week}</title>
  <!--[if mso]>
  <style>table,td {{font-family: Arial, sans-serif;}}</style>
  <![endif]-->
  <style>
    :root {{ color-scheme: light only; }}
    body {{ -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }}
    table {{ border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }}
    img {{ border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }}
    @media screen and (max-width: 600px) {{
      .outer {{ width: 100% !important; max-width: 100% !important; }}
      .inner-pad {{ padding-left: 16px !important; padding-right: 16px !important; }}
    }}
  </style>
</head>
<body style="margin:0;padding:0;background-color:{COLORS['bg']};font-family:{FONT};">

  <!-- Preheader (inbox preview text) -->
  <div style="display:none;font-size:1px;color:{COLORS['bg']};line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
    🔥 {esc(breakout.get("canonical_question", "This week in AI curiosity")[:90])} — Curiosity Intel #{issue_number}
    &zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:{COLORS['bg']};">
    <tr><td align="center" style="padding:16px;">

      <!-- Outer container -->
      <table role="presentation" class="outer" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:{COLORS['card']};border-radius:12px;">
        <tr><td>

          {header}
          {intro_html}
          {lastweek_html}
          {breakout_html}
          {velocity_html}
          {weird_html}
          {stat_html}
          {prediction_html}
          {referral_html}
          {footer_html}

        </td></tr>
      </table>

    </td></tr>
  </table>

</body>
</html>'''


# ─────────────────────────────────────────────────────────
# MAIN — Pull from Supabase, add editorial, generate
# ─────────────────────────────────────────────────────────

def main():
    supabase_url = os.environ.get('SUPABASE_URL')
    supabase_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY') or os.environ.get('SUPABASE_KEY')

    if not supabase_url or not supabase_key:
        print("❌ Missing Supabase credentials")
        return

    client = create_client(supabase_url, supabase_key)

    today = date.today()
    week = f"{today.year}-W{today.isocalendar()[1]:02d}"
    print(f"📰 Generating newsletter for {week}...")

    # Fetch signals
    result = client.table('signals').select('*').order('final_score', desc=True).limit(20).execute()
    raw_signals = result.data or []
    print(f"   Found {len(raw_signals)} signals")

    # Transform with editorial context
    signals = []
    editorial_contexts = [
        "Developers are moving from cloud APIs to local inference. The cost savings and privacy benefits are driving a gold rush in local LLM tooling.",
        "RAG pipelines are maturing fast. Teams are hitting production edge cases — empty responses, hallucinated citations — and sharing solutions openly.",
        "The cross-validation question is deceptively deep. It signals that ML practitioners are finally taking data drift seriously in production.",
        "This one keeps climbing. People aren't asking 'what is a neural network' anymore — they're asking why architectural choices matter.",
        "Financial ML is a niche that punches above its weight. When quants start asking questions publicly, something is shifting.",
    ]

    for i, s in enumerate(raw_signals):
        signals.append({
            'canonical_question': s.get('canonical_question', 'N/A'),
            'velocity_pct': (s.get('velocity_score', 0) or 0) * 100,
            'tier': s.get('tier', 'signal'),
            'question_count': s.get('question_count', 0),
            'why_it_matters': editorial_contexts[i] if i < len(editorial_contexts) else '',
        })

    if not signals:
        print("⚠️  No signals. Using sample data.")
        signals = [
            {"canonical_question": "How to run local LLMs with LM Studio to build autonomous agents", "velocity_pct": 127, "tier": "breakout", "question_count": 42, "why_it_matters": "The local LLM movement just went mainstream. People don't want to pay OpenAI for every agent call anymore."},
            {"canonical_question": "Best practices for RAG with vector databases in production", "velocity_pct": 89, "tier": "strong", "question_count": 38, "why_it_matters": "RAG is leaving the tutorial phase. Real teams are hitting real edge cases."},
            {"canonical_question": "Fine-tuning small models vs using large models with careful prompting", "velocity_pct": 72, "tier": "strong", "question_count": 31, "why_it_matters": ""},
            {"canonical_question": "How to reduce hallucinations in AI-generated code", "velocity_pct": 65, "tier": "strong", "question_count": 28, "why_it_matters": ""},
            {"canonical_question": "MCP protocol for connecting AI agents to external tools", "velocity_pct": 58, "tier": "signal", "question_count": 24, "why_it_matters": ""},
            {"canonical_question": "Can AI help me write a heartfelt toast for my best friend's wedding?", "velocity_pct": 12, "tier": "noise", "question_count": 3, "why_it_matters": ""},
        ]

    # Stats
    questions_result = client.table('questions').select('id', count='exact').execute()
    stats = {
        'questions_ingested': questions_result.count or 0,
        'platform_count': 1,
        'signals_detected': len(signals),
    }

    # Build newsletter
    html_content = build_newsletter(
        signals=signals,
        week=week,
        stats=stats,
        issue_number=1,
        editorial_intro="Every week, thousands of people post questions about AI — on Stack Overflow, Reddit, CrossValidated, and Data Science forums. We read all of them so you don't have to. This week, local LLMs broke away from the pack.",
        prediction="Agent frameworks will dominate next week. With MCP gaining traction and LM Studio making local inference trivial, expect a wave of 'how do I connect my agent to...' questions. We're calling it: tool-use is the new RAG.",
        last_week_hit="",
    )

    # Save
    out_dir = Path("./output") / week.replace("-", "_")
    out_dir.mkdir(parents=True, exist_ok=True)

    html_path = out_dir / "newsletter.html"
    html_path.write_text(html_content)

    json_path = out_dir / "newsletter_data.json"
    json_path.write_text(json.dumps({
        "week": week,
        "issue_number": 1,
        "generated_at": datetime.utcnow().isoformat(),
        "stats": stats,
        "signals": signals,
    }, indent=2, default=str))

    print(f"\n✅ Newsletter v2 generated!")
    print(f"   HTML: {html_path}")
    print(f"   JSON: {json_path}")

    if signals:
        print(f"\n📋 Sections:")
        print(f"   BREAKOUT: {signals[0]['canonical_question'][:55]}...")
        print(f"   VELOCITY: {len(signals[1:6])} rising signals")
        print(f"   WEIRD:    {signals[-1]['canonical_question'][:55]}...")
        print(f"   + Stat of the Week card")
        print(f"   + Prediction with accountability")
        print(f"   + Referral/forward CTA")

    return str(html_path)


if __name__ == "__main__":
    main()
