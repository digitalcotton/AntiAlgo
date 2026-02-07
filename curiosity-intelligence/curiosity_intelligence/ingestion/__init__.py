"""
Data Ingestion Module

Fetches questions from various platforms:
- Reddit (via PRAW)
- Stack Exchange (via public API)
- Google PAA (via AlsoAsked API)
"""

from .base import BaseIngester
from .reddit import RedditIngester
from .stackexchange import StackExchangeIngester

__all__ = [
    "BaseIngester",
    "RedditIngester", 
    "StackExchangeIngester",
]
