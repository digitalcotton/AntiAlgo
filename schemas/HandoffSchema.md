---
name: handoff-schema
description: Standardized format for passing context between agents, including effort/impact data
---

# Agent Handoff Schema

## Purpose

Ensures consistent, complete context transfer between orchestrator and agents, including idea generation requirements and effort/impact scoring.

---

## Handoff Payload

```yaml
handoff:
  id: "uuid-v4"
  timestamp: "ISO-8601"
  
  # Source
  from_agent: "orchestrator | steve-jobs | jony-ive | wozniak"
  
  # Destination
  to_agent: "steve-jobs | jony-ive | wozniak | orchestrator"
  
  # Original user input
  user_idea:
    raw: "string - exact user input"
    interpreted: "string - clarified version"
    constraints: ["array of user-specified constraints"]
  
  # Pipeline position
  phase:
    current: "vision | design | engineering | synthesis"
    sequence: 1  # 1=Jobs, 2=Ive, 3=Woz, 4=Synthesis
  
  # Prior agent outputs
  prior_outputs:
    jobs:
      north_star: "string"
      mvp_features: ["array"]
      non_negotiables: ["array"]
      anti_goals: ["array"]
      verdict:
        simplify: ["array"]
        ten_x: ["array"]
        kill: ["array"]
      generated_ideas: [{ idea object }]
      effort_impact: [{ feature, effort, impact, quadrant }]
    ive:
      design_principles: ["array"]
      screens: [{ name, purpose, key_elements }]
      components: ["array"]
      patterns: ["array"]
      generated_ideas: [{ idea object }]
      effort_impact: [{ feature, effort, impact, quadrant }]
    woz:
      architecture: "string"
      stack: { frontend, backend, database, infra }
      data_model: [{ entity, fields, relationships }]
      risks: ["array"]
      generated_ideas: [{ idea object }]
      effort_impact: [{ feature, effort, impact, quadrant }]
  
  # Memory context
  memory:
    recalled: ["array of relevant past decisions"]
    to_store: ["array of new decisions to commit"]
  
  # Sub-agent results (if invoked)
  sub_agent_outputs:
    market_intel: { ... }
    competitive_recon: { ... }
    gtm_strategist: { ... }
    pattern_scout: { ... }
    design_system_intel: { ... }
    web_scout: { ... }
    dependency_intel: { ... }
  
  # Instructions
  instructions:
    focus: "specific aspect to prioritize"
    skip: ["aspects to skip if already covered"]
    depth: "quick | normal | deep"
    require_ideas: true  # Must generate new ideas
    require_effort_impact: true  # Must score all features
```

---

## Idea Object Schema

```yaml
idea:
  id: "uuid-v4"
  title: "Short descriptive name (3-7 words)"
  description: "What this idea does and why it matters"
  origin: "jobs | ive | woz"
  type: "feature | improvement | pivot | optimization | delight"
  
  # Effort/Impact Scoring
  effort:
    score: 1-5
    rationale: "Why this effort level"
    breakdown:
      design: "hours or 'N/A'"
      engineering: "hours or days"
      testing: "hours or days"
  
  impact:
    score: 1-5
    rationale: "Why this impact level"
    affects:
      - "user segment or metric affected"
  
  quadrant: "quick-win | big-bet | fill-in | money-pit"
  
  # Context
  dependencies: ["what needs to exist first"]
  risks: ["what could go wrong"]
  validation: "how to test if this works"
  
  # Recommendations
  recommendation: "do-now | plan | backlog | kill"
  owner: "jobs | ive | woz | unassigned"
```

---

## Effort/Impact Entry Schema

```yaml
effort_impact_entry:
  item: "Feature or idea name"
  type: "core-feature | idea | improvement | tech-choice"
  origin: "user | jobs | ive | woz"
  
  effort:
    score: 1-5
    breakdown:
      design_days: 0.5
      eng_days: 3
      test_days: 1
    total_days: 4.5
    confidence: "high | medium | low"
    unknowns: ["list of uncertainties"]
  
  impact:
    score: 1-5
    metrics_affected:
      - metric: "activation rate"
        expected_lift: "+15%"
      - metric: "time to value"
        expected_lift: "-50%"
    user_segments: ["segment affected"]
    confidence: "high | medium | low"
  
  quadrant: "quick-win | big-bet | fill-in | money-pit"
  priority_rank: 1-N  # Within quadrant
  
  # Computed
  roi_score: 4.2  # impact / effort ratio
  recommendation: "Phase 1 | Phase 2 | Backlog | Cut"
```

