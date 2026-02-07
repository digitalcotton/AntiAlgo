---
name: agent-comms-protocol
description: Real-time inter-agent communication protocol with visible message logging
---

# Agent Communication Protocol

## Purpose

All agent-to-agent communication is **visible in real-time**. Users see exactly what each agent is thinking, researching, and deciding.

---

## Message Format

Every inter-agent message uses this visual format:

```
┌─────────────────────────────────────────────────────────────┐
│ {EMOJI} {FROM} → {TO}                              {TIME}  │
│ Signal: {SIGNAL_TYPE}                                       │
├─────────────────────────────────────────────────────────────┤
│ {MESSAGE_CONTENT}                                           │
│ {STRUCTURED_DATA}                                           │
└─────────────────────────────────────────────────────────────┘
```

---

## Signal Types & Emojis

### Orchestration Signals

| Emoji | Signal | From → To | Meaning |
|-------|--------|-----------|---------|
| 📡 | `DISPATCH` | Orchestrator → Agent | Assigning a task |
| ✅ | `PHASE_COMPLETE` | Agent → Orchestrator | Phase finished |
| 🔄 | `HANDOFF` | Agent → Agent | Passing context to next agent |
| 🏁 | `PIPELINE_COMPLETE` | Orchestrator → User | All phases done |

### Research Signals

| Emoji | Signal | From → To | Meaning |
|-------|--------|-----------|---------|
| 🔍 | `RESEARCH_REQUEST` | Agent → Sub-Agent | Requesting research |
| 📊 | `RESEARCH_RESULT` | Sub-Agent → Agent | Returning data |
| 🌐 | `WEB_SEARCH` | Sub-Agent → Internet | Searching the web |
| 📄 | `PAGE_FETCH` | Sub-Agent → Internet | Reading a URL |

### Ideation Signals

| Emoji | Signal | From → To | Meaning |
|-------|--------|-----------|---------|
| 💡 | `IDEA_GENERATED` | Agent → Log | New idea created |
| ⚖️ | `EFFORT_IMPACT` | Agent → Log | E/I score assigned |
| 🎯 | `QUICK_WIN` | Agent → Log | Low effort, high impact |
| 🚀 | `BIG_BET` | Agent → Log | High effort, high impact |
| 📋 | `FILL_IN` | Agent → Log | Low effort, low impact |
| 🚫 | `MONEY_PIT` | Agent → Log | High effort, low impact |

### Decision Signals

| Emoji | Signal | From → To | Meaning |
|-------|--------|-----------|---------|
| ✂️ | `CUT` | Agent → Log | Feature removed |
| 🔥 | `TEN_X` | Agent → Log | 10× opportunity identified |
| ⚔️ | `CONFLICT` | Agent → Agent | Disagreement detected |
| 🤝 | `RESOLUTION` | Orchestrator → Agents | Conflict resolved |
| 🤔 | `QUESTION` | Agent → User | Needs clarification |

### Memory Signals

| Emoji | Signal | From → To | Meaning |
|-------|--------|-----------|---------|
| 💾 | `MEMORY_WRITE` | Agent → Memory | Storing decision |
| 📖 | `MEMORY_READ` | Agent → Memory | Retrieving context |
| 🔗 | `MEMORY_LINK` | Agent → Log | Connecting to past decision |

---

## Verbosity Levels

Control output detail with `--verbose` flag:

### `--verbose=full` (Everything)

Shows ALL messages including:
- Orchestrator dispatches
- Sub-agent research requests
- Individual web searches
- Every idea generated
- Every E/I score
- Memory operations
- Conflicts and resolutions

### `--verbose=agents` (Default)

Shows main agent activity:
- Phase dispatches and completions
- Ideas generated (summarized)
- E/I map per agent
- Conflicts and resolutions
- Final handoffs

### `--verbose=summary`

Shows phase-level activity:
- Phase start/complete
- Idea counts
- Major decisions
- Final synthesis

### `--verbose=silent`

Shows only:
- Final output

---

## Real-Time Output Examples

### Orchestrator Dispatch

