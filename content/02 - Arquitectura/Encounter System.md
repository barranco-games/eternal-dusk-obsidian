## Overview

An encounter is an authored sequence of beats: a conversation, a stretch of free roaming, a member joining the party, a fight with a branch for each way it ends. `EncounterDefinition` (a ScriptableObject) lists the beats as phases, `EncounterRunner` plays them in order, and a level lifecycle step starts it when the level loads.

The game mode is the other half. `GameModeManager` holds whether the game is in exploration or combat, starts combat when asked, polls the combat end conditions each frame and reports how the fight ended. A combat phase starts a fight through it and waits for that report. The turn side of the switch (the governors, initiative, acting runs) is [[Turn System]]'s.

Two layers own the parts: the game mode is engine-free (`Core/GameMode`, `Systems/GameMode`), while encounters are serialized assets and live in Engine (`Engine/Encounters`) behind a Core observation interface.

---

## Key Concepts

### Layered types

| Layer   | Types                                                                                                                                   |
|---------|-----------------------------------------------------------------------------------------------------------------------------------------|
| Core    | `IEncounterService`, `EncounterId`, `EncounterOutcome` (`Core/Encounters`); `IGameModeService`, `GameModeState`, `ICombatEndCondition`, `InitiativeEntry` (`Core/GameMode`) |
| Systems | `GameModeManager`, `CombatEncounterStarter`, `NoHostilesRemainCondition`, `PartyDefeatedCondition` (`Systems/GameMode`)                 |
| Engine  | `EncounterDefinition`, `IEncounterPhase`, `EncounterPhases`, `IEncounterRunner`, `EncounterRunner`, `IEncounterContext`, `EncounterContext`, `StartEncounterStep`; the phases in `Engine/Encounters/Phases` |

`SceneInstaller` registers `EncounterContext` (as `IEncounterContext`) and `EncounterRunner` (as `IEncounterRunner` and `IEncounterService`), both lazy singletons. `TurnInstaller` registers `GameModeManager` (as `IGameModeService` and `IUpdate`), `CombatEncounterStarter` and the two end conditions.

### Two meanings of "encounter"

The word covers two things in the code:

- **The authored encounter** — an `EncounterDefinition` played by `EncounterRunner`. This page.
- **The combat encounter** — one fight, from `CombatEncounterStarter.StartEncounter` to `CombatEnded`. `CombatGovernor.BeginEncounter`, `LeadNextEncounter` and the `encounter` console command use the word this way.

An authored encounter may hold no fight at all, or several in order; the shipped one holds one. A fight can also start with no authored encounter running (the F9 hotkey, the console).

### Game mode

```csharp
public interface IGameModeService
{
    GameModeState Mode { get; }
    bool InCombat { get; }
    event Action<GameModeState> OnModeChanged;
    event Action<EncounterOutcome> CombatEnded;
    void EnterCombat(IEnumerable<EntityId> combatants);
    void EnterExploration();
}
```

`GameModeState` is `Exploration` or `Combat`. `EnterCombat` is ignored while already in combat. Otherwise it asks `ITurnService.EnterCombat` to switch the governor and raises `OnModeChanged`. `EnterExploration` ends a fight as `Aborted`.

