"""
Editorial Layer — LLM-powered voice for Curiosity Intel

Option B workflow:
  1. generate_editorial_draft() → writes JSON to output/<week>/editorial_draft.json
  2. Human reviews / edits the JSON
  3. Newsletter generator reads the (possibly edited) JSON and builds HTML

Uses OpenAI gpt-4o with structured output to produce every editorial
touchpoint the newsletter needs — intro, breakout analysis, velocity
context, prediction, weird commentary.

Voice: short, opinionated, Georgia-serif energy, quiet confidence.
Think newsletter editor who reads 10,000 AI questions a week and has
earned the right to have opinions.
"""

import os
import json
from datetime import date, datetime
from pathlib import Path
from typing import Optional, Union

from dotenv import load_dotenv
load_dotenv()

from openai import OpenAI


# ─────────────────────────────────────────────────────────
# VOICE DEFINITION (the soul of the newsletter)
# ─────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are the editorial voice of "Curiosity Intel" — a weekly newsletter
that tracks what people are asking about AI across Stack Overflow, Reddit,
CrossValidated, and Data Science forums.

YOUR VOICE:
- Short, opinionated sentences. No fluff. Every word earns its place.
- You sound like a smart friend who reads 10,000 AI questions a week and
  distills them into what actually matters.
- Quiet confidence — you don't hype, you observe patterns and draw insights.
- Occasionally irreverent but never mean. You respect the people asking.
- You use "we" (the newsletter team) not "I".
- Georgia-serif energy: warm, literary, editorial. Not corporate. Not robotic.

RULES:
1. Never use the phrase "in today's rapidly evolving" or any AI slop.
2. Never use more than 2 sentences for any single "why it matters" blurb.
3. Predictions must be FALSIFIABLE — specific enough to be graded right or wrong.
4. The intro should be exactly 2-3 sentences. Hook → observation → tease.
5. Don't explain what AI is. Your readers are practitioners.
6. Use concrete numbers when available. "42 questions" not "many questions."
7. The weird one commentary should be genuinely curious, not dismissive.
8. Write like you're slightly amused by what you found this week.

ANTI-PATTERNS (never do these):
- "Let's dive in" / "Without further ado" / "Stay tuned"
- Bullet-point summaries that just restate the question
- Generic "this is important because AI is changing the world"
- Hedging language: "it seems like", "one could argue"
"""


# ─────────────────────────────────────────────────────────
# EDITORIAL GENERATION
# ─────────────────────────────────────────────────────────

def generate_editorial_draft(
    signals: list,
    stats: dict,
    week: str,
    issue_number: int = 1,
    last_prediction: Optional[dict] = None,
    model: str = "gpt-4o",
) -> dict:
    """
    Call OpenAI to generate all editorial touchpoints for the newsletter.

    Args:
        signals:        List of signal dicts from Supabase (sorted by score)
        stats:          Dict with questions_ingested, platform_count, signals_detected
        week:           Week string like "2026-W06"
        issue_number:   Newsletter issue number
        last_prediction: Previous week's prediction dict (text + grade) or None
        model:          OpenAI model to use

    Returns:
        Dict with all editorial content, ready for human review.
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY not set in environment")

    client = OpenAI(api_key=api_key)

    # Build the data context the LLM sees
    breakout = signals[0] if signals else {}
    velocity_signals = signals[1:6] if len(signals) > 1 else []
    weird_pick = signals[-1] if len(signals) > 3 else None

    signal_context = _build_signal_context(signals, stats, week)
    prediction_context = _build_prediction_context(last_prediction)

    user_prompt = f"""Here is this week's data for Curiosity Intel Issue #{issue_number} ({week}).

{signal_context}

{prediction_context}

Generate the editorial content for this issue. Return a JSON object with EXACTLY these keys:

{{
  "editorial_intro": "2-3 sentence intro. Hook the reader, name the breakout topic, tease what's coming.",

  "breakout_why": "1-2 sentences explaining WHY the #1 signal matters. Not what it is — why it matters NOW.",

  "velocity_whys": [
    "1-2 sentence 'why it matters' for signal #2",
    "1-2 sentence 'why it matters' for signal #3",
    "1-2 sentence 'why it matters' for signal #4",
    "1-2 sentence 'why it matters' for signal #5",
    "1-2 sentence 'why it matters' for signal #6"
  ],

  "weird_commentary": "2-3 sentences about the weird/outlier signal. Be genuinely curious. What does this tell us?",

  "prediction": "A specific, falsifiable prediction for next week. Something we can grade as right or wrong.",

  "prediction_confidence": "low | medium | high",

  "last_prediction_grade": "If we had a prediction last week, grade it: ✅ Hit / ❌ Miss / 🤷 Too early to tell. Include a 1-sentence explanation. If no previous prediction, return null.",

  "stat_of_week_label": "A short label for the stat card (e.g., 'questions about AI asked in 7 days')",

  "subject_line": "Email subject line. Short, curiosity-driven. No clickbait."
}}

Return ONLY valid JSON. No markdown fences. No explanation outside the JSON."""

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.7,
        max_tokens=1500,
        response_format={"type": "json_object"},
    )

    raw = response.choices[0].message.content
    editorial = json.loads(raw)

    # Attach metadata
    editorial["_meta"] = {
        "model": model,
        "generated_at": datetime.utcnow().isoformat(),
        "week": week,
        "issue_number": issue_number,
        "usage": {
            "prompt_tokens": response.usage.prompt_tokens,
            "completion_tokens": response.usage.completion_tokens,
            "total_tokens": response.usage.total_tokens,
        },
        "status": "draft",  # draft → reviewed → published
    }

    return editorial


