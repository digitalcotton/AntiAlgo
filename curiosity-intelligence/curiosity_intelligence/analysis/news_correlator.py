"""
News Correlator

Finds news events that may have triggered curiosity spikes.
Uses NewsAPI.org for news search.
"""

import os
import re
from datetime import datetime, timedelta
from typing import Optional, List

import httpx


class NewsCorrelator:
    """
    Correlates curiosity signals with news events.
    
    Uses NewsAPI.org to find articles that might explain
    why a particular question is trending.
    """
    
    API_BASE = "https://newsapi.org/v2"
    
    # Keywords that suggest AI news
    AI_KEYWORDS = [
        "AI", "artificial intelligence", "ChatGPT", "OpenAI",
        "Claude", "Anthropic", "Gemini", "Google AI", "GPT-4",
        "machine learning", "large language model", "LLM",
    ]
    
    def __init__(self, api_key: str = None, lookback_days: int = 7):
        """
        Initialize news correlator.
        
        Args:
            api_key: NewsAPI.org API key
            lookback_days: Days to look back for news
        """
        self.api_key = api_key or os.environ.get("NEWSAPI_KEY")
        self.lookback_days = lookback_days
        self.client = httpx.AsyncClient(timeout=30.0)
    
    async def find_trigger(
        self,
        question: str,
        week_start: datetime,
    ) -> Optional[dict]:
        """
        Find news that might have triggered a curiosity spike.
        
        Args:
            question: The canonical question from a signal
            week_start: Start of the week being analyzed
            
        Returns:
            Dict with news trigger info, or None if not found
        """
        if not self.api_key:
            return None
        
        # Extract search terms
        keywords = self._extract_keywords(question)
        if not keywords:
            return None
        
        # Search news
        try:
            articles = await self._search_news(
                keywords,
                from_date=week_start - timedelta(days=self.lookback_days),
                to_date=week_start + timedelta(days=7),
            )
            
            if not articles:
                return None
            
            # Return most relevant article
            best = articles[0]
            return {
                "headline": best.get("title"),
                "source": best.get("source", {}).get("name"),
                "url": best.get("url"),
                "published_at": best.get("publishedAt"),
                "relevance_score": self._calc_relevance(question, best),
            }
            
        except Exception as e:
            print(f"News correlation error: {e}")
            return None
    
    async def _search_news(
        self,
        keywords: List[str],
        from_date: datetime,
        to_date: datetime,
    ) -> List[dict]:
        """
        Search NewsAPI for relevant articles.
        """
        query = " OR ".join(f'"{kw}"' for kw in keywords[:5])  # Max 5 terms
        
        params = {
            "q": query,
            "from": from_date.strftime("%Y-%m-%d"),
            "to": to_date.strftime("%Y-%m-%d"),
            "sortBy": "relevancy",
            "pageSize": 10,
            "language": "en",
            "apiKey": self.api_key,
        }
        
        response = await self.client.get(
            f"{self.API_BASE}/everything",
            params=params,
        )
        
        if response.status_code == 200:
            data = response.json()
            return data.get("articles", [])
        
        return []
    
    def _extract_keywords(self, question: str) -> List[str]:
        """
        Extract search keywords from a question.
        """
        keywords = []
        question_lower = question.lower()
        
        # Check for known AI entities
        known_entities = [
            "ChatGPT", "GPT-4", "GPT-3.5", "Claude", "Gemini", "Bard",
            "OpenAI", "Anthropic", "Google", "Microsoft", "Meta",
            "Copilot", "Midjourney", "Stable Diffusion", "DALL-E", "Sora",
            "LangChain", "Hugging Face", "Ollama", "Llama", "Mistral",
        ]
        
        for entity in known_entities:
            if entity.lower() in question_lower:
                keywords.append(entity)
        
        # Extract quoted phrases
        quotes = re.findall(r'"([^"]+)"', question)
        keywords.extend(quotes)
        
        # If no specific entities, use AI + key nouns
        if not keywords:
            keywords = ["AI"]
            # Extract capitalized words (potential proper nouns)
            caps = re.findall(r'\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b', question)
            keywords.extend(caps[:3])
        
        return keywords[:5]  # Limit to 5
    
    def _calc_relevance(self, question: str, article: dict) -> float:
        """
        Calculate relevance score between question and article.
        """
        title = article.get("title", "").lower()
        description = article.get("description", "").lower()
        question_lower = question.lower()
        
        # Extract key words from question
        words = set(re.findall(r'\b\w{4,}\b', question_lower))
        
        # Count matches
        matches = 0
        for word in words:
            if word in title:
                matches += 2
            if word in description:
                matches += 1
        
        # Normalize
        return min(1.0, matches / (len(words) or 1))
    
    async def batch_correlate(
        self,
        signals: List[dict],
        week_start: datetime,
    ) -> List[dict]:
        """
        Correlate news for multiple signals.
        
        Args:
            signals: List of signal dicts with 'canonical_question'
            week_start: Start of the week
            
        Returns:
            Signals with 'news_trigger' added
        """
        for signal in signals:
            trigger = await self.find_trigger(
                signal.get("canonical_question", signal.get("question", "")),
                week_start,
            )
            signal["news_trigger"] = trigger
        
        return signals
    
    async def close(self):
        """Clean up HTTP client."""
        await self.client.aclose()
