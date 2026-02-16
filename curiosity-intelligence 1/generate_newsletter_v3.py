#!/usr/bin/env python3
"""
Curiosity Intel Newsletter — v3 (Editorial Layer)

Option B workflow:
  Step 1: `python generate_newsletter_v3.py draft`
           → Calls gpt-4o, writes editorial_draft.json for human review
  Step 2:  Human opens editorial_draft.json, edits as needed
  Step 3: `python generate_newsletter_v3.py publish`
           → Reads (edited) draft, builds HTML, saves prediction to DB

Run `python generate_newsletter_v3.py status` to see where you are.

Design: Ive. Voice: Jobs. Engineering: Woz.
"""

import os
import sys
import json
from datetime import date, datetime
from pathlib import Path
import html as html_module

from dotenv import load_dotenv
load_dotenv()

from supabase import create_client

# Local modules
from curiosity_intelligence.output.editorial import (
    generate_editorial_draft,
    save_draft,
    load_draft,
    mark_reviewed,
    mark_published,
)
from curiosity_intelligence.output.predictions import (
    get_last_prediction,
    save_prediction,
    format_for_newsletter,
)


# ─────────────────────────────────────────────────────────
# DESIGN TOKENS (unchanged from v2 — Ive approved)
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
# SUPABASE CLIENT
# ─────────────────────────────────────────────────────────

def get_supabase():
    url = os.environ.get('SUPABASE_URL')
    key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY') or os.environ.get('SUPABASE_KEY')
    if not url or not key:
        print("❌ Missing Supabase credentials in .env")
        sys.exit(1)
    return create_client(url, key)


# ─────────────────────────────────────────────────────────
# DATA FETCHING
# ─────────────────────────────────────────────────────────

def fetch_signals(client) -> list:
    """Fetch signals from Supabase, sorted by score."""
    result = client.table('signals').select('*').order('final_score', desc=True).limit(20).execute()
    return result.data or []


def fetch_stats(client) -> dict:
    """Fetch aggregate stats."""
    questions_result = client.table('questions').select('id', count='exact').execute()
    return {
        'questions_ingested': questions_result.count or 0,
        'platform_count': 1,  # Will grow as we add Reddit, NewsAPI
    }


def prepare_signals(raw_signals: list) -> list:
    """Transform raw DB signals into newsletter-ready format."""
    signals = []
    for s in raw_signals:
        velocity = s.get('velocity_score', 0) or 0
        signals.append({
            'canonical_question': s.get('canonical_question', 'N/A'),
            'velocity_pct': velocity * 100 if velocity < 10 else velocity,
            'velocity_score': velocity,
            'tier': s.get('tier', 'signal'),
            'question_count': s.get('question_count', 0),
            'platforms': s.get('platforms', []),
            'sample_questions': s.get('sample_questions', []),
            'novelty_score': s.get('novelty_score', 0),
            'total_engagement': s.get('engagement', 0) or 0,
            'final_score': s.get('final_score', 0),
        })
    return signals


# ─────────────────────────────────────────────────────────
# STEP 1: DRAFT — generate editorial with LLM
# ─────────────────────────────────────────────────────────

def cmd_draft(week: str, out_dir: Path, issue_number: int = 1):
    """Generate editorial draft using gpt-4o."""
    print(f"📝 Generating editorial draft for {week}...")
    print(f"   Using model: gpt-4o")

    client = get_supabase()

    # Fetch data
    raw_signals = fetch_signals(client)
    stats = fetch_stats(client)
    signals = prepare_signals(raw_signals)

    if not signals:
        print("⚠️  No signals in database. Run the pipeline first.")
        sys.exit(1)

    stats['signals_detected'] = len(signals)
    print(f"   Found {len(signals)} signals, {stats['questions_ingested']:,} questions")

    # Get last week's prediction for grading
    last_pred = get_last_prediction()
    if last_pred:
        print(f"   Found previous prediction from {last_pred.get('week', '?')}: \"{last_pred.get('prediction_text', '')[:60]}...\"")
    else:
        print(f"   No previous prediction found (first issue or none saved)")

    # Call the LLM
    print(f"\n🤖 Calling gpt-4o for editorial voice...")
    editorial = generate_editorial_draft(
        signals=raw_signals,  # Pass raw DB signals so LLM sees all metadata
        stats=stats,
        week=week,
        issue_number=issue_number,
        last_prediction=last_pred,
    )

    # Also save the signals + stats alongside the draft
    editorial["_signals"] = signals
    editorial["_stats"] = stats
    editorial["_last_prediction"] = format_for_newsletter(last_pred) if last_pred else None

    # Save draft
    draft_path = save_draft(editorial, out_dir)
    tokens = editorial.get("_meta", {}).get("usage", {})

    print(f"\n✅ Editorial draft generated!")
    print(f"   File: {draft_path}")
    print(f"   Tokens: {tokens.get('prompt_tokens', '?')} in → {tokens.get('completion_tokens', '?')} out")
    print(f"\n📋 Generated content:")
    print(f"   Subject: {editorial.get('subject_line', 'N/A')}")
    print(f"   Intro: {editorial.get('editorial_intro', 'N/A')[:80]}...")
    print(f"   Breakout why: {editorial.get('breakout_why', 'N/A')[:80]}...")
    print(f"   Prediction: {editorial.get('prediction', 'N/A')[:80]}...")
    print(f"   Weird take: {editorial.get('weird_commentary', 'N/A')[:80]}...")

    print(f"\n👉 NEXT STEP:")
    print(f"   1. Open {draft_path}")
    print(f"   2. Review & edit the editorial content")
    print(f"   3. Run: python generate_newsletter_v3.py publish")

    return editorial


