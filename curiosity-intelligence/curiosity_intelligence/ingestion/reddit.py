"""
Reddit Ingester

Fetches AI-related questions from Reddit using PRAW.
"""

import os
import re
from datetime import datetime
from typing import List

import praw
from praw.models import Submission

from .base import BaseIngester, IngestedQuestion


# Subreddits to monitor for AI questions
AI_SUBREDDITS = [
    "ChatGPT",           # 3.5M members - main GPT discussion
    "artificial",        # 1.2M - general AI
    "MachineLearning",   # 3M - technical ML
    "LocalLLaMA",        # 350K - self-hosted LLMs
    "ClaudeAI",          # 150K - Claude users
    "singularity",       # 2M - AI future
    "OpenAI",            # 500K - OpenAI news
    "Bard",              # 100K - Google AI
    "midjourney",        # 1M - AI art
    "StableDiffusion",   # 700K - AI art
]

# Question indicators
QUESTION_PATTERNS = [
    r"^\s*(what|why|how|when|where|who|which|can|could|would|should|will|is|are|do|does|has|have)\b",
    r"\?\s*$",
    r"^\s*\[question\]",
    r"^\s*\[help\]",
    r"^\s*eli5",
]


class RedditIngester(BaseIngester):
    """
    Ingests questions from AI-related subreddits.
    
    Uses PRAW (Python Reddit API Wrapper) for authenticated access.
    """
    
    platform_name = "reddit"
    
    def __init__(
        self,
        subreddits: List[str] = None,
        posts_per_subreddit: int = 100,
    ):
        """
        Initialize Reddit ingester.
        
        Args:
            subreddits: List of subreddit names to monitor
            posts_per_subreddit: Maximum posts to fetch per subreddit
        """
        self.subreddits = subreddits or AI_SUBREDDITS
        self.posts_per_subreddit = posts_per_subreddit
        
        # Initialize PRAW
        self.reddit = praw.Reddit(
            client_id=os.environ.get("REDDIT_CLIENT_ID"),
            client_secret=os.environ.get("REDDIT_CLIENT_SECRET"),
            user_agent=os.environ.get(
                "REDDIT_USER_AGENT", 
                "CuriosityIntelligence/1.0"
            ),
        )
    
    async def ingest(self, since: datetime) -> List[IngestedQuestion]:
        """
        Fetch questions from all configured subreddits.
        
        Args:
            since: Only fetch posts created after this time
            
        Returns:
            List of IngestedQuestion objects
        """
        questions = []
        since_timestamp = since.timestamp()
        
        for subreddit_name in self.subreddits:
            try:
                subreddit = self.reddit.subreddit(subreddit_name)
                
                # Fetch hot + new posts
                for post in subreddit.hot(limit=self.posts_per_subreddit // 2):
                    q = self._process_post(post, since_timestamp)
                    if q:
                        questions.append(q)
                
                for post in subreddit.new(limit=self.posts_per_subreddit // 2):
                    q = self._process_post(post, since_timestamp)
                    if q:
                        questions.append(q)
                        
            except Exception as e:
                print(f"Error fetching r/{subreddit_name}: {e}")
                continue
        
        # Deduplicate by post ID
        seen = set()
        unique = []
        for q in questions:
            if q.external_id not in seen:
                seen.add(q.external_id)
                unique.append(q)
        
        return unique
    
    def _process_post(
        self, 
        post: Submission, 
        since_timestamp: float,
    ) -> IngestedQuestion:
        """
        Process a single Reddit post.
        
        Returns:
            IngestedQuestion if valid, None otherwise
        """
        # Skip old posts
        if post.created_utc < since_timestamp:
            return None
        
        # Skip non-questions
        title = self._clean_text(post.title)
        if not self._is_question(title):
            return None
        
        # Skip very short titles
        if len(title) < 15:
            return None
        
        return IngestedQuestion(
            external_id=post.id,
            platform="reddit",
            raw_text=title,
            source_url=f"https://reddit.com{post.permalink}",
            upvotes=post.score,
            comments=post.num_comments,
            external_created_at=datetime.fromtimestamp(post.created_utc),
            metadata={
                "subreddit": post.subreddit.display_name,
                "flair": post.link_flair_text,
                "is_self": post.is_self,
            }
        )
    
    def _is_question(self, text: str) -> bool:
        """
        Determine if text looks like a question.
        
        Args:
            text: The post title
            
        Returns:
            True if this appears to be a question
        """
        text_lower = text.lower()
        
        for pattern in QUESTION_PATTERNS:
            if re.search(pattern, text_lower, re.IGNORECASE):
                return True
        
        return False
