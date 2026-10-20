## Overview

The enemy AI plays every combat turn that does not belong to the party. It is a planner, not a behaviour tree or GOAP: on each step of its turn it searches ahead over simulated copies of the world, scores each candidate step, and plays the first step of the best path it finds. Then it plans again from the world that step left behind.

Everything lives in `Systems/AI`, free of the engine, behind `AIService`. `AITurnController` (`Systems/Turns`) takes the turn from the combat governor and runs each step through the same `MovementService` and `SkillService` the player uses. When an AI turn comes up, and how it ends, belong to [[Turn System#Ending a turn|Turn System]]. This page is what happens inside it.

Three things keep the cost off the frame:

- the simulated states come from a pool, filled over the first frames of a fight, so planning does not allocate
- the search hands the frame back every 1 ms of work, so a big fight costs more frames, not longer ones
- damage is an expected value and dice never roll in the simulation, so a plan is deterministic

[[TDD#3.4 Inteligencia Artificial|TDD §3.4]] is the summary.

---

## Key Concepts

### Layered types

| Folder / layer         | Types                                                                                                    |
|------------------------|----------------------------------------------------------------------------------------------------------|
| `Systems/AI`           | `AIService`, `ITurnPlanSource`                                                                           |
| `Systems/AI/Actions`   | `IPlannedStep`, `MoveStep`, `SkillStep`                                                                  |
| `Systems/AI/Planning`  | `TurnPlanner`, `PlanNode`, `TurnPlan`, `WorldStateKey`, `MinHeap<T>`, `IActionProvider`, `SkillActionProvider`, `MovementActionProvider`, `ISimulatedAction`, `SimulatedSkillAction`, `SimulatedMoveAction`, `PlanReport` |
| `Systems/AI/Simulation`| `SimulatedWorldState`, `SimulatedAgentState`, `SimulationStatePool`, `SkillSimulator`, `SurfaceSimulator`, `SightlineCache`, `SimulationResult` |
| `Systems/AI/Movement`  | `IMovementCandidateProvider`, `RingCandidateProvider`, `RingSampler`, `CandidateSelector`, `CandidateTuning`, `SurfaceEscapeProvider`, `SkillReach`, `WalkCache`, `ReachablePosition` |
| `Systems/AI/Scoring`   | `IScorer`, `ScoringComponent`, `ScoringContext`, `StepScore`, the seven scorers, `StatusValue`           |
| `Systems/AI/Goals`     | `AIGoal`, `GoalSelector`, `GoalContext`, `GoalTarget`, `IGoalStrategy`, `KillTargetStrategy`             |
| `Systems/Turns`        | `AITurnController`, `IPlanStepRunner`, `PlanStepRunner`                                                  |
| Gameplay               | `AIGoalData`, `AIGoalKind` (`Gameplay/Data/Definitions`); `AgentDefinition.Goals`                         |
| Engine                 | `AgentDefinitionSO` (authors goals); `EntityFactory` (hands them to `AIService`)                          |

`TurnInstaller` registers two of them. `AIService` is a lazy singleton under `AIService`, `ITurnPlanSource`, `ICombatIntro` and `IUpdate`, and `TurnService`'s list of intros builds it at startup. `AITurnController` is eager, since nothing asks for it. Everything else is built with `new` inside those two: one `TurnPlanner` with its providers per enemy, the scorers per goal, and one shared `KillTargetStrategy`, `WalkCache` and `SightlineCache`.

### An AI turn

```
CombatGovernor.OnAgentTurnStarted(agent)            — not a party member
  └─ AITurnController.RunTurn
       ├─ wait AiTurnDelay (1 s)
       ├─ AIService.BeginTurn(agent)                 — clear per-turn caches and the refused step
       └─ up to MaxStepsPerTurn (16) times:
            ├─ plan = AIService.PlanTurn(agent)      — null ends the turn
            ├─ PlanStepRunner.Run(plan.Steps[0])     — only the first step is played
            ├─ rejected twice in a row → end the turn
            └─ wait a frame, plan again
  └─ CombatGovernor.EndCurrentTurn()
```

`AITurnController` hands every agent outside the party to the AI. Only the first step of each plan is played and the rest is thrown away. A move that lands short, or a cast that does less than expected, only changes the next plan. The turn ends when no plan comes back, after 16 steps, on two rejected steps in a row, or on an exception (logged). A turn cancelled from outside (the agent removed, the fight over, a new turn started) is left for whoever cancelled it.

A rejected step is handed back to the planner with `ITurnPlanSource.Refuse`. The next search drops that step as a first step: a skill on the same first target, or a move to within 0.1 m of the same spot.

`PlanStepRunner` plays the two step kinds:

- **`MoveStep`** — `MovementService.RequestMove` with `ActivitySource.Ai`. It succeeds on a completed move, or a move halted by its budget after covering some distance
- **`SkillStep`** — `SkillService.UseSkill` with `ActivitySource.Ai`. `Area` and `AreaHostiles` skills go through the player's `AutoAreaTargetDriver` and hit whoever their area covers. Every other skill casts at the planned targets (`ScriptedTargetDriver`). An area skill keeps its planned aim only if, cast from where the caster now stands, it still catches the first target and more than one hostile. Otherwise the caster faces its first target. The aim is shown for `_aiAimDuration` (1 s) before the cast, or held after it for a self-cast, and `_aiSkillRecovery` (0.5 s) follows ([[Turn System#Pacing|Turn System]])

Both run the real services, so their rules (AP, range and sight, interruptibility) apply as to the player ([[Action System]]).

### Planning one step

`AIService.PlanTurn(agent)`:

1. picks the agent's goal (`GoalSelector.SelectBest`). None available → no plan
2. lets the encounter's enemies look for the party ([[#Hostility and awareness]])
3. snapshots the world into a pooled `SimulatedWorldState`
4. gives up if the agent's statuses block both skills and movement
5. asks the goal's strategy for targets (`KillTargetStrategy`). None known → no plan
6. runs the agent's `TurnPlanner` on the snapshot

The snapshot holds the caster, every party member, every agent in the fight, and every other living agent within the caster's reach: the reach of its `Area`, `AreaHostiles` and `TargetedArea` skills, blast radius included, plus its walk range and 1 m. Agents beyond that are kept only as positions, obstacles a move cannot stand on.

`WhyNoPlan` gives the reason a plan came back empty: `no goal applies`, `its statuses block both skills and movement`, `it knows of no living target` or `no step scores above doing nothing`. The controller logs it when the first plan of a turn is empty.

### The search

`TurnPlanner` is a best-first search over simulated states, pruned to a beam:

| Constant               | Value  | Meaning                                                             |
|------------------------|--------|---------------------------------------------------------------------|
| `DefaultMaxExpansions` | 512    | nodes expanded per search                                           |
| `MaxDepth`             | 8      | steps in a path                                                     |
| `MaxBranches`          | 6      | children kept per expanded node                                      |
| `SliceBudget`          | 1 ms   | work between frame yields                                            |

```
push root (score 0)
while open set not empty and expansions < 512:
    pop the node with the highest cumulative score
    skip it if at depth 8, if the goal is satisfied there, or if its WorldStateKey was seen
    ask SkillActionProvider, then MovementActionProvider, for actions; apply each to a copy
    sort the children by score, keep the best 6, return the rest to the pool
    best = any kept child scoring strictly above it
    yield the frame once the slice has spent 1 ms
return the path to best, or null if best is still the root
```

A child's score is its parent's plus the goal's score for the step. The plan is the path to the best-scoring node seen, which may stop before the deepest. Nothing better than standing still means no node scored strictly above 0, and no plan.

`WorldStateKey` merges states that differ only in ways the search does not care about. It holds the caster's position (0.25 m quantum), AP, movement credit, health and options (ammo, rounds, cooldowns, uses, statuses), plus a hash of every other agent's id, health and options. Other agents' positions are not in it: in the simulation only the caster moves.

### Time slicing and the warm pool

The search checks the clock between expansions. Once a slice has spent `SliceBudget`, it awaits the next frame and checks its cancellation token, so a slice can overrun by one expansion. Movement candidates also yield once when they send a batch of path measurements out. The `ai:plan` and `ai:why` console commands plan in one go.

States come from `SimulationStatePool`. When a fight starts, `AITurnController` calls `AIService.PrepareEncounter`, which snapshots each enemy's world and keeps the largest as a template. `AIService` is an `ICombatIntro`: from then on its `IUpdate.Tick` adds `PrewarmedStatesPerFrame` (32) states a frame, each sized like the template, until the pool holds `PrewarmedWorldStates` (128) world states and 128 agent states per agent in the template. The first turn of the fight waits for that ([[Turn System#Entering combat|Turn System]]). A search that needs more just allocates.

### The simulated world

`SimulatedAgentState` is the mutable copy of one agent. Its resources are covered in [[Resources System#Simulation|Resources System]]. It also holds the five attributes, precision and evasion, resistances, sight range, skills with cooldowns and uses left, weapon damage per skill, magazines and reserve ammo, movement credit and walk range, statuses with the chance each has landed, and whether it is an ally of the caster.

`SkillSimulator` casts on a copy. It checks the cost, range and sight the live cast checks, widens an area to everyone the live area would catch, aims a cone or line to catch as many targets as it can, then runs each effect's `Simulate`:

- **Damage** — `Average()` of the roll, through the caster's and target's status modifiers and the target's resistance, times the hit chance. The chance is `HitChance.Percent`, as the live roll uses it ([[Combat & Dice#Hit chance|Combat & Dice]]). Fractions carry over between hits
- **Statuses** — recorded with the chance they landed, combined across casts. A status counts as present from 50%. Damage over time is priced as pending damage, a permanent one for 3 turns
- **Checks** — `ApplyStatusOnFailedCheckEffect` is scaled by the chance the target fails
- **Heals and resource changes** — land only when the hit chance is 50% or more
- **Status removal and reloads** — simulated too

An effect with no `Simulate` (`ISimulableEffect`) is skipped. `SpawnSurfaceEffect` is the one shipped effect without one, so the surfaces a skill lays never enter the plan.

What the simulation leaves out:

- other agents never act, move, react or take turns. Only the caster does
- statuses do not tick and turn starts do not happen. A status's AP effect is priced by `StatusValue`, not applied
- surfaces the plan lays do not exist in it, and nothing ticks. The caster's own route and resting spot are priced by `SurfaceSimulator` as expected health lost, counting the ground a growing surface will have taken by the end of the round
- `Ground`-targeted skills are never planned

### Moves: where to stand

`SkillActionProvider` offers every usable skill: on the goal's active target, and on each lower-ranked target still alive. `MovementActionProvider` offers up to 8 positions, plus an escape when the caster stands on a harmful surface. It never offers two moves in a row in one path (`SimulatedMoveAction.MaxConsecutiveMoves` = 1), and caches the positions per position, AP, movement credit and target within one search.

`RingCandidateProvider` finds those positions around the active target:

1. **Rings** — for each usable skill, rings around the target at distances where the skill reaches (one ring for a skill with no minimum range, three spread over its band otherwise), 16 angles each, plus spots that line an area skill up through two targets
2. **Filters** — at least 0.5 m from the caster, clear of bodies by `AgentBodies.Clearance` (1 m), affordable, with the target in view. `WalkCache` measures the real paths in one batch (`IPathBatch`), and a point is kept only if the path reaches it
3. **Score** — `enabled skills × 2 − AP spent × 0.5`, less what staying put already scores, less the surface harm on the way (`CandidateTuning`, `SurfaceEscapeProvider`)
4. **Selection** — `CandidateSelector` takes up to 8: first the best for each skill not yet covered, then the best of the rest, skipping any within 5 m of a pick that enables the same skill

When no ring point qualifies, an approach fallback walks the real path toward the target and stops where a skill first reaches, or as far as the budget goes. A walk paid for with movement credit alone scores nothing, so an enemy out of AP does not shuffle after attacking. Standing on a harmful surface adds one escape candidate: the nearest clear, harmless spot it can afford.

### Scoring

Every scorer is a `ScoringComponent`: its term times a weight. The goal sums them for each step, so the plan's score is the sum over its steps.

| Scorer                    | Weight         | Term                                                                               |
|---------------------------|----------------|------------------------------------------------------------------------------------|
| `DamageDealtScoring`      | 15 × `DamageDealt`     | expected health removed from every other agent; counted against the caster for its allies |
| `CasterHealthScoring`     | 15 × `CasterHealth`    | the caster's own expected health change                                    |
| `DeathPenaltyScoring`     | `DeathPenalty`         | −10000 if the step kills the caster                                        |
| `GoalAchievementScoring`  | `GoalAchievement`      | +1000 per goal target killed                                               |
| `ConsumableUsageScoring`  | `ConsumableUsage`      | −10 ÷ uses left, for a skill with limited uses                             |
| `StatusAppliedScoring`    | 15 × `StatusApplied`   | the value of statuses and pending damage added: for on a foe, against on the caster or an ally |
| `MovementScoring`         | `Movement`             | a move's position score × 5, minus 1                                       |

15 is `DamageDealtScoring.DefaultWeight`, what one point of health scores. The −1 per move means a move whose position score is 0.2 or less loses to standing still, so a ring move that gains nothing over staying put is never chosen. An approach that spends AP scores above that (`ApproachGain`), which is how an enemy out of reach closes in.

`StatusValue.Of` prices a status in health-equivalents per turn: the extra damage it makes its owner take, less the extra it deals, at 2 hits a turn, plus a turn's damage (10) scaled by the share of a 5 AP turn it removes: 2 per AP of `MaxApChange` lost. `Provoked` is a flat 1 (a hindrance), and `Berserk` is its incoming bonus minus its outgoing bonus times 2 hits.

### Goals

```csharp
public sealed class AIGoalData
{
    public AIGoalKind Kind = AIGoalKind.KillTarget;
    public float Priority = 10f;

    public float DamageDealt = 1f;
    public float CasterHealth = 1f;
    public float DeathPenalty = 1f;
    public float GoalAchievement = 1f;
    public float ConsumableUsage = 1f;
    public float StatusApplied = 1f;
    public float Movement = 1f;
}
```

A goal is a strategy plus the seven scorers, each weight a multiple of the shipped tuning. `AgentDefinitionSO._goals` authors them (a `GoalEntry` per goal). `EntityFactory.Initialize` hands every non-player agent's list to `AIService.SetGoals`. An agent with none plays the default: one `KillTarget` goal at priority 10 with every weight at 1.

`GoalSelector.SelectBest` plays the highest-priority goal whose strategy `IsAvailable`; a tie goes to the first listed. `AIGoalKind` has one value, `KillTarget`, played by `KillTargetStrategy`:

- **Available** while any party member is standing
- **Targets** every party member the enemies know of ([[#Hostility and awareness]]) that is alive in the snapshot, ranked: killable this turn first, then fewest AP to get a skill in reach, then lowest health, then nearest. Reach is measured along the real path. "Killable" means that, for some skill it can pay for after walking into reach, casts × expected damage reaches the target's health. Casts is what the AP left allows (one for a skill with a cooldown or no AP cost), capped by uses left and rounds in the magazine
- **Sticks** to the target it chose at the start of the turn, unless a different one becomes killable and it is not
- **Satisfied** when every ranked target is dead in the simulation

The search aims at the best-ranked target still alive in each state. A kill moves it on to the next.

Two authoring traps in `AgentDefinitionSO`: a new `GoalEntry` starts at priority 0, not 10, and a weight left at 0 reads as 1, so a term cannot be switched off.

### Hostility and awareness

The planner's sides come from the party line ([[Party System#Hostility|Party System]]): each simulated agent is marked an ally of the caster unless `AreHostile` says otherwise. Damage to an ally scores against the step, and `AreaHostiles` areas spare allies.

Targets are a narrower question. `KillTargetStrategy` only ever targets party members, and only those the encounter's enemies know of. `AIService` keeps one `_spotted` set for the whole fight:

- **At the start** — `PrepareEncounter` marks every party member in the initiative order as known
- **By sight** — before each plan, every standing enemy in the fight (and the planning agent, if it is not in the fight) looks for the party members not yet known: `Sight.Reaches` within its `SightRange`, with a clear terrain sightline. What one sees, all know
- **By attack** — a party member whose skill targets an agent outside the party is known (`AITurnController` → `AIService.Reveal`)
- **At the end** — `EndEncounter` forgets everything. Nothing is forgotten before that, even out of sight

An enemy that knows of no living target yields its turn. One that knows of a target it cannot see still plans: its moves need the target in view, so it walks the path toward it.

Since every party member standing when a fight starts is in the initiative order, the set only grows for members who were not (joined later, or down at the start).

### Debugging

- **`ai:plan:<agent>`** — the plan the agent would play now: goal, targets, each step with its score terms, the total and nodes expanded, or why it would yield
- **`ai:why:<agent>`** — every option as a first step: each skill scored or the reason it is rejected, and each movement candidate with its walk, surface cost and the skills it enables
- **Logs** — `[AI] <agent> plays <step>` per step, the reason a turn yields, rejected steps, and steps that fail
- **Profiler markers** — `AITurnController.Plan`, `AITurnController.StartStep` and `TurnPlanner.Slice`

Both commands run the look for the party first, so they can mark party members as known.

---

## Divergence from the GDD

The GDD has no enemy AI page. [[Sigilo]], [[03 - Entidades/Agentes/Party/Lorenzo|Lorenzo]]'s *Provocar* and [[Estados]] describe behaviour the planner does not follow:

| Topic                | GDD                                                                                         | Code                                                                                   |
|----------------------|---------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------|
| Detection            | each enemy detects on its own: one finding the party does not mean all do                    | the fight's enemies share one known set: what one sees, all know                       |
| How enemies notice   | vision zones (green, yellow, red) from Sigilo against Descubrimiento, light, and sound ranges | sight range and a clear terrain sightline, or being attacked                            |
| Provocar             | a provoked agent spends its whole turn closing in to strike the provoker in melee            | `Provoked` is priced as a hindrance (`StatusValue`); targets and steps are unchanged ([[Status Effects System#Provoked]]) |
| Paranoia             | the agent attacks the nearest agent, ally or foe                                             | no such status                                                                         |
| Targets              | not specified                                                                                | party members only; never another outsider or a neutral agent                          |

---

## Adding a New Goal Kind

1. Add the value to `AIGoalKind` (`Gameplay/Data/Definitions/AIGoalData.cs`)
2. Implement `IGoalStrategy` in `Systems/AI/Goals`: `IsAvailable(self)`, `CreateTarget(state)` returning ranked ids in a `GoalTarget`, `IsSatisfied(state, target)`. Take services through the constructor
3. Map the kind to it in `AIService.Strategy`. An unmapped kind logs an error and the goal is skipped
4. Author it on an `AgentDefinitionSO` with a `Priority` above the agent's other goals where it should win

The movement candidates and skill actions aim at `GoalContext`'s best-ranked living target, so a strategy whose targets are not agents (a spot to hold, an item) needs a provider that understands them.

---

## Adding a New Scoring Term

1. Subclass `ScoringComponent` in `Systems/AI/Scoring` and implement `EvaluateInternal(in ScoringContext)`, comparing `context.Before` with `context.After`
2. Add it to `AIService.Scorers` and a weight field to `AIGoalData`, `AgentDefinitionSO.GoalEntry` and `BuildGoals`
3. Price it against `DamageDealtScoring.DefaultWeight`: 15 is one point of health

`ai:plan` lists the term on every step by its class name, without the `Scoring` suffix.

---

## Making an Effect Visible to the Planner

Implement `ISimulableEffect.Simulate` on the effect so it mirrors `Apply` with expected values: `Average()` for rolls and `context.DealDamage` for damage ([[Combat & Dice#Adding a New Damage Effect|Combat & Dice]]). A status that should weigh more than its numbers overrides `Profile`, or gets a case in `StatusValue` ([[Status Effects System]]).
