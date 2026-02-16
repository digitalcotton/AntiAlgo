"""
Base Ingester

Abstract base class for all data source ingesters.
"""

from abc import ABC, abstractmethod
from datetime import datetime
from typing import List
from dataclasses import dataclass


@dataclass
class IngestedQuestion:
    """A question ingested from a platform."""
    external_id: str
    platform: str
    raw_text: str
    source_url: str
    upvotes: int = 0
    comments: int = 0
    views: int = 0
    external_created_at: datetime = None
    metadata: dict = None
    
    def to_dict(self) -> dict:
        return {
            "external_id": self.external_id,
            "platform": self.platform,
            "raw_text": self.raw_text,
            "source_url": self.source_url,
            "upvotes": self.upvotes,
            "comments": self.comments,
            "views": self.views,
            "external_created_at": self.external_created_at,
            "metadata": self.metadata or {},
        }


class BaseIngester(ABC):
    """
    Abstract base class for platform ingesters.
    
    Each ingester must implement:
    - ingest(): Fetch questions from the platform
    - _is_question(): Determine if a post is a question
    """
    
    platform_name: str = "unknown"
    
    @abstractmethod
    async def ingest(self, since: datetime) -> List[IngestedQuestion]:
        """
        Fetch questions from the platform.
        
        Args:
            since: Only fetch questions posted after this datetime
            
        Returns:
            List of IngestedQuestion objects
        """
        pass
    
    @abstractmethod
    def _is_question(self, text: str) -> bool:
        """
        Determine if a piece of text is likely a question.
        
        Args:
            text: The text to analyze
            
        Returns:
            True if this looks like a question
        """
        pass
    
    def _clean_text(self, text: str) -> str:
        """Basic text cleaning."""
        if not text:
            return ""
        return text.strip()
