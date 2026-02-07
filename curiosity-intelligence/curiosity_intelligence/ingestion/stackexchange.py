"""
Stack Exchange Ingester

Fetches AI-related questions from Stack Overflow and other Stack Exchange sites.
Uses the public API (no auth required, but rate limited).
"""

import os
from datetime import datetime
from typing import List

import httpx

from .base import BaseIngester, IngestedQuestion


# Stack Exchange sites to query
SITES = [
    "stackoverflow",
    "datascience",
    "ai",
    "stats",
]

# Tags that indicate AI-related questions
AI_TAGS = [
    "chatgpt",
    "openai-api",
    "gpt-4",
    "gpt-3.5-turbo",
    "llm",
    "large-language-model",
    "prompt-engineering",
    "langchain",
    "transformers",
    "huggingface",
    "machine-learning",
    "deep-learning",
    "neural-network",
    "natural-language-processing",
    "nlp",
    "text-generation",
    "embedding",
    "vector-database",
    "rag",
    "fine-tuning",
]

API_BASE = "https://api.stackexchange.com/2.3"


class StackExchangeIngester(BaseIngester):
    """
    Ingests questions from Stack Exchange sites.
    
    Uses the public API with optional API key for higher rate limits.
    API documentation: https://api.stackexchange.com/docs
    """
    
    platform_name = "stackexchange"
    
    def __init__(
        self,
        sites: List[str] = None,
        tags: List[str] = None,
        questions_per_site: int = 100,
    ):
        """
        Initialize Stack Exchange ingester.
        
        Args:
            sites: List of SE sites to query
            tags: AI-related tags to filter by
            questions_per_site: Maximum questions per site
        """
        self.sites = sites or SITES
        self.tags = tags or AI_TAGS
        self.questions_per_site = questions_per_site
        self.api_key = os.environ.get("STACKEXCHANGE_KEY") or os.environ.get("STACKEXCHANGE_API_KEY")
        
        self.client = httpx.AsyncClient(timeout=30.0)
    
    async def ingest(self, since: datetime) -> List[IngestedQuestion]:
        """
        Fetch questions from all configured Stack Exchange sites.
        
        Args:
            since: Only fetch questions created after this time
            
        Returns:
            List of IngestedQuestion objects
        """
        questions = []
        since_timestamp = int(since.timestamp())
        
        print(f"  SE: Querying {len(self.sites)} sites with {len(self.tags)} tags")
        
        for site in self.sites:
            try:
                site_questions = await self._fetch_site(site, since_timestamp)
                print(f"  SE: {site} returned {len(site_questions)} questions")
                questions.extend(site_questions)
            except Exception as e:
                print(f"Error fetching {site}: {e}")
                import traceback
                traceback.print_exc()
                continue
        
        return questions
    
    async def _fetch_site(
        self, 
        site: str, 
        since_timestamp: int,
    ) -> List[IngestedQuestion]:
        """
        Fetch questions from a single Stack Exchange site.
        """
        questions = []
        seen_ids = set()  # Avoid duplicates across tags
        
        # Query each tag separately (SE uses AND for multiple tags, not OR)
        for tag in self.tags:
            params = {
                "site": site,
                "tagged": tag,
                "fromdate": since_timestamp,
                "sort": "activity",
                "order": "desc",
                "pagesize": min(50, self.questions_per_site),
                "filter": "withbody",  # Include question body
            }
            
            if self.api_key:
                params["key"] = self.api_key
            
            try:
                response = await self.client.get(
                    f"{API_BASE}/questions",
                    params=params,
                )
                
                if response.status_code == 200:
                    data = response.json()
                    items = data.get("items", [])
                    
                    for item in items:
                        # Skip duplicates
                        qid = item["question_id"]
                        if qid in seen_ids:
                            continue
                        seen_ids.add(qid)
                        
                        q = self._process_question(item, site)
                        if q:
                            questions.append(q)
                else:
                    print(f"  {site}: HTTP {response.status_code} for {tag}")
                    # Check quota
                    quota = data.get("quota_remaining", 0)
                    if quota < 50:
                        print(f"Warning: SE API quota low ({quota} remaining)")
                        break
                        
            except Exception as e:
                print(f"Error fetching tag {tag} from {site}: {e}")
                continue
        
        return questions
    
    def _process_question(
        self, 
        item: dict, 
        site: str,
    ) -> IngestedQuestion:
        """
        Process a single Stack Exchange question.
        """
        title = self._clean_text(item.get("title", ""))
        
        if not title or not self._is_question(title):
            return None
        
        # Build URL
        if site == "stackoverflow":
            base_url = "https://stackoverflow.com"
        else:
            base_url = f"https://{site}.stackexchange.com"
        
        return IngestedQuestion(
            external_id=str(item["question_id"]),
            platform="stackexchange",
            raw_text=title,
            source_url=f"{base_url}/q/{item['question_id']}",
            upvotes=item.get("score", 0),
            comments=item.get("answer_count", 0),
            views=item.get("view_count", 0),
            external_created_at=datetime.fromtimestamp(item["creation_date"]),
            metadata={
                "site": site,
                "tags": item.get("tags", []),
                "is_answered": item.get("is_answered", False),
                "accepted_answer_id": item.get("accepted_answer_id"),
            }
        )
    
    def _is_question(self, text: str) -> bool:
        """
        For Stack Exchange, everything is a question by definition.
        Just check it's not empty.
        """
        return len(text.strip()) >= 10
    
    async def close(self):
        """Clean up HTTP client."""
        await self.client.aclose()
