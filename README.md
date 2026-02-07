# TheTeam 🚀

A multi-agent product development studio that transforms ideas into complete, prioritized product specifications.

## What Makes This Different

1. **Multi-Agent Pipeline**: Your idea flows through Vision → Design → Engineering
2. **Idea Generation**: Each agent doesn't just execute—they improve and innovate
3. **Effort/Impact Mapping**: Every feature gets scored and prioritized on a 2×2 matrix
4. **Persistent Memory**: Decisions compound across sessions

---

## Quick Start

### Option 1: Full Pipeline (Recommended)

Talk to the **Orchestrator**:

```
@Orchestrator I want to build [your idea]
```

The orchestrator will:
1. Route through Steve-Jobs (vision + new ideas)
2. Pass to Jony-Ive (design + UX innovations)
3. Hand to Wozniak (engineering + optimizations)
4. Generate Master Effort/Impact Map
5. Deliver prioritized roadmap

### Option 2: Direct Agent Access

Talk to individual agents:

```
@Steve-Jobs Evaluate this product idea: [idea]
@Jony-Ive Design the UX for: [feature]
@Wozniak How should I architect: [system]
```

### Option 3: Sub-Agent Research

For specific research tasks:

```
@MarketIntel What's the market size for [category]?
@CompetitiveRecon Who are the competitors in [space]?
@PatternScout What UI patterns exist for [interaction]?
@DependencyIntel Is [library] safe to use?
```

---

## Modes

| Mode | Trigger | What You Get |
|------|---------|--------------|
| **Quick** | "quick", "fast" | Core spec + simplified E/I map |
| **Normal** | (default) | Full spec + E/I map + ideas |
| **Deep** | "deep", "thorough" | All sub-agents + research + comprehensive analysis |

---

## Real-Time Agent Communication 💬

**All agent-to-agent communication is visible.** Watch the team think, research, and decide in real-time.

### Verbosity Flags

```
@Orchestrator [idea] --verbose=full    # Everything (sub-agent searches too)
@Orchestrator [idea] --verbose=agents  # Main agents only (default)
@Orchestrator [idea] --verbose=summary # Just phase completions
@Orchestrator [idea] --verbose=silent  # Final output only
@Orchestrator [idea] --debug           # Raw handoff payloads
```

### What You'll See

```
═══════════════════════════════════════════════════════════════
  🚀 THE TEAM PIPELINE                              Mode: Deep
═══════════════════════════════════════════════════════════════
  [████████████░░░░░░░░░░░░░░░░░░] 40%
  
  ✅ Phase 1: Vision (Steve-Jobs)     — 45s, 5 ideas
  🔄 Phase 2: Design (Jony-Ive)       — In Progress...
  ⏳ Phase 3: Engineering (Wozniak)   — Pending
  ⏳ Phase 4: Synthesis               — Pending
═══════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────┐
│ 💡 JONY-IVE                                       00:01:23 │
│ Signal: IDEA_GENERATED                                      │
├─────────────────────────────────────────────────────────────┤
│ "Haptic Confirmation Pulse"                                 │
│ Subtle vibration when commit message is accepted            │
│ ⚖️ Effort: 1 | Impact: 4 → 🎯 QUICK WIN                     │
└─────────────────────────────────────────────────────────────┘
```

### Signal Reference

| Emoji | Signal | Meaning |
|-------|--------|---------|
| 📡 | DISPATCH | Task assigned to agent |
| 🔍 | RESEARCH | Sub-agent research request |
| 📊 | DATA | Research results returned |
| 💡 | IDEA | New idea generated |
| ⚖️ | E/I | Effort/Impact scored |
| 🎯 | QUICK_WIN | Low effort, high impact |
| 🚀 | BIG_BET | High effort, high impact |
| ⚔️ | CONFLICT | Agent disagreement |
| 🤝 | RESOLVED | Conflict resolved |
| ✅ | COMPLETE | Phase finished |
| 💾 | MEMORY | Stored to memory |

See [AgentCommsProtocol.md](AgentCommsProtocol.md) for full specification.

---

## Output Capture & Session Reset 📁

**All agent data is saved to files.** Every run produces archived outputs for review.

### Output Structure

```
outputs/
├── runs/                              # Every pipeline run
│   └── 2026-02-05_14-30_curious-newsletter/
│       ├── pipeline_log.md            # Full conversation
│       ├── final_report.md            # Shareable spec
│       ├── run_metadata.json          # Run info
│       ├── effort_impact/             # E/I map (MD + JSON)
│       ├── agents/                    # Each agent's output
│       ├── subagents/                 # Research data (JSON)
│       └── handoffs/                  # Inter-agent payloads
│
├── reports/                           # Shareable final reports
│   └── 2026-02-05_curious-newsletter_report.md
│
└── memory/
    ├── persistent/                    # Survives reset
    │   ├── product_decisions.json     # "We decided X"
    │   ├── architecture_decisions.json
    │   └── constraints.json
    └── session/                       # Cleared on reset
        └── [temporary files]
```