```
┌─────────────────────────────────────────────────────────────┐
│ 📡 ORCHESTRATOR → STEVE-JOBS                       00:00:01 │
│ Signal: DISPATCH                                            │
├─────────────────────────────────────────────────────────────┤
│ Task: Evaluate product vision                               │
│ Idea: "AI-powered commit message generator"                 │
│ Mode: Deep                                                  │
│ Requirements:                                               │
│   • Generate 3-5 new ideas beyond user input                │
│   • Score all features with Effort/Impact                   │
│   • Invoke sub-agents for research                          │
└─────────────────────────────────────────────────────────────┘
```

### Sub-Agent Research

```
┌─────────────────────────────────────────────────────────────┐
│ 🔍 STEVE-JOBS → MARKET-INTEL                       00:00:03 │
│ Signal: RESEARCH_REQUEST                                    │
├─────────────────────────────────────────────────────────────┤
│ Query: "developer tools commit message market 2026"         │
│ Need: TAM/SAM, funding signals, user complaints             │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 🌐 MARKET-INTEL → WEB                              00:00:04 │
│ Signal: WEB_SEARCH                                          │
├─────────────────────────────────────────────────────────────┤
│ Search: "developer productivity tools market size 2026"     │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 📊 MARKET-INTEL → STEVE-JOBS                       00:00:12 │
│ Signal: RESEARCH_RESULT                                     │
├─────────────────────────────────────────────────────────────┤
│ TAM: $45B (developer tools)                                 │
│ SAM: $2.1B (code quality/productivity)                      │
│ Funding: 3 competitors raised in last 6 months              │
│ Pain: "commit messages are afterthought" (847 upvotes)      │
│ Confidence: High                                            │
└─────────────────────────────────────────────────────────────┘
```

### Idea Generation

```
┌─────────────────────────────────────────────────────────────┐
│ 💡 STEVE-JOBS                                      00:00:18 │
│ Signal: IDEA_GENERATED                                      │
├─────────────────────────────────────────────────────────────┤
│ Title: "Commit Message Streaks"                             │
│ Type: Feature                                               │
│ Description: Gamify good commit hygiene with daily streaks  │
│              and team leaderboards                          │
│ Rationale: Drives daily engagement, proven in fitness apps  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 🎯 STEVE-JOBS                                      00:00:18 │
│ Signal: EFFORT_IMPACT → QUICK_WIN                           │
├─────────────────────────────────────────────────────────────┤
│ Item: "Commit Message Streaks"                              │
│ Effort: 2 (1-3 days, simple counter + UI)                   │
│ Impact: 4 (Critical for engagement)                         │
│ Quadrant: 🎯 QUICK WIN                                      │
│ Action: Do in Week 1                                        │
└─────────────────────────────────────────────────────────────┘
```

### Phase Complete

```
┌─────────────────────────────────────────────────────────────┐
│ ✅ STEVE-JOBS → ORCHESTRATOR                       00:00:45 │
│ Signal: PHASE_COMPLETE                                      │
├─────────────────────────────────────────────────────────────┤
│ North Star: "Make every commit tell a story—automatically"  │
│ MVP Features: 4                                             │
│ Ideas Generated: 5                                          │
│   • Quick Wins: 3                                           │
│   • Big Bets: 1                                             │
│   • Fill-ins: 1                                             │
│   • Money Pits: 0                                           │
│ Ready for: Design phase                                     │
└─────────────────────────────────────────────────────────────┘
```

### Agent Handoff

```
┌─────────────────────────────────────────────────────────────┐
│ 🔄 ORCHESTRATOR                                    00:00:46 │
│ Signal: HANDOFF                                             │
├─────────────────────────────────────────────────────────────┤
│ From: STEVE-JOBS (Vision)                                   │
│ To: JONY-IVE (Design)                                       │
│ Passing:                                                    │
│   • North Star + positioning                                │
│   • 4 MVP features to design                                │
│   • 5 ideas to consider                                     │
│   • E/I scores to build upon                                │
└─────────────────────────────────────────────────────────────┘
```

### Conflict Detection

