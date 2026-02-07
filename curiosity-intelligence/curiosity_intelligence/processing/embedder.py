"""
Question Embedder

Generates vector embeddings using OpenAI's text-embedding-3-small model.
"""

import os
from typing import List

from openai import AsyncOpenAI


class QuestionEmbedder:
    """
    Generates embeddings for questions using OpenAI API.
    
    Uses text-embedding-3-small:
    - 1536 dimensions
    - $0.02 per 1M tokens
    - Best price/performance for similarity
    """
    
    MODEL = "text-embedding-3-small"
    DIMENSIONS = 1536
    BATCH_SIZE = 100  # OpenAI allows up to 2048
    
    def __init__(self, model: str = None):
        """
        Initialize embedder.
        
        Args:
            model: Override model name (for testing)
        """
        self.model = model or self.MODEL
        self.client = AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    
    async def embed(self, text: str) -> List[float]:
        """
        Generate embedding for a single text.
        
        Args:
            text: Text to embed
            
        Returns:
            1536-dimensional embedding vector
        """
        response = await self.client.embeddings.create(
            model=self.model,
            input=text,
        )
        return response.data[0].embedding
    
    async def embed_batch(self, texts: List[str]) -> List[List[float]]:
        """
        Generate embeddings for multiple texts efficiently.
        
        Args:
            texts: List of texts to embed
            
        Returns:
            List of embedding vectors
        """
        if not texts:
            return []
        
        all_embeddings = []
        
        # Process in batches
        for i in range(0, len(texts), self.BATCH_SIZE):
            batch = texts[i:i + self.BATCH_SIZE]
            
            response = await self.client.embeddings.create(
                model=self.model,
                input=batch,
            )
            
            # Maintain order
            batch_embeddings = [None] * len(batch)
            for item in response.data:
                batch_embeddings[item.index] = item.embedding
            
            all_embeddings.extend(batch_embeddings)
        
        return all_embeddings
    
    @staticmethod
    def cosine_similarity(a: List[float], b: List[float]) -> float:
        """
        Calculate cosine similarity between two vectors.
        
        Args:
            a: First vector
            b: Second vector
            
        Returns:
            Similarity score between -1 and 1
        """
        import math
        
        dot_product = sum(x * y for x, y in zip(a, b))
        magnitude_a = math.sqrt(sum(x * x for x in a))
        magnitude_b = math.sqrt(sum(x * x for x in b))
        
        if magnitude_a == 0 or magnitude_b == 0:
            return 0.0
        
        return dot_product / (magnitude_a * magnitude_b)
