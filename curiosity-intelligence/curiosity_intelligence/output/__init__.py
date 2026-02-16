"""
Output Module

Generates formatted output from signals:
- Markdown digests
- JSON exports
- Social media cards
- Email-ready HTML newsletters
"""

from .digest import DigestGenerator
from .newsletter import NewsletterGenerator
from .editorial import generate_editorial_draft, save_draft, load_draft
from .predictions import save_prediction, get_last_prediction, grade_prediction

__all__ = [
    "DigestGenerator",
    "NewsletterGenerator",
    "generate_editorial_draft",
    "save_draft",
    "load_draft",
    "save_prediction",
    "get_last_prediction",
    "grade_prediction",
]