### Session Reset

After each pipeline, the system **resets to start fresh**:

| Data Type | Reset? | Why |
|-----------|--------|-----|
| Session handoffs | ✅ Yes | Prevent contamination |
| Conversation state | ✅ Yes | Fresh context |
| Working calculations | ✅ Yes | Clean slate |
| Product decisions | ❌ No | Intentional persistence |
| Architecture ADRs | ❌ No | Long-term knowledge |
| Past run outputs | ❌ No | Archived for review |

```
┌─────────────────────────────────────────────────────────────┐
│ 🔄 SESSION_RESET                                            │
├─────────────────────────────────────────────────────────────┤
│ ✅ Outputs saved to: outputs/runs/2026-02-05_14-30_...     │
│ ✅ 3 decisions committed to persistent memory               │
│ 🗑️  Session memory cleared                                  │
│ 🆕 Ready for new idea — no prior contamination              │
└─────────────────────────────────────────────────────────────┘
```

See [schemas/OutputSchema.md](schemas/OutputSchema.md) for full specification.

---

## Effort/Impact Framework

Every feature and idea gets scored:

```
                    HIGH IMPACT
                         │
         ┌───────────────┼───────────────┐
         │   🚀 QUICK    │   🎯 BIG      │
         │   WINS        │   BETS        │
         │   Do First    │   Plan Well   │
         │               │               │
LOW ─────┼───────────────┼───────────────┼───── HIGH
EFFORT   │               │               │     EFFORT
         │   📋 FILL-    │   🚫 MONEY    │
         │   INS         │   PITS        │
         │   Do Later    │   Avoid       │
         └───────────────┼───────────────┘
                         │
                    LOW IMPACT
```

### Scoring

| Effort | Meaning |
|--------|---------|
| 1 | < 1 day, trivial |
| 2 | 1-3 days, easy |
| 3 | 1-2 weeks, medium |
| 4 | 2-4 weeks, hard |
| 5 | 1+ month, massive |

| Impact | Meaning |
|--------|---------|
| 1 | Nice-to-have |
| 2 | Some value |
| 3 | Contributes to core |
| 4 | Critical for adoption |
| 5 | Defines the product |

---

## Agent Directory

### Main Agents

| Agent | File | Role |
|-------|------|------|
| **Orchestrator** | `OrchestratorAgent.md` | Pipeline coordinator, E/I synthesis |
| **Steve-Jobs** | `AgentSteveJobsYML.md` | Vision, strategy, market, ideas |
| **Jony-Ive** | `AgentJonyIveYML.md` | Design, UX, craft, innovations |
| **Wozniak** | `AgentWozniakYML.md` | Engineering, architecture, optimizations |

### Sub-Agents (Steve-Jobs)

| Sub-Agent | File | Purpose |
|-----------|------|---------|
| MarketIntel | `subagents/SteveJobs_MarketIntel.md` | Market timing, TAM/SAM, signals |
| CompetitiveRecon | `subagents/SteveJobs_CompetitiveRecon.md` | Competitor analysis, gaps |
| GTMStrategist | `subagents/SteveJobs_GTMStrategist.md` | Positioning, pricing, launch |
| StrategyMemory | `subagents/SteveJobs_StrategyMemory.md` | Strategic decision memory |

### Sub-Agents (Jony-Ive)

| Sub-Agent | File | Purpose |
|-----------|------|---------|
| PatternScout | `subagents/JonyIve_PatternScout.md` | UI/UX pattern research |
| DesignSystemIntel | `subagents/JonyIve_DesignSystemIntel.md` | Components, tokens, a11y |
| NarrativeSignal | `subagents/JonyIve_NarrativeSignal.md` | Copy, voice, naming |
| DesignMemory | `subagents/JonyIve_DesignMemory.md` | Design decision memory |

### Sub-Agents (Wozniak)

| Sub-Agent | File | Purpose |
|-----------|------|---------|
| WebScout | `subagents/Wozniak_WebScout.md` | Technical research |
| SourceTriangulator | `subagents/Wozniak_SourceTriangulator.md` | Fact verification |
| DependencyIntel | `subagents/Wozniak_DependencyIntel.md` | CVEs, versions, security |
| EngineeringMemory | `subagents/Wozniak_EngineeringMemory.md` | ADRs, tech decisions |

