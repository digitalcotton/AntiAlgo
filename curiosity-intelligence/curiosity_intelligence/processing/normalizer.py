"""
Question Normalizer

Cleans and standardizes question text for consistent embedding.
"""

import re
from typing import Optional


class QuestionNormalizer:
    """
    Normalizes questions from different platforms into a consistent format.
    
    Steps:
    1. Remove platform-specific artifacts (flairs, tags, markdown)
    2. Expand common abbreviations
    3. Normalize whitespace
    4. Lowercase (optional, for embedding)
    """
    
    # Platform-specific patterns to remove
    PLATFORM_ARTIFACTS = {
        "reddit": [
            r"^\[.*?\]\s*",           # [Discussion], [Help], etc.
            r"\s*\[.*?\]\s*$",         # Trailing flairs
            r"\(x-?post.*?\)",         # Cross-post mentions
            r"/r/\w+",                 # Subreddit references
            r"u/\w+",                  # User references
            r"edit\d*:.*$",            # Edits
        ],
        "stackexchange": [
            r"\[closed\]",
            r"\[duplicate\]",
            r"\[on hold\]",
            r"\[migrated\]",
        ],
    }
    
    # Common AI abbreviations to expand
    ABBREVIATIONS = {
        r"\bgpt\b": "GPT",
        r"\bgpt-?4\b": "GPT-4",
        r"\bgpt-?3\.?5\b": "GPT-3.5",
        r"\bllm\b": "large language model",
        r"\bllms\b": "large language models",
        r"\bml\b": "machine learning",
        r"\bai\b": "artificial intelligence",
        r"\bnlp\b": "natural language processing",
        r"\brag\b": "retrieval augmented generation",
        r"\bapi\b": "API",
        r"\beli5\b": "explain like I'm 5",
    }
    
    # Markdown patterns to clean
    MARKDOWN_PATTERNS = [
        r"\*\*(.*?)\*\*",   # Bold
        r"\*(.*?)\*",       # Italic
        r"~~(.*?)~~",       # Strikethrough
        r"`(.*?)`",         # Inline code
        r"\[([^\]]+)\]\([^)]+\)",  # Links - keep text, remove URL
    ]
    
    def normalize(
        self, 
        text: str, 
        platform: Optional[str] = None,
        lowercase: bool = False,
    ) -> str:
        """
        Normalize a question for embedding.
        
        Args:
            text: Raw question text
            platform: Source platform (reddit, stackexchange)
            lowercase: Whether to lowercase output
            
        Returns:
            Cleaned, normalized question text
        """
        if not text:
            return ""
        
        result = text.strip()
        
        # Remove platform-specific artifacts
        if platform and platform in self.PLATFORM_ARTIFACTS:
            for pattern in self.PLATFORM_ARTIFACTS[platform]:
                result = re.sub(pattern, "", result, flags=re.IGNORECASE)
        
        # Clean markdown
        for pattern in self.MARKDOWN_PATTERNS:
            result = re.sub(pattern, r"\1", result)
        
        # Expand abbreviations (case insensitive)
        for abbrev, expansion in self.ABBREVIATIONS.items():
            result = re.sub(abbrev, expansion, result, flags=re.IGNORECASE)
        
        # Normalize whitespace
        result = " ".join(result.split())
        
        # Remove excessive punctuation
        result = re.sub(r"\?{2,}", "?", result)
        result = re.sub(r"!{2,}", "!", result)
        result = re.sub(r"\.{3,}", "...", result)
        
        # Ensure ends with question mark if it's a question
        if self._is_question_structure(result) and not result.endswith("?"):
            result = result.rstrip(".!") + "?"
        
        if lowercase:
            result = result.lower()
        
        return result.strip()
    
    def _is_question_structure(self, text: str) -> bool:
        """Check if text has question structure."""
        question_starters = (
            "what", "why", "how", "when", "where", "who", "which",
            "can", "could", "would", "should", "will", "is", "are",
            "do", "does", "has", "have", "am", "was", "were",
        )
        first_word = text.lower().split()[0] if text.split() else ""
        return first_word in question_starters or "?" in text
    
    def extract_key_entities(self, text: str) -> list:
        """
        Extract key entities from question for news correlation.
        
        Returns list of potential search terms.
        """
        # Simple extraction - product names, companies, technologies
        entities = []
        
        # Known AI entities
        known_entities = [
            "ChatGPT", "GPT-4", "GPT-3.5", "Claude", "Gemini", "Bard",
            "OpenAI", "Anthropic", "Google", "Microsoft", "Meta",
            "LangChain", "LlamaIndex", "Hugging Face", "Ollama",
            "Stable Diffusion", "Midjourney", "DALL-E", "Sora",
            "Copilot", "Cursor", "Devin",
        ]
        
        text_lower = text.lower()
        for entity in known_entities:
            if entity.lower() in text_lower:
                entities.append(entity)
        
        return entities