---

## Master Effort/Impact Map Schema

```yaml
master_effort_impact_map:
  generated_at: "ISO-8601"
  idea_id: "reference to user's original idea"
  
  summary:
    total_items: 24
    quick_wins: 8
    big_bets: 5
    fill_ins: 7
    money_pits: 4
    
  quadrants:
    quick_wins:
      - item: "Feature name"
        effort: 2
        impact: 5
        origin: "jobs"
        week: 1
        owner: "eng"
    
    big_bets:
      - item: "Feature name"
        effort: 5
        impact: 5
        origin: "ive"
        phase: 2
        validation_needed: "user testing"
    
    fill_ins:
      - item: "Feature name"
        effort: 1
        impact: 2
        origin: "woz"
        notes: "Do if time permits"
    
    money_pits:
      - item: "Feature name"
        effort: 4
        impact: 1
        origin: "user"  # Sometimes user's ideas end up here
        why_avoid: "Complexity doesn't justify value"
        alternative: "Simpler approach to achieve similar goal"
  
  prioritized_roadmap:
    phase_1:
      name: "Quick Wins"
      timeline: "Week 1-2"
      items: ["list of items from quick_wins"]
    phase_2:
      name: "Core MVP"
      timeline: "Week 3-4"
      items: ["high-impact items requiring more effort"]
    phase_3:
      name: "Big Bets"
      timeline: "Month 2+"
      items: ["validated big bets"]
    backlog:
      items: ["fill-ins for later"]
    
  killed:
    - item: "Feature name"
      original_request: "What user asked for"
      reason: "Why we're not doing it"
      alternative: "What we're doing instead"
```

---

## Example: Complete Handoff with Ideas

```yaml
handoff:
  id: "h-2026-02-04-001"
  timestamp: "2026-02-04T15:00:00Z"
  from_agent: "steve-jobs"
  to_agent: "jony-ive"
  
  user_idea:
    raw: "A tool that helps developers write better commit messages"
    interpreted: "AI-powered commit message generator with team style enforcement"
    constraints:
      - "Must work offline"
      - "VS Code extension preferred"
  
  phase:
    current: "design"
    sequence: 2
  
  prior_outputs:
    jobs:
      north_star: "Make every commit tell a story—automatically"
      mvp_features:
        - "Generate commit message from diff"
        - "Team style templates"
        - "One-click accept/edit"
      non_negotiables:
        - "Works offline"
        - "< 2 second generation"
      
      generated_ideas:
        - id: "idea-001"
          title: "Commit Message Streaks"
          description: "Gamify good commit hygiene with daily streaks and team leaderboards"
          origin: "jobs"
          type: "feature"
          effort:
            score: 2
            rationale: "Simple counter + UI, no complex logic"
          impact:
            score: 4
            rationale: "Drives daily engagement and team adoption"
          quadrant: "quick-win"
          recommendation: "do-now"
        
        - id: "idea-002"
          title: "PR Description Auto-Generate"
          description: "Aggregate commit messages into PR description"
          origin: "jobs"
          type: "feature"
          effort:
            score: 3
            rationale: "Needs GitHub/GitLab API integration"
          impact:
            score: 3
            rationale: "Valuable but not core to commit flow"
          quadrant: "fill-in"
          recommendation: "backlog"
        
        - id: "idea-003"
          title: "Semantic Diff Understanding"
          description: "Understand code semantics, not just text diff"
          origin: "jobs"
          type: "improvement"
          effort:
            score: 5
            rationale: "Requires AST parsing, language-specific"
          impact:
            score: 5
            rationale: "10× better commit messages, true differentiation"
          quadrant: "big-bet"
          recommendation: "plan"
      
      effort_impact:
        - item: "Generate from diff"
          effort: 3
          impact: 5
          quadrant: "big-bet"
          priority_rank: 1
        - item: "Team style templates"
          effort: 2
          impact: 4
          quadrant: "quick-win"
          priority_rank: 1
        - item: "One-click accept"
          effort: 1
          impact: 4
          quadrant: "quick-win"
          priority_rank: 2
  
  instructions:
    focus: "VS Code extension UX"
    require_ideas: true
    require_effort_impact: true
    depth: "normal"
```
