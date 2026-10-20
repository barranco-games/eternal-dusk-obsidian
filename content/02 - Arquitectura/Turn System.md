## Overview

The turn system decides when a turn ends and who acts in the next one, inside combat and out of it. `TurnService` (Systems) is the single driver: it ticks every frame and asks the current `ITurnGovernor` whether the turn should advance. Two governors exist. `GameModeManager` decides when combat starts and ends, and `TurnService` swaps the governor:

- **Exploration** — `ExplorationGovernor`, driven by the clock. Every actor in the level takes its turn at once
- **Combat** — `CombatGovernor`, driven by initiative. Agents act one acting run at a time, and each round closes with a shared world phase

Turn boundaries are where the rest of the game hooks in. At an actor's turn start its status effects tick ([[Status Effects System]]), its action points refill and its skill cooldowns tick. Surfaces run their pass once per round: on the world phase in combat, on each turn advance outside it ([[Area System#The turn pass|Area System §17]]).

---

## Key Concepts

### Layered types

| Layer    | Types                                                                                                                                                                  |
|----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Core     | `ITurnService`, `ITurnGovernor`, `ITurnEndCondition`, `IActiveTurn`, `ICombatTurnOrder`, `ICombatIntro`, `IManualTurnRequest`, `TurnNumber`; `ICombatEndCondition` and `InitiativeEntry` in `Core/GameMode/Combat` |
| Gameplay | `TurnCounter`, `ExplorationTurnSettings`, `CombatTurnSettings`                                                                                                         |
| Systems  | `TurnService`, `TurnOrder`, `ActiveTurn`, `ManualTurnRouter`, `PartyTurnLeader`, `AITurnController`, `IntervalTurnCondition`, both governors; `GameModeManager`, `CombatEncounterStarter`, `NoHostilesRemainCondition`, `PartyDefeatedCondition` in `Systems/GameMode`; `DeathService` in `Systems/World` |
| Engine   | `TurnInstaller`, `TurnPacingSO` (asset `Data/Turns/TurnPacing.asset`), `CombatPhase` (encounter phase)                                                                |

`TurnInstaller` registers the services above. Two of the combat intros live elsewhere: `CombatBannerPresenter` in `UIInstaller`, `SkillCuePlayer` in `SceneInstaller`. `TurnService`, `AITurnController`, `PartyTurnLeader` and `DeathService` resolve eagerly, since nothing asks for them but they must be listening from the first frame.

### One driver, two governors

```csharp
public interface ITurnGovernor
{
    bool ShouldAdvance();
    void BeginTurn();
    void Advance();
}
```

`TurnService.TryAdvance` runs the same three steps whichever governor is current, in this order:

```csharp
if (!_current.ShouldAdvance())
    return false;

_counter.Advance();
_current.Advance();
_current.BeginTurn();
return true;
```

