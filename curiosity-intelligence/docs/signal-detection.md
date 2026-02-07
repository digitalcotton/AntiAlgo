# Signal Detection Specification

## The Formula

```
Signal Score = (Velocity × 0.35) + (CrossPlatform × 0.25) + 
               (Engagement × 0.20) + (Novelty × 0.20) + 
               Weirdness Bonus

Where:
- Each component is normalized to 0-1
- Weirdness Bonus adds up to +0.20 for unexpected patterns
- Final score capped at 1.0
```

## Component Breakdown

### 1. Velocity (35% weight)

**What it measures**: Week-over-week growth rate

```python
velocity_pct = ((this_week - last_week) / last_week) * 100

# Normalized score
if velocity_pct >= 100%:  score = 1.0   # Doubled or more
elif velocity_pct >= 0%:  score = 0.5 + (pct / 200)
else:                     score = max(0, 0.5 + (pct / 100))
```

| Week-over-Week | Score |
|----------------|-------|
| +200% or more | 1.0 |
| +100% (doubled) | 1.0 |
| +50% | 0.75 |
| 0% (flat) | 0.5 |
| -25% | 0.25 |
| -50% or worse | 0.0 |

**Why 35%**: Velocity is the strongest predictor of breakout trends.

### 2. Cross-Platform (25% weight)

**What it measures**: How many platforms are asking the same question

```python
if platforms >= 3: score = 1.0
elif platforms == 2: score = 0.7
else: score = 0.0
```

| Platforms | Score | Interpretation |
|-----------|-------|----------------|
| 3+ | 1.0 | 🔥 Universal curiosity |
| 2 | 0.7 | ⭐ Strong signal |
| 1 | 0.0 | Platform-specific |

**Why 25%**: Cross-platform consensus is our differentiator.

### 3. Engagement (20% weight)

**What it measures**: Total upvotes + comments normalized across all clusters

```python
score = min(1.0, cluster.total_engagement / max_engagement)
```

Normalized against the highest-engagement cluster that week.

**Why 20%**: Engagement validates interest but can be gamed.

### 4. Novelty (20% weight)

**What it measures**: Is this a new question or recurring?

```python
if never_seen_before: score = 1.0
elif seen_last_week:  score = 0.3
```

| Status | Score |
|--------|-------|
| First time seeing this pattern | 1.0 |
| Seen in previous weeks | 0.3 |

**Why 20%**: New questions are more interesting for a newsletter.

### 5. Weirdness Bonus (up to +20%)

**What it measures**: Unexpected or counterintuitive patterns

Triggers:
- **3+ platforms agree** on an obscure question: +20%
- **High engagement per question** (avg > 50): +10%
- **Technical question trends on general platform**: +10%

```python
if platforms >= 3:
    weirdness = 0.20
elif avg_engagement > 50:
    weirdness = 0.10
else:
    weirdness = 0.0
```

## Signal Tiers

| Tier | Score Range | Emoji | Meaning |
|------|-------------|-------|---------|
| **Breakout** | ≥ 0.85 | 🔥 | Major trend, lead story |
| **Strong** | ≥ 0.75 | ⭐ | Significant signal |
| **Signal** | ≥ 0.70 | 📊 | Notable, worth including |
| **Noise** | < 0.70 | 📉 | Below threshold |

## Example Calculations

### Example 1: Breakout Signal
```
Question: "Is Claude 3.5 Sonnet better than GPT-4?"

Velocity:     +150% week-over-week = 1.0
CrossPlatform: 3 platforms = 1.0
Engagement:   Top 20% = 0.9
Novelty:      New question = 1.0
Weirdness:    3 platforms on same question = +0.2

Score = (1.0 × 0.35) + (1.0 × 0.25) + (0.9 × 0.20) + (1.0 × 0.20) + 0.2
      = 0.35 + 0.25 + 0.18 + 0.20 + 0.2
      = 1.18 → capped at 1.0

Tier: 🔥 BREAKOUT
```

### Example 2: Strong Signal
```
Question: "How to fine-tune Llama 3?"

Velocity:     +80% = 0.9
CrossPlatform: 2 platforms = 0.7
Engagement:   Top 40% = 0.6
Novelty:      Seen last week = 0.3
Weirdness:    None = 0.0

Score = (0.9 × 0.35) + (0.7 × 0.25) + (0.6 × 0.20) + (0.3 × 0.20)
      = 0.315 + 0.175 + 0.12 + 0.06
      = 0.67

Tier: 📉 NOISE (just below threshold)
```

### Example 3: Weird Pick
```
Question: "Can AI predict lottery numbers?"

Velocity:     +20% = 0.6
CrossPlatform: 1 platform = 0.0
Engagement:   Low = 0.2
Novelty:      New = 1.0
Weirdness:    Unusual question = +0.15

Score = (0.6 × 0.35) + (0.0 × 0.25) + (0.2 × 0.20) + (1.0 × 0.20) + 0.15
      = 0.21 + 0 + 0.04 + 0.20 + 0.15
      = 0.60

Tier: 📉 NOISE - but flagged as WEIRD PICK
```

## Output Format

```json
{
  "question": "Is Claude 3.5 Sonnet better than GPT-4?",
  "score": 0.92,
  "tier": "breakout",
  "is_signal": true,
  "velocity_pct": 150.0,
  "platforms": ["reddit", "stackexchange", "google_paa"],
  "platform_count": 3,
  "question_count": 47,
  "engagement": 2450,
  "breakdown": {
    "velocity": 1.0,
    "cross_platform": 1.0,
    "engagement": 0.9,
    "novelty": 1.0,
    "weirdness": 0.2
  },
  "news_trigger": {
    "headline": "Anthropic Releases Claude 3.5 Sonnet",
    "source": "TechCrunch",
    "url": "https://...",
    "published_at": "2024-01-15T10:00:00Z"
  },
  "sample_questions": [
    "Is Claude 3.5 Sonnet better than GPT-4?",
    "Claude 3.5 vs GPT-4 for coding?",
    "Should I switch from ChatGPT to Claude?"
  ]
}
```