# ─────────────────────────────────────────────────────────
# STEP 2: PUBLISH — build HTML from (edited) draft
# ─────────────────────────────────────────────────────────

def cmd_publish(week: str, out_dir: Path, issue_number: int = 1):
    """Build final HTML from editorial draft, save prediction to DB."""
    draft = load_draft(out_dir)
    if not draft:
        print(f"❌ No editorial draft found at {out_dir}/editorial_draft.json")
        print(f"   Run: python generate_newsletter_v3.py draft")
        sys.exit(1)

    status = draft.get("_meta", {}).get("status", "draft")
    print(f"📰 Publishing newsletter for {week} (draft status: {status})")

    # Extract editorial content
    signals = draft.get("_signals", [])
    stats = draft.get("_stats", {})
    last_pred = draft.get("_last_prediction", None)

    if not signals:
        print("⚠️  No signals in draft. Re-run: python generate_newsletter_v3.py draft")
        sys.exit(1)

    # Merge editorial voice into signals
    breakout_why = draft.get("breakout_why", "")
    velocity_whys = draft.get("velocity_whys", [])
    weird_commentary = draft.get("weird_commentary", "")

    # Attach editorial to signals
    if signals:
        signals[0]["why_it_matters"] = breakout_why
    for i, s in enumerate(signals[1:6]):
        if i < len(velocity_whys):
            s["why_it_matters"] = velocity_whys[i]

    # Build HTML
    html_content = build_newsletter(
        signals=signals,
        week=week,
        stats=stats,
        issue_number=issue_number,
        editorial_intro=draft.get("editorial_intro", ""),
        prediction=draft.get("prediction", ""),
        last_week_prediction=last_pred,
        weird_commentary=weird_commentary,
        stat_label=draft.get("stat_of_week_label", ""),
    )

    # Save HTML
    html_path = out_dir / "newsletter.html"
    html_path.write_text(html_content)

    # Save full data JSON
    json_path = out_dir / "newsletter_data.json"
    json_path.write_text(json.dumps({
        "week": week,
        "issue_number": issue_number,
        "generated_at": datetime.utcnow().isoformat(),
        "stats": stats,
        "signals": signals,
        "editorial": {
            "intro": draft.get("editorial_intro"),
            "breakout_why": breakout_why,
            "velocity_whys": velocity_whys,
            "prediction": draft.get("prediction"),
            "prediction_confidence": draft.get("prediction_confidence"),
            "weird_commentary": weird_commentary,
            "subject_line": draft.get("subject_line"),
            "stat_label": draft.get("stat_of_week_label"),
        },
        "last_prediction": last_pred,
    }, indent=2, default=str))

    # Save prediction to Supabase for future grading
    prediction_text = draft.get("prediction", "")
    confidence = draft.get("prediction_confidence", "medium")
    if prediction_text:
        try:
            save_prediction(
                week=week,
                prediction_text=prediction_text,
                confidence=confidence,
                issue_number=issue_number,
            )
            print(f"   💾 Prediction saved to DB for future grading")
        except Exception as e:
            print(f"   ⚠️  Could not save prediction to DB: {e}")
            print(f"       (Run database/predictions.sql to create the table)")

    # Mark published
    mark_published(out_dir)

    print(f"\n✅ Newsletter published!")
    print(f"   HTML: {html_path}")
    print(f"   JSON: {json_path}")
    print(f"   Subject: {draft.get('subject_line', 'N/A')}")

    # Grade last prediction via editorial LLM output
    grade = draft.get("last_prediction_grade")
    if grade and last_pred:
        print(f"\n📊 Last week's prediction graded: {grade}")

    return str(html_path)


