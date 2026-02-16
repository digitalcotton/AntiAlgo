# News Correlation Specification

## Purpose

**Automatically explain WHY curiosity is spiking.**

When a signal shows sudden velocity (+100% or more), we search for news events that might have triggered it. This adds context and makes the newsletter more valuable.

## How It Works

```
Signal Spike → Extract Keywords → Search NewsAPI → Match & Score → Return Trigger
```

### 1. Keyword Extraction

From the canonical question, extract:

1. **Known entities** (highest priority)
   ```
   "ChatGPT", "GPT-4", "Claude", "Gemini", "OpenAI", "Anthropic"...
   ```

2. **Quoted phrases**
   ```
   "How do I use 'Artifacts' in Claude?"
   → Extract: "Artifacts"
   ```

3. **Capitalized words** (proper nouns)
   ```
   "Is Devin AI really worth it?"
   → Extract: "Devin AI"
   ```

### 2. News Search

Using [NewsAPI.org](https://newsapi.org):

```python
params = {
    "q": '"Claude" OR "GPT-4" OR "Anthropic"',
    "from": "2024-01-08",  # 7 days before spike
    "to": "2024-01-15",    # Week of spike
    "sortBy": "relevancy",
    "language": "en",
    "pageSize": 10,
}
```

### 3. Relevance Scoring

Match question keywords against article title/description:

```python
def calc_relevance(question, article):
    question_words = set(extract_words(question))
    title_words = set(extract_words(article.title))
    
    # Title matches worth 2x
    title_matches = len(question_words & title_words) * 2
    
    # Description matches worth 1x
    desc_matches = len(question_words & desc_words)
    
    return min(1.0, (title_matches + desc_matches) / len(question_words))
```

### 4. Output

```json
{
  "headline": "Anthropic Releases Claude 3.5 Sonnet, Claims It Beats GPT-4",
  "source": "TechCrunch",
  "url": "https://techcrunch.com/2024/01/15/anthropic-claude-3.5-sonnet",
  "published_at": "2024-01-15T10:00:00Z",
  "relevance_score": 0.85
}
```

## NewsAPI Integration

### API Details

| Property | Value |
|----------|-------|
| Endpoint | `https://newsapi.org/v2/everything` |
| Rate Limit | 100 requests/day (free) |
| Lookback | Up to 1 month |
| Languages | 14 supported |

### Cost

| Plan | Price | Requests |
|------|-------|----------|
| Free | $0 | 100/day |
| Developer | $449/mo | 250,000/mo |

For MVP, free tier is sufficient (10 signals × 7 days = 70 requests/week).

## Edge Cases

| Case | Handling |
|------|----------|
| No news found | `news_trigger: null` |
| Multiple matches | Return highest relevance |
| Stale news (>7 days old) | Lower weight, still include |
| Generic question | Skip correlation if no entities extracted |
| API rate limit | Queue and retry with exponential backoff |

## Configuration

```python
class NewsCorrelator:
    API_BASE = "https://newsapi.org/v2"
    LOOKBACK_DAYS = 7
    MIN_RELEVANCE = 0.3  # Ignore low-quality matches
    MAX_ARTICLES = 10    # Fetch limit
```

## Example

### Input Signal
```
Question: "Is Claude 3.5 Sonnet really faster than GPT-4?"
Velocity: +180%
Week: 2024-W03
```

### Keyword Extraction
```
["Claude 3.5 Sonnet", "GPT-4"]
```

### News Search Query
```
"Claude 3.5 Sonnet" OR "GPT-4"
from: 2024-01-08
to: 2024-01-21
```

### Results
```json
[
  {
    "title": "Anthropic's Claude 3.5 Sonnet Outperforms GPT-4 on Coding Benchmarks",
    "source": "The Verge",
    "publishedAt": "2024-01-17T14:30:00Z",
    "relevance": 0.92
  },
  {
    "title": "OpenAI Responds to Claude 3.5 with GPT-4 Turbo Updates",
    "source": "Ars Technica", 
    "publishedAt": "2024-01-18T09:00:00Z",
    "relevance": 0.78
  }
]
```

### Output
```json
{
  "news_trigger": {
    "headline": "Anthropic's Claude 3.5 Sonnet Outperforms GPT-4 on Coding Benchmarks",
    "source": "The Verge",
    "url": "https://theverge.com/...",
    "published_at": "2024-01-17T14:30:00Z",
    "relevance_score": 0.92
  }
}
```

## Future Enhancements

1. **Multiple triggers**: Show top 3 news articles
2. **Social media**: Track Twitter/X mentions
3. **Product launches**: Monitor ProductHunt, HackerNews
4. **Earnings calls**: Detect company announcements
5. **Research papers**: ArXiv alerts for technical topics