```
┌─────────────────────────────────────────────────────────────┐
│ ⚔️ CONFLICT DETECTED                               00:02:15 │
│ Signal: CONFLICT                                            │
├─────────────────────────────────────────────────────────────┤
│ Issue: Custom animation system                              │
│                                                             │
│ JONY-IVE says:                                              │
│   "Custom spring physics for commit success animation"      │
│   Effort: 3 | Impact: 4                                     │
│                                                             │
│ WOZNIAK says:                                               │
│   "Use CSS transitions, custom physics adds 2 weeks"        │
│   Effort: 5 | Impact: 3                                     │
│                                                             │
│ Delta: Effort +2, Impact -1                                 │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 🤝 ORCHESTRATOR                                    00:02:16 │
│ Signal: RESOLUTION                                          │
├─────────────────────────────────────────────────────────────┤
│ Rule Applied: "Ive wins if <20% more effort, else Woz"      │
│ Effort increase: 67% (3→5) — exceeds 20% threshold          │
│ Decision: WOZNIAK WINS                                      │
│ Final: Use CSS transitions with subtle easing               │
│ Compromise: Ive to spec exact easing curve                  │
└─────────────────────────────────────────────────────────────┘
```

### Memory Operations

```
┌─────────────────────────────────────────────────────────────┐
│ 💾 STEVE-JOBS → STRATEGY-MEMORY                    00:00:44 │
│ Signal: MEMORY_WRITE                                        │
├─────────────────────────────────────────────────────────────┤
│ Category: Product Decision                                  │
│ Key: "CommitCraft positioning"                              │
│ Value: "Developer productivity, not git client"             │
│ Rationale: "Git clients are commoditized; messaging is not" │
│ Confidence: High                                            │
│ Expires: Never                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Pipeline Progress Indicator

Show overall progress at top of output:

```
═══════════════════════════════════════════════════════════════
  THE TEAM PIPELINE                              Mode: Deep
═══════════════════════════════════════════════════════════════
  [██████████░░░░░░░░░░░░░░░░░░░░] 33%
  
  ✅ Phase 1: Vision (Steve-Jobs)     — 45s
  🔄 Phase 2: Design (Jony-Ive)       — In Progress...
  ⏳ Phase 3: Engineering (Wozniak)   — Pending
  ⏳ Phase 4: Synthesis               — Pending
═══════════════════════════════════════════════════════════════
```

---

## Implementation Notes

### For Agent Authors

Every agent MUST emit messages using this protocol:

```yaml
# At start of task
emit:
  signal: DISPATCH_RECEIVED
  data: { task_summary }

# During research
emit:
  signal: RESEARCH_REQUEST
  to: sub_agent_name
  data: { query }

# For each idea
emit:
  signal: IDEA_GENERATED
  data: { title, type, description, rationale }

emit:
  signal: EFFORT_IMPACT
  data: { item, effort, impact, quadrant }

# At completion
emit:
  signal: PHASE_COMPLETE
  data: { summary, ideas_count, ei_breakdown }
```

### Message Timing

- Include elapsed time from pipeline start
- Use `00:00:00` format (minutes:seconds:milliseconds)
- Sub-agent calls show round-trip time

### Color Coding (Terminal Output)

| Element | Color |
|---------|-------|
| Orchestrator | Blue |
| Steve-Jobs | Purple |
| Jony-Ive | Green |
| Wozniak | Orange |
| Sub-agents | Gray |
| Quick Win | Green |
| Big Bet | Yellow |
| Money Pit | Red |
| Conflict | Red |
| Resolution | Green |

---

## Debug Mode

Add `--debug` for raw handoff payloads:

```
┌─────────────────────────────────────────────────────────────┐
│ 🔧 DEBUG: HANDOFF PAYLOAD                          00:00:46 │
├─────────────────────────────────────────────────────────────┤
│ {                                                           │
│   "id": "h-2026-02-05-001",                                │
│   "from_agent": "steve-jobs",                              │
│   "to_agent": "jony-ive",                                  │
│   "prior_outputs": {                                        │
│     "jobs": {                                               │
│       "north_star": "Make every commit...",                │
│       "mvp_features": ["generate", "templates", ...],      │
│       "effort_impact": [...]                                │
│     }                                                       │
│   }                                                         │
│ }                                                           │
└─────────────────────────────────────────────────────────────┘
```