# ─────────────────────────────────────────────────────────
# STATUS — where am I in the workflow?
# ─────────────────────────────────────────────────────────

def cmd_status(week: str, out_dir: Path):
    """Show current workflow status."""
    print(f"📋 Newsletter status for {week}")
    print(f"   Output dir: {out_dir}")

    draft = load_draft(out_dir)
    if not draft:
        print(f"\n   Status: ⏳ NO DRAFT")
        print(f"   Next:   python generate_newsletter_v3.py draft")
        return

    status = draft.get("_meta", {}).get("status", "unknown")
    generated = draft.get("_meta", {}).get("generated_at", "?")
    model = draft.get("_meta", {}).get("model", "?")

    print(f"\n   Draft status:  {status.upper()}")
    print(f"   Generated:     {generated}")
    print(f"   Model:         {model}")
    print(f"   Subject line:  {draft.get('subject_line', 'N/A')}")

    html_path = out_dir / "newsletter.html"
    if html_path.exists():
        print(f"\n   HTML exists:   ✅ {html_path}")
    else:
        print(f"\n   HTML exists:   ❌ Not yet generated")

    if status == "draft":
        print(f"\n   👉 Next: Review {out_dir}/editorial_draft.json")
        print(f"           Then: python generate_newsletter_v3.py publish")
    elif status == "reviewed":
        print(f"\n   👉 Next: python generate_newsletter_v3.py publish")
    elif status == "published":
        print(f"   ✅ Done! Newsletter is ready to send.")


# ─────────────────────────────────────────────────────────
# HTML BUILDER (Ive's design, now with LLM editorial)
# ─────────────────────────────────────────────────────────