While in combat, `GameModeManager.Tick` asks every `ICombatEndCondition` and ends the fight on the highest-precedence outcome reported that frame: `Victory` (3) > `Defeat` (2) > `Completed` (1) > `Aborted` (0). Ending switches the turn service back to exploration, raises `OnModeChanged`, then `CombatEnded(outcome)`. The two shipped conditions and why victory outranks defeat are in [[Turn System#Ending combat|Turn System]].

`CombatEncounterStarter.StartEncounter()` is the one way into a fight: it passes every `IActor` in `IEntitySource.All` that `IsStanding()` to `EnterCombat`. There is no per-encounter roster. Everyone standing in the level fights, and the party line decides the sides ([[Party System#Hostility|Party System]]).

| Listener                   | On                | Does                                                    |
|----------------------------|-------------------|---------------------------------------------------------|
| `CombatPhase`              | `CombatEnded`     | resumes the encounter on the fight's branch             |
| `DeathService`             | `CombatEnded`     | stands dying party members up after a `Victory`         |
| `InitiativeOrderPresenter`, `PartyPresenter`, `SkillBarPresenter`, `TurnPresenter`, `MovePreviewPresenter`, `CombatOutlineTint`, `CameraTurnFocus` | `OnModeChanged` | react to the switch: show or hide combat UI, refresh availability, mark the move preview stale, tint outlines, retarget the camera |

### Encounter definitions and phases

```csharp
[CreateAssetMenu(fileName = "New EncounterDefinition", menuName = "EternalDusk/EncounterDefinition")]
public sealed class EncounterDefinition : ScriptableObject
{
    [SerializeField] private string _id;
    [SerializeReference] public List<IEncounterPhase> Phases = new();
    public string Id => _id;
}

public interface IEncounterPhase
{
    UniTask<EncounterOutcome> Run(IEncounterContext context, CancellationToken ct);
}
```

`Id` keys the run's record that the encounter is done, so it must survive a rename of the asset. What starts an encounter is not part of the definition, so the same asset could be opened by a level step or by some other trigger.

Phases are serialized data, so nothing injects them. `IEncounterContext` is the set of services a phase may drive: `GameMode`, `Combat` (`CombatEncounterStarter`), `Dialogue`, `Conversation`, `Barks`, `Clock`, `EndGame`, `Ledger` (`ActionLedger`), `Entities`, `Party` and `Music`.

`EncounterOutcome` is `Completed`, `Victory`, `Defeat` or `Aborted`, and serves for a whole encounter and for each phase.

### Running the phases

`EncounterPhases.RunAll(phases, context, ct)` plays a list in order:

- a cancelled token returns `Aborted`
- a shown end screen (`IEndGameScreen.IsShown`) stops the list
- a null entry is skipped
- a phase that returns `Aborted` stops the list and aborts it
- the last `Victory` or `Defeat` a phase returned is the list's outcome, otherwise `Completed`

`CombatPhase` runs its branches through the same method, so a branch is just a nested phase list.

### The runner

`EncounterRunner` plays one encounter at a time. A second `Run` while one is live is refused with a warning and returns `Aborted`, rather than queued. Each run mints a fresh `EncounterId` (a counter, not persisted) and holds it in `Current` while `InEncounter` is true. A cancellation or an exception thrown by a phase ends the run as `Aborted` (the exception is logged), so a broken phase cannot leave the runner claiming an encounter is live.

`IEncounterService` (`InEncounter`, `Current`) is the read side that Systems code sees. `IEncounterRunner` adds `Run` and lives in Engine with the definitions.

While `InEncounter` or `InCombat` is true:

- `LevelTravel.TryExit` refuses to take the party to another level
- `SaveGameStateStep` skips the autosave it writes when the level shuts down (it also skips after a defeat)

### Starting an encounter

`StartEncounterStep` is an `ILevelLifecycleStep` that names one `EncounterDefinition` in `_encounter`. On `Initialize` it:

1. does nothing if no encounter is set
2. logs an error and does nothing if the encounter has no `Id`
3. does nothing if the player-state flag `encounter.<Id>.completed` is set
4. otherwise starts the run and returns at once

The level load does not wait for the encounter, since a conversation would hold the pipeline open for as long as the player reads. When the run ends in `Completed` or `Victory`, the step sets the flag to 1, and the flag is saved with the player's progression. A `Defeat` or `Aborted` run leaves it unset, so the encounter plays again on the next load. `Shutdown` cancels a run still in progress.

List the step after `PlayerSpawnStep` and before `SaveGameStateStep`: it needs the party in the level, and shutdown runs the steps last to first.

### Shipped phases

All live in `Engine/Encounters/Phases`.

| Phase              | Fields                                                                   | Runs until                                                          | Returns |
|--------------------|--------------------------------------------------------------------------|---------------------------------------------------------------------|---------|
| `DialoguePhase`    | `_conversation` (`ArticyRef`)                                            | `DialogueService.PlayScripted` finishes the conversation             | `Completed` if it completed, else `Aborted`. A reference missing from the Articy database logs an error and returns `Completed` |
| `ExplorationPhase` | `_talkTo`, `_lockLeader`, `_bark`, `_barkEverySeconds`, `_blinkEverySeconds` | the party finishes a conversation with `_talkTo`, or picks it up    | `Completed`; `Aborted` on cancel |
| `JoinPartyPhase`   | `Members` (`SerializablePrefabId` list)                                  | at once                                                             | `Completed` |
| `CombatPhase`      | `Music` (`MusicId`, default `Combat`), `OnVictory`, `OnDefeat`           | the fight ends and its branch has played                             | see below |
| `WaitPhase`        | `_seconds`                                                               | `_seconds` of unpaused game time (`IGameClock.Delay`)               | `Completed`; `Aborted` on cancel |
| `WinScreenPhase`   | none                                                                     | at once                                                             | `Completed`, after `IEndGameScreen.Show(EndScreen.Victory)` |

`DialoguePhase` is what makes a scripted opener possible: nobody has to walk up to an NPC.

**`ExplorationPhase`** watches `ActionLedger.OnActionRecorded` and reads the newest record:

- a `ConversedPayload` whose owner is linked to the `_talkTo` Articy object ends the phase
- a `PickUpItemPayload` for an item linked to `_talkTo` ends it too. An `IDialogueItem` that talks once taken (`DialogueAfterPickup`) ends it when that conversation finishes instead
- with no `_talkTo` set, any finished conversation with an entity ends it, and pickups never do

While it runs, `_lockLeader` sets `IPartyService.LeaderLocked`, so the player cannot hand the lead over. `_bark` is said through `IBarks.Say` every `_barkEverySeconds` while no conversation is open. When that is 0 it is said once at the start, and only if no conversation is open then. With `_blinkEverySeconds` above 0, every entity linked to `_talkTo` that owns a conversation blinks its outline, for `OutlineLayers.BlinkSeconds` per period, and goes dark as soon as a line is shown. Everything is unhooked and the lock released in `finally`.

**`JoinPartyPhase`** finds every `PlayerAgent` in the level whose `PrefabId` is in `Members`, clears its `IsNeutral` and adds it to the party ([[Party System#The roster and joining|Party System]]). A member not standing in the level is a warning, not a failure.

### Fights: CombatPhase

```
CombatPhase.Run
  ├─ IMusicService.PushOverride(Music)
  ├─ Fight: subscribe CombatEnded → CombatEncounterStarter.StartEncounter() → await the outcome
  ├─ RunAll(OnVictory | OnDefeat)            — nothing for Completed or Aborted
  ├─ outcome = the branch's, unless it is Completed, then the fight's
  ├─ Defeat → IEndGameScreen.Show(EndScreen.Defeat), combat music left playing under it
  └─ otherwise dispose the music override
```

The fight's own turns, initiative and end conditions belong to [[Turn System]]. A cancelled token while fighting returns `Aborted`, and a branch that aborts aborts the phase. A won fight shows nothing by itself: the victory branch closes the run with a `WinScreenPhase` if it should.

### Defeat

The defeat screen comes up on one of two paths:

- **In a fight** — `PartyDefeatedCondition` ends combat as `Defeat`, `CombatPhase` plays `OnDefeat`, then shows `EndScreen.Defeat`. A fight started outside an encounter (F9, console) has no `CombatPhase`, so it ends in exploration with no screen
- **Out of combat** — `DeathService` shows `EndScreen.Defeat` when a party member's health runs out while no member has health left. Otherwise a party member whose health runs out goes `Dying` ([[Status Effects System#Dying]])

Once the screen is shown, `RunAll` stops before the next phase.

### Example: DemoArenaOpening

`DemoArenaDefinition` ends its lifecycle steps with a `StartEncounterStep` that plays `Data/Encounters/DemoArenaOpening.asset`:

```
DialoguePhase                  — the scripted opener
ExplorationPhase               — talk to the awaited NPC; leader locked, a bark every 8 s, a blink every 2 s
JoinPartyPhase                 — colt joins
CombatPhase (Music: Combat)
  OnVictory: Wait 1 s → DialoguePhase → Wait 0.8 s → WinScreenPhase
  OnDefeat:  Wait 1 s → DialoguePhase → Wait 0.8 s        (CombatPhase shows the defeat screen)
```

`Prison_Cells_Start` (0.2.0) plays no encounter yet.

### Debugging

- **F9** (`CombatDebugHotkey`, debug builds) — `StartEncounter()` in exploration, `EnterExploration()` in combat
- **`encounter` console command** — reports the encounter id, the mode, the turn number and the initiative order (acting agent starred), and drives the fight: `encounter:start:<agent>...` with a chosen cast, `encounter:end`, `encounter:skip` (ends the acting turn), `encounter:remove:<agent>` (drops a combatant from the order without killing it), `encounter:order:<agent>...` (`LeadNextEncounter`). It drives the combat encounter, not an authored one, and prints `InEncounter` / `Current` from `IEncounterService`

---

## Divergence from the GDD

[[Core Loop#Encuentros|Core Loop]] asks for narrative and combat encounters, and phases cover both. How a fight starts is not stated outright; [[Sigilo]] describes the detection and the ambush around it:

| Topic             | GDD                                                                                                  | Code                                                                                        |
|-------------------|------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|
| Detection         | each enemy detects the party on its own: vision ranges (green, yellow, red) and sound ranges, contested by stealth | none, and no stealth. A fight starts only from a `CombatPhase`, F9 or the console    |
| Who fights        | not specified                                                                                        | every standing actor in the level (`CombatEncounterStarter`)                                |
| Ambush            | a fight opened by a sneak attack gives the party one turn before initiative                          | not wired. `LeadNextEncounter` can put agents first, but only the `encounter:order` console command calls it |
| Sides             | factions exist in the narrative ([[Culto al Sol]]); no mechanical faction rules                      | the party line only ([[Party System#Hostility\|Party System]])                               |

---

## Adding a New Encounter

1. Create an `EncounterDefinition` (*EternalDusk/EncounterDefinition*) under `Data/Encounters` and set `_id`. Once a save may hold it, never change it: the completed flag is keyed on it
2. Add its phases to `Phases`
3. Add a `StartEncounterStep` to the level definition's `LifecycleSteps`, after `PlayerSpawnStep` and before `SaveGameStateStep`, with `_encounter` pointing at the asset

To play it again on a level that already finished it, clear `encounter.<id>.completed` from the player state.

---

## Adding a New Encounter Phase

1. Add a `[Serializable] sealed` class in `Engine/Encounters/Phases` implementing `IEncounterPhase`, its authored data in `[SerializeField]` fields
2. Reach services through `IEncounterContext`. A service it lacks goes on `IEncounterContext` and `EncounterContext`'s constructor
3. Return `Completed` when done and `Aborted` when the token is cancelled. Return `Victory` or `Defeat` only if the phase decides the encounter's result
4. Unhook every event in `finally`, as `ExplorationPhase` and `CombatPhase` do: an encounter can be cancelled at any await
