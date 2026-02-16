"""
Predictions — save, retrieve, and grade weekly predictions in Supabase.

Simple interface:
  save_prediction(week, text, confidence)  → saves after newsletter publishes
  get_last_prediction()                    → gets most recent ungraded prediction
  get_prediction_for_week(week)            → gets prediction made in a specific week
  grade_prediction(id, grade, explanation)  → grades a past prediction
"""

import os
from datetime import datetime
from typing import Optional

from dotenv import load_dotenv
load_dotenv()

from supabase import create_client


def _get_client():
    """Get Supabase client."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_KEY")
    if not url or not key:
        raise ValueError("Missing SUPABASE_URL or SUPABASE_KEY")
    return create_client(url, key)


def save_prediction(
    week: str,
    prediction_text: str,
    confidence: str = "medium",
    issue_number: Optional[int] = None,
) -> dict:
    """
    Save a new prediction after newsletter publishes.

    Args:
        week:            "2026-W06"
        prediction_text: The falsifiable prediction
        confidence:      "low" | "medium" | "high"
        issue_number:    Newsletter issue number

    Returns:
        The inserted row as a dict.
    """
    client = _get_client()
    row = {
        "week": week,
        "prediction_text": prediction_text,
        "confidence": confidence,
    }
    if issue_number is not None:
        row["issue_number"] = issue_number

    result = client.table("predictions").insert(row).execute()
    return result.data[0] if result.data else {}


def get_last_prediction() -> Optional[dict]:
    """
    Get the most recent prediction (for grading in the next issue).
    Returns None if no predictions exist.
    """
    client = _get_client()
    result = (
        client.table("predictions")
        .select("*")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


def get_prediction_for_week(week: str) -> Optional[dict]:
    """Get the prediction that was made in a specific week."""
    client = _get_client()
    result = (
        client.table("predictions")
        .select("*")
        .eq("week", week)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


def get_ungraded_predictions() -> list:
    """Get all predictions that haven't been graded yet."""
    client = _get_client()
    result = (
        client.table("predictions")
        .select("*")
        .is_("grade", "null")
        .order("created_at", desc=True)
        .execute()
    )
    return result.data or []


def grade_prediction(
    prediction_id: int,
    grade: str,
    explanation: str,
    graded_in_week: str,
) -> dict:
    """
    Grade a past prediction.

    Args:
        prediction_id:  Row ID
        grade:          "hit" | "miss" | "too_early"
        explanation:    1-sentence explanation of why
        graded_in_week: The week we're grading from (e.g., "2026-W07")

    Returns:
        The updated row.
    """
    client = _get_client()
    result = (
        client.table("predictions")
        .update({
            "grade": grade,
            "grade_explanation": explanation,
            "graded_in_week": graded_in_week,
            "graded_at": datetime.utcnow().isoformat(),
        })
        .eq("id", prediction_id)
        .execute()
    )
    return result.data[0] if result.data else {}


def format_for_newsletter(prediction: dict) -> dict:
    """
    Format a graded prediction for the 'Last Week We Said' section.

    Returns:
        {
            "text": "Agent frameworks will dominate...",
            "grade": "✅ Hit",
            "explanation": "Correct — agent questions rose 45%"
        }
    """
    if not prediction:
        return {}

    grade_map = {
        "hit": "✅ Hit",
        "miss": "❌ Miss",
        "too_early": "🤷 Too early to tell",
    }

    return {
        "prediction_text": prediction.get("prediction_text", ""),
        "confidence": prediction.get("confidence", ""),
        "week": prediction.get("week", ""),
        "grade_display": grade_map.get(prediction.get("grade", ""), ""),
        "grade_explanation": prediction.get("grade_explanation", ""),
    }