def _build_signal_context(signals: list, stats: dict, week: str) -> str:
    """Format signal data into a readable context block for the LLM."""
    lines = [
        f"WEEK: {week}",
        f"TOTAL QUESTIONS INGESTED: {stats.get('questions_ingested', 0):,}",
        f"PLATFORMS TRACKED: {stats.get('platform_count', 1)}",
        f"SIGNALS DETECTED: {stats.get('signals_detected', len(signals))}",
        "",
        "─── SIGNALS (ranked by score) ───",
    ]

    for i, s in enumerate(signals):
        rank = i + 1
        q = s.get('canonical_question', 'N/A')
        velocity = s.get('velocity_score', 0) or 0
        velocity_pct = velocity * 100 if velocity < 10 else velocity  # handle both raw and pct
        tier = s.get('tier', 'signal')
        count = s.get('question_count', 0)
        platforms = s.get('platforms', [])
        sample_qs = s.get('sample_questions', [])
        novelty = s.get('novelty_score', 0) or 0
        engagement = s.get('total_engagement', 0) or s.get('engagement', 0) or 0

        lines.append(f"\n#{rank} [{tier.upper()}] {q}")
        lines.append(f"   Velocity: +{velocity_pct:.0f}% | Questions: {count} | Engagement: {engagement}")
        if platforms:
            lines.append(f"   Platforms: {', '.join(platforms)}")
        if sample_qs:
            for sq in sample_qs[:2]:
                lines.append(f"   • {sq}")

    return "\n".join(lines)


def _build_prediction_context(last_prediction: Optional[dict]) -> str:
    """Format last week's prediction for accountability grading."""
    if not last_prediction:
        return "LAST WEEK'S PREDICTION: None (this is our first issue or no prediction was made)."

    text = last_prediction.get("prediction_text", "")
    confidence = last_prediction.get("confidence", "")
    week = last_prediction.get("week", "")

    return f"""LAST WEEK'S PREDICTION ({week}, confidence: {confidence}):
"{text}"

Grade this prediction based on what actually happened in this week's data. Was it right, wrong, or too early to tell?"""


# ─────────────────────────────────────────────────────────
# DRAFT FILE I/O
# ─────────────────────────────────────────────────────────

def save_draft(editorial: dict, output_dir: Union[str, Path]) -> Path:
    """Save editorial draft to JSON for human review."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / "editorial_draft.json"
    path.write_text(json.dumps(editorial, indent=2, ensure_ascii=False))
    return path


def load_draft(output_dir: Union[str, Path]) -> Optional[dict]:
    """Load editorial draft (possibly human-edited) from JSON."""
    path = Path(output_dir) / "editorial_draft.json"
    if not path.exists():
        return None
    return json.loads(path.read_text())


def mark_reviewed(output_dir: Union[str, Path]) -> None:
    """Mark a draft as reviewed (human approved)."""
    draft = load_draft(output_dir)
    if draft and "_meta" in draft:
        draft["_meta"]["status"] = "reviewed"
        draft["_meta"]["reviewed_at"] = datetime.utcnow().isoformat()
        save_draft(draft, output_dir)


def mark_published(output_dir: Union[str, Path]) -> None:
    """Mark a draft as published."""
    draft = load_draft(output_dir)
    if draft and "_meta" in draft:
        draft["_meta"]["status"] = "published"
        draft["_meta"]["published_at"] = datetime.utcnow().isoformat()
        save_draft(draft, output_dir)