---

## File Structure

```
TheTeam/
├── README.md                    # This file
├── OrchestratorAgent.md         # Master coordinator
├── AgentSteveJobsYML.md         # Vision agent
├── AgentJonyIveYML.md           # Design agent
├── AgentWozniakYML.md           # Engineering agent
├── schemas/
│   └── HandoffSchema.md         # Inter-agent communication format
└── subagents/
    ├── SteveJobs_MarketIntel.md
    ├── SteveJobs_CompetitiveRecon.md
    ├── SteveJobs_GTMStrategist.md
    ├── SteveJobs_StrategyMemory.md
    ├── JonyIve_PatternScout.md
    ├── JonyIve_DesignSystemIntel.md
    ├── JonyIve_NarrativeSignal.md
    ├── JonyIve_DesignMemory.md
    ├── Wozniak_WebScout.md
    ├── Wozniak_SourceTriangulator.md
    ├── Wozniak_DependencyIntel.md
    └── Wozniak_EngineeringMemory.md
```

---

## Example Output

When you submit an idea, you get:

### 1. Executive Summary
One-page product overview

### 2. Master Effort/Impact Map
```
🚀 QUICK WINS (Week 1-2)
├── One-click accept (E:1, I:4) - Woz
├── Team style templates (E:2, I:4) - Ive
└── Basic diff parsing (E:2, I:5) - Woz

🎯 BIG BETS (Month 2+)
├── Semantic diff understanding (E:5, I:5) - Woz
└── Multi-repo style sync (E:4, I:4) - Jobs

📋 FILL-INS (Backlog)
├── PR description generation (E:3, I:3) - Jobs
└── Commit history analytics (E:2, I:2) - Ive

🚫 MONEY PITS (Avoid)
└── Full git client features (E:5, I:1) - User idea, redirected
```

### 3. Agent-Generated Ideas
Each agent contributes 3-5 ideas beyond your input

### 4. Full Product Spec
Vision + Design + Engineering details

### 5. Prioritized Roadmap
Week-by-week plan based on E/I quadrants

---

## Memory System

All agents share persistent memory:

| Memory | Contents |
|--------|----------|
| **StrategyMemory** | Product decisions, market insights, bets |
| **DesignMemory** | Patterns, rejected alternatives, rationale |
| **EngineeringMemory** | ADRs, dependencies, post-mortems |

Memory enables:
- Consistent decisions across sessions
- Learning from past projects
- Quick context loading for follow-ups
- Pattern recognition across ideas

---

## Tips for Best Results

1. **Be specific about constraints**: "must work offline", "budget under $100/mo"
2. **State your goals**: "want to validate PMF", "need to ship in 2 weeks"
3. **Use modes**: Say "deep dive" for comprehensive analysis
4. **Iterate**: Ask follow-up questions, agents remember context
5. **Challenge the E/I scores**: If you disagree, discuss with the agent

---

## Example Session

```
User: @Orchestrator I want to build a tool that helps developers 
      write better commit messages. I need to validate this idea 
      quickly—give me a thorough analysis.

Orchestrator: 🚀 Initiating TheTeam Pipeline (Deep Mode)

📍 Phase 1: Vision (Steve-Jobs)
   ├─ MarketIntel researching...
   ├─ CompetitiveRecon mapping landscape...
   └─ ✓ Vision complete + 4 new ideas generated

📍 Phase 2: Design (Jony-Ive)
   ├─ PatternScout finding UI patterns...
   ├─ DesignSystemIntel checking components...
   └─ ✓ Design complete + 3 UX innovations

📍 Phase 3: Engineering (Wozniak)
   ├─ WebScout researching tech options...
   ├─ DependencyIntel checking stack...
   └─ ✓ Architecture complete + 3 optimizations

📍 Phase 4: Synthesis
   └─ ✓ Master Effort/Impact Map generated

═══════════════════════════════════════════════════════════

🎯 EXECUTIVE SUMMARY
Product: CommitCraft
For: Developers who care about code history
...

📊 MASTER EFFORT/IMPACT MAP
[Full 2×2 matrix with 18 items]
...

💡 AGENT-GENERATED IDEAS
[10 new ideas across vision/design/engineering]
...

📋 FULL SPECIFICATION
[Detailed product spec]
...

📅 PRIORITIZED ROADMAP
Phase 1 (Week 1-2): 6 quick wins
Phase 2 (Week 3-4): Core MVP
Phase 3 (Month 2): Big bets after validation
...

💾 Saved to memory for future sessions.
```

---

## License

MIT—build great products.