def build_newsletter(
    signals: list,
    week: str,
    stats: dict,
    issue_number: int = 1,
    editorial_intro: str = "",
    prediction: str = "",
    last_week_prediction: dict = None,
    weird_commentary: str = "",
    stat_label: str = "",
) -> str:
    """Build the full HTML newsletter with LLM-generated editorial voice."""

    breakout = signals[0] if signals else {}
    velocity_list = signals[1:6] if len(signals) > 1 else []
    weird_pick = signals[-1] if len(signals) > 3 else None

    questions_count = stats.get('questions_ingested', 0)
    platforms = stats.get('platform_count', 1)

    if not stat_label:
        stat_label = "questions about AI asked in 7 days"

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

    # ── EDITORIAL INTRO (LLM-generated) ─────────────────
    if not editorial_intro:
        editorial_intro = "This week's data is in. Here's what stood out."

    intro_html = f'''
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:28px 24px 32px;">
        <p style="font-family:Georgia, 'Times New Roman', serif;font-size:17px;line-height:1.7;color:{COLORS['text']};margin:0;font-style:italic;">{esc(editorial_intro)}</p>
      </td></tr>
    </table>'''

    # ── LAST WEEK'S PREDICTION (accountability) ─────────
    lastweek_html = ""
    if last_week_prediction and last_week_prediction.get("prediction_text"):
        pred_text = esc(last_week_prediction.get("prediction_text", ""))
        grade_display = esc(last_week_prediction.get("grade_display", ""))
        grade_explanation = esc(last_week_prediction.get("grade_explanation", ""))

        grade_color = COLORS['green']
        if "Miss" in grade_display:
            grade_color = COLORS['red']
        elif "early" in grade_display:
            grade_color = COLORS['orange']

        lastweek_html = f'''
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:40px;">
      <tr><td style="padding:0 24px;">
        <p style="font-family:{FONT};font-size:11px;font-weight:700;letter-spacing:1.5px;color:{grade_color};text-transform:uppercase;margin:0 0 12px;">📊 LAST WEEK WE SAID</p>
      </td></tr>
      <tr><td style="padding:0 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:{COLORS['tag_bg']};border-radius:12px;border-left:4px solid {grade_color};">
          <tr><td style="padding:20px 24px;">
            <p style="font-family:{FONT};font-size:15px;line-height:1.6;color:{COLORS['text']};margin:0 0 8px;">&ldquo;{pred_text}&rdquo;</p>
            <p style="font-family:{FONT};font-size:14px;font-weight:600;color:{grade_color};margin:0;">{grade_display}{" — " + grade_explanation if grade_explanation else ""}</p>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:16px 24px 0;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid {COLORS['border']};"></td></tr></table>
      </td></tr>
    </table>'''

    # ── BREAKOUT (LLM-generated why_it_matters) ─────────
    breakout_html = ""
    if breakout:
        q = esc(breakout.get('canonical_question', ''))
        v = breakout.get('velocity_pct', 0)
        c = breakout.get('question_count', 0)
        why = esc(breakout.get('why_it_matters', ''))

        breakout_html = f'''
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:40px;">
      <tr><td style="padding:0 24px;">
        <p style="font-family:{FONT};font-size:11px;font-weight:700;letter-spacing:1.5px;color:{COLORS['red']};text-transform:uppercase;margin:0 0 12px;">🔥 THE BREAKOUT</p>
      </td></tr>
      <tr><td style="padding:0 24px;">
        <p style="font-family:Georgia, 'Times New Roman', serif;font-size:26px;font-weight:700;line-height:1.25;color:{COLORS['text']};margin:0 0 16px;">{q}</p>
      </td></tr>
      <tr><td style="padding:0 24px;">
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

    # ── VELOCITY 5 (LLM-generated why per signal) ───────
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

    # ── THE WEIRD ONE (LLM-generated commentary) ────────
    weird_html = ""
    if weird_pick:
        wq = esc(weird_pick.get('canonical_question', ''))
        wc = esc(weird_commentary) if weird_commentary else "Doesn&rsquo;t fit the pattern. That&rsquo;s why it&rsquo;s interesting."

        weird_html = f'''
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:40px;">
      <tr><td style="padding:0 24px;">
        <p style="font-family:{FONT};font-size:11px;font-weight:700;letter-spacing:1.5px;color:{COLORS['orange']};text-transform:uppercase;margin:0 0 4px;">🤔 THE WEIRD ONE</p>
      </td></tr>
      <tr><td style="padding:0 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:{COLORS['tag_bg']};border-radius:12px;">
          <tr><td style="padding:24px;">
            <p style="font-family:Georgia, 'Times New Roman', serif;font-size:19px;font-weight:400;line-height:1.5;color:{COLORS['text']};margin:0 0 12px;font-style:italic;">&ldquo;{wq}&rdquo;</p>
            <p style="font-family:{FONT};font-size:14px;line-height:1.6;color:{COLORS['text_secondary']};margin:0;">{wc}</p>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:16px 24px 0;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid {COLORS['border']};"></td></tr></table>
      </td></tr>
    </table>'''

    # ── STAT OF THE WEEK ────────────────────────────────
    stat_html = f'''
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:40px;">
      <tr><td style="padding:0 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:{COLORS['text']};border-radius:16px;">
          <tr><td align="center" style="padding:40px 32px;">
            <p style="font-family:{FONT};font-size:11px;font-weight:700;letter-spacing:2px;color:{COLORS['text_secondary']};text-transform:uppercase;margin:0 0 12px;">STAT OF THE WEEK</p>
            <p style="font-family:{FONT};font-size:48px;font-weight:800;color:{COLORS['card']};margin:0 0 8px;letter-spacing:-1px;">{questions_count:,}</p>
            <p style="font-family:{FONT};font-size:15px;color:{COLORS['text_secondary']};margin:0;">{esc(stat_label)}</p>
          </td></tr>
        </table>
      </td></tr>
    </table>'''

    # ── PREDICTION (LLM-generated) ──────────────────────
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

  <div style="display:none;font-size:1px;color:{COLORS['bg']};line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
    🔥 {esc(breakout.get("canonical_question", "This week in AI curiosity")[:90])} — Curiosity Intel #{issue_number}
    &zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:{COLORS['bg']};">
    <tr><td align="center" style="padding:16px;">

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
# CLI
# ─────────────────────────────────────────────────────────

def main():
    today = date.today()
    week = f"{today.year}-W{today.isocalendar()[1]:02d}"
    out_dir = Path("./output") / week.replace("-", "_")
    out_dir.mkdir(parents=True, exist_ok=True)

    command = sys.argv[1] if len(sys.argv) > 1 else "status"

    if command == "draft":
        cmd_draft(week, out_dir)
    elif command == "publish":
        cmd_publish(week, out_dir)
    elif command == "status":
        cmd_status(week, out_dir)
    else:
        print(f"Usage: python generate_newsletter_v3.py [draft|publish|status]")
        print()
        print("  draft   — Generate editorial voice with gpt-4o (writes JSON for review)")
        print("  publish — Build HTML from reviewed editorial draft")
        print("  status  — Show current workflow status")


if __name__ == "__main__":
    main()