`TurnCounter.Advance` raises `OnAdvanced(TurnNumber)` before the governor moves on. The counter counts governor steps, not rounds: in combat every acting run and every world phase after the first turn is one turn number. The first combat turn is begun straight from `EnterCombat` (or by the next `TryAdvance` once the intros finish) and does not advance the counter. `ActionLedger` stamps records with it ([[Action System#12. ActionLedger|Action System §12]]).

### What a turn start does to an actor

Both governors begin a turn by calling `IActor.BeginTurn()` on whoever acts:

```csharp
// Actor
public virtual void BeginTurn()
{
    if (!Initialized) return;
    StatusEffects.OnTurnStart();
}

// Agent
public override void BeginTurn()
{
    if (!Initialized || IsDead) return;
    base.BeginTurn();
    if (StatusEffects.AllowsRecovery(ResourceType.ActionPoints))
        ActionPoints.SetToMax();
    Skills.TickCooldowns();
}
```

Statuses tick first, so one that expires this turn no longer caps the refill, and one that blocks recovery (`Overloaded`'s debt turn) can stop it.

### Exploration turns

`ExplorationGovernor.ShouldAdvance` is false while a conversation is open (`IConversation.IsOpen`), and otherwise true as soon as any `ITurnEndCondition` says so. The only condition registered is `IntervalTurnCondition`: it adds up frame time while no conversation is open and resets on `TurnCounter.OnAdvanced`. Its interval is `ExplorationTurnSettings.TurnInterval`, authored as `_explorationTurnInterval` on `TurnPacing.asset` (2 s).

`BeginTurn` calls `BeginTurn()` on every `IActor` in `IEntitySource.All`. `Advance` does nothing.

### Entering combat

`CombatEncounterStarter.StartEncounter()` puts every standing actor in the level into the fight (`IActor.IsStanding()`) and calls `IGameModeService.EnterCombat`. Encounters start their fight through it (`CombatPhase`), as do the F9 debug hotkey (`CombatDebugHotkey`, debug builds only) and the console.

```
GameModeManager.EnterCombat(participants)      — ignored if already in combat
  └─ TurnService.EnterCombat
       ├─ CombatGovernor.BeginEncounter         — sort agents, land the first run
       ├─ every ICombatIntro.Play()
       └─ first BeginTurn waits until no ICombatIntro.IsPlaying
```

`BeginEncounter` splits the participants: `IAgent`s go into the initiative order, other `IActor`s (obstacles, hazards) are non-agents that only tick in the world phase. Each agent's score is read once, `agent.Stats.Derived.Initiative`, which is Dexterity + d100 through the stat mediator ([[Stats System#Derived stats and aptitudes are attribute-driven|Stats System]]). `TurnOrder.Set` sorts by score, highest first, with a stable sort, so ties keep the participants' order. Agents passed to `CombatGovernor.LeadNextEncounter` (scripted perf runs) open the order ahead of the roll, for that one encounter.

Three `ICombatIntro`s hold the first turn: `CombatBannerPresenter` (the combat banner), `AIService` (pre-warms `PrewarmedWorldStates` = 128 planning states) and `SkillCuePlayer` (readies one queued skill effect a frame). Until the first turn begins, `ICombatTurnOrder.FirstTurnBegun` is false and nobody may act.

### Acting runs and rounds

`CombatGovernor` has two phases, `Agents` and `NonAgents`. A round is every acting run in initiative order, then one world phase.

An **acting run** is fixed when the turn lands on the cursor (`LandRun`):

- a party agent brings every party agent that directly follows it in the order: they act together, and the player switches between them
- any other agent acts alone

Removals only shrink a run, so it never merges with a later one.

```
order: P1(party) P2(party) E1 P3(party)

step 1   run [P1, P2]     — both act; ends when both have passed
step 2   run [E1]         — AITurnController plays it
step 3   run [P3]
step 4   world phase      — non-agents tick, OnNonAgentTurn, held WorldTurnDelay
step 5   run [P1, P2]     — next round
```

`BeginTurn` on an agent turn calls `BeginTurn()` on each agent of the run, then raises `OnAgentTurnStarted` once per agent. It snapshots the run first and skips anyone a turn-start effect removed. Once a removal has yielded the turn, it stops raising `OnAgentTurnStarted` for the rest. On the world phase it ticks every non-agent and raises `OnNonAgentTurn`.

`Advance` moves the cursor one step per run member. Wrapping past the last agent switches to the world phase, and the world phase hands back to the top of the order.

### Ending a turn

| Phase        | `ShouldAdvance` is true when                                           |
|--------------|-----------------------------------------------------------------------|
| Agents       | the turn was ended: every member of the run passed, `EndCurrentTurn()` was called, or the acting agent was removed |
| World phase  | `CombatTurnSettings.WorldTurnDelay` seconds have passed (1 s); nothing else ends it |

- **Player** — `ManualTurnRouter` (`IManualTurnRequest`) passes the party leader only: `CombatGovernor.Pass(leaderId)`. A merged run ends once every member has passed, so the rest keep acting. When the leader passes, `PartyTurnLeader` hands leadership to the first party agent in initiative order that is still acting (`OnAgentPassed`). At the start of a party run keeps a leader already inside it or picks the run's first agent.
- **AI** — `AITurnController` takes every non-party `OnAgentTurnStarted`. It waits `AiTurnDelay` (1 s), then plans with `ITurnPlanSource`, runs the plan's first step through `IPlanStepRunner` and plans again, up to `MaxStepsPerTurn` (16). No plan, two rejected steps in a row or an exception all end the turn with `EndCurrentTurn()`, so combat never stalls on an enemy. Planning itself is the enemy AI (TDD §3.4).

### Who may act: IActiveTurn

`ActiveTurn` reads the governor's own run, so input and the initiative UI can never disagree about whose turn it is:

```csharp
public bool PlayerMayAct(EntityId agent)
{
    if (!_combat.IsActive) return true;
    return _party.Contains(agent) && Includes(agent);
}
```

`Includes` is false before the first turn begins, during the world phase and for an agent that already passed. Gameplay asks `PlayerMayAct` before acting: `SkillService` (player casts only), `GroundClickMovementInput` and `ItemPickupService`. The HUD asks it to show what is available: `MovePreviewPresenter`, `ControlsPresenter`, `SkillBarPresenter`, `PartyPresenter`, `TurnPresenter` and `TutorialPresenter`. `InitiativeOrderPresenter` and `PartyTurnLeader` read `Includes`.

### Removal mid-encounter

`DeathService` calls `CombatGovernor.Remove(id)` when an actor dies. The removed agent leaves the order, the run and the passed list, then `OnAgentRemoved` is raised:

- If it was acting alone, the turn is yielded. The cursor already sits on its successor, so the next `Advance` lands there without stepping again. A removal that wrapped the cursor closes the round instead, and the world phase runs next.
- If it was one member of a party run, the run keeps acting. If everyone left in it had already passed, the turn ends.
- If nobody is left in the order, the encounter goes inactive.

Turn-start effects can kill (a burn at 1 HP). That is why `BeginTurn` snapshots the run, and stops announcing turn starts once a removal has yielded the turn.

### Ending combat

While in combat, `GameModeManager` polls every `ICombatEndCondition` each frame:

| Condition                   | Ends with | When                                                         |
|-----------------------------|-----------|--------------------------------------------------------------|
| `NoHostilesRemainCondition` | Victory   | no agent outside the party in `CombatGovernor.Agents` has HP above 0 |
| `PartyDefeatedCondition`    | Defeat    | no party agent in it has HP above 0 (a dying member is at 0) |

If both fire in the same frame, the higher precedence wins: Victory > Defeat > Completed > Aborted. A party lying dying beside the last enemy wins the fight, and the win stands it up at 1 HP. `EndCombat` switches back to exploration (`CombatGovernor.EndEncounter`) and raises `CombatEnded(outcome)`, which `CombatPhase` turns into its `OnVictory` / `OnDefeat` branch. `IGameModeService.EnterExploration()` ends a fight as `Aborted`.

### Observers

`ICombatTurnOrder` is the read-only face of `CombatGovernor` for everything that must not drive the cycle. Among its listeners:

| Listener                  | Uses                                                                          |
|---------------------------|-------------------------------------------------------------------------------|
| `InitiativeOrderPresenter`| the queue UI, rebuilt at each turn start                                      |
| `CameraTurnFocus`         | follows the acting run                                                        |
| `SurfaceTurnDriver`       | runs the surface pass on `OnNonAgentTurn` in combat, and on `TurnCounter.OnAdvanced` outside it ([[Area System#The turn pass\|Area System §17]]) |
| `PartyTurnLeader`         | moves the party leader with the turn                                          |

`PartyPresenter`, `SkillBarPresenter`, `TurnPresenter`, `MovePreviewPresenter` and `CombatOutlineTint` listen too.

What drives the cycle takes `CombatGovernor` itself: `AITurnController` (`EndCurrentTurn`), `ManualTurnRouter` (`Pass`) and `DeathService` (`Remove`). `DeathService` also counts dying turns on `OnAgentTurnStarted` and kills the expired on `OnNonAgentTurn` ([[Status Effects System#Dying]]). The two end conditions read its `Agents`.

### Pacing

`TurnPacingSO` builds both settings objects. Authored values on `TurnPacing.asset`:

| Field                       | Value | Read by                                    |
|-----------------------------|-------|--------------------------------------------|
| `_explorationTurnInterval`  | 2 s   | `IntervalTurnCondition`                    |
| `_aiTurnDelay`              | 1 s   | `AITurnController`, before the first step  |
| `_worldTurnDelay`           | 1 s   | `CombatGovernor`, length of the world phase|
| `_aiAimDuration`            | 1 s   | `PlanStepRunner`, AI aim shown before a cast (held after it for a self-cast) |
| `_aiSkillRecovery`          | 0.5 s | `PlanStepRunner`, pause after an AI cast   |

---

## Divergence from the GDD

[[Turnos]] and [[Estadísticas de Agentes#Puntos de Acciones|Estadísticas de Agentes]] describe these differently from the code:

| Topic                 | GDD                                                                                          | Code                                                                                   |
|-----------------------|----------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------|
| Exploration turn      | 6 s                                                                                          | 2 s (`_explorationTurnInterval`)                                                       |
| Initiative            | not rolled: Destreza + bonuses from weapon type, ambush and equipment                        | Dexterity + d100, rolled once per encounter. No authored item and no ambush modifies `CombatStat.Initiative`; an item modifier on it would work with no code change, since it goes through the stat mediator |
| AP recovery           | each turn recovers the starting AP (4 + bonus) on top of what is left, up to 10               | `ActionPoints.SetToMax()`: refills to `MaxAP`, nothing carries over                    |
| World phase           | not described                                                                                | every round closes with one; non-agents and surfaces act in it                         |

Merged party turns match the GDD: consecutive party agents act together.

---

## Adding a New Turn End Condition (exploration)

1. Implement `ITurnEndCondition` in `Systems/Turns/EndConditions`; add `IUpdate` if it counts time and reset on `TurnCounter.OnAdvanced` the way `IntervalTurnCondition` does
2. Register it in `TurnInstaller` as `ITurnEndCondition`

`ExplorationGovernor` takes every registered condition and ends the turn on the first that answers true. An open conversation still holds every condition.

---

## Adding a New Combat End Condition

1. Implement `ICombatEndCondition.TryEnd(out EncounterOutcome)` in `Systems/GameMode/Combat`, reading `CombatGovernor.Agents` rather than the level
2. Register it in `TurnInstaller` as `ICombatEndCondition`
3. If its outcome can coincide with another, check `GameModeManager.Precedence` gives the right winner

---

## Adding a New Combat Intro

Implement `ICombatIntro` (`IsPlaying`, `Play`) and register it under that interface. `TurnService` calls `Play` on entering combat and holds the first turn until `IsPlaying` is false. An intro that never finishes stalls the fight.