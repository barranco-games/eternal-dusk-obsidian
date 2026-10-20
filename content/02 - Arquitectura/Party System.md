## Overview

The party is the set of agents the player controls, and one of them is the leader. `PartyService` (Systems) holds the members in order and the leader's id, behind `IPartyService` (Core). It is registered in the root scope, so it outlives a scene: each level fills it as it loads and clears it as it unloads.

Membership does more than decide who the player commands. The party line is also the only hostility rule the game has: an agent is hostile to another when exactly one of the two is in the party. And the party's sight is what lifts the fog and shows the entities around it.

---

## Key Concepts

### Layered types

| Layer    | Types                                                                                                                       |
|----------|-----------------------------------------------------------------------------------------------------------------------------|
| Core     | `IPartyService`, `PartyServiceExtensions` (`Contains`, `AreHostile`) in `Core/Party`; `INeutral` in `Core/World`             |
| Gameplay | `PartyData`, `PartyMemberReference` (`Gameplay/Persistence/Player`)                                                          |
| Systems  | `PartyService`, `LeaderCycleInput` (`Systems/Party`); `PartyTurnLeader` (`Systems/Turns`); `PartyPresenter` (`Systems/UI/Party`); `PartyCommand` (`Systems/Commands/Party`) |
| Engine   | `PlayerAgent` (implements `INeutral`); `PlayerSpawnStep`, `PartyRosterEntry`; `JoinPartyPhase`; `PartyRevealerSource`, `OutsiderRevealerSource`, `PartySightConcealer`; `PlayerStateSavable`; `CameraLeaderFollower` |

`RootInstaller` registers `PartyService` as `IPartyService` (lazy singleton). `InputInstaller` registers `LeaderCycleInput` eagerly.

### Members and the leader

```csharp
public interface IPartyService
{
    IReadOnlyList<IEntity> Members { get; }
    EntityId LeaderId { get; }
    bool LeaderLocked { get; set; }
    event Action<IEntity> OnMemberAdded;
    event Action<IEntity> OnMemberRemoved;
    event Action<EntityId> OnLeaderChanged;
    event Action OnLeaderLockChanged;
    void Add(IEntity entity);
    void Remove(IEntity entity);
    void SetLeader(EntityId entityId);
    void Clear();
}
```

Members are typed `IEntity`. `PlayerSpawnStep` and `JoinPartyPhase` only add `PlayerAgent`s, so in play that is what every member is (the console can add any entity). Readers that need more cast (`IAgent`, `IActor`).

| Call        | Does                                                                                                                              |
|-------------|-----------------------------------------------------------------------------------------------------------------------------------|
| `Add`       | ignores a member already in. The first member becomes leader: `OnMemberAdded`, then `OnLeaderChanged`                            |
| `Remove`    | if the leader leaves, the first remaining member leads (`OnLeaderChanged`); then `OnMemberRemoved`. An empty party has `LeaderId` = default |
| `SetLeader` | no-op for the current leader; throws `InvalidOperationException` for an id outside the party                                      |
| `Clear`     | removes members last to first, raising `OnMemberRemoved` for each, and resets `LeaderId` without raising `OnLeaderChanged`        |

`LeaderLocked` stops the player handing the lead over and makes the party HUD show the leader alone. Only `ExplorationPhase` sets it, when its `_lockLeader` is on, for the length of the phase ([[Encounter System#Shipped phases|Encounter System]]). `PartyTurnLeader` ignores it in combat.

There is no size cap and no reserve: `Members` is the whole party.

### What the leader is for

Outside combat the leader is the one agent the player drives. The other members stay where they are: nothing makes them follow. The main readers:

| Reader                        | Uses the leader to                                                        |
|-------------------------------|---------------------------------------------------------------------------|
| `GroundClickMovementInput`    | move: a ground click walks the leader                                     |
| `PointerInteractionService`   | interact: a clicked entity is dispatched with `InteractionContext(LeaderId)` |
| `CameraLeaderFollower`        | point the focus camera at the leader whenever it changes                  |
| `LevelTravel.TryExit`         | leave the level: only the leader walking out takes the party along        |
| `ItemPickupService`           | pick up: the leader walks to the item and takes it                        |
| `DialogueScriptMethods`       | dialogue stat checks: `StatCheck` and `Roll` read the leader's stats      |
| `ArticySpeakerResolver`       | pick a speaker: the intended entity if it is linked to the Articy object, else the linked one nearest the leader |
| `LeaderResourcePresenter`, `LeaderStatusEffectsPresenter`, `ActionPointPoisonPresenter` | show the leader's AP and health, its poisoned AP and its statuses on the HUD |

### Changing the leader

- **Cycle key** — `LeaderCycleInput` hands the lead to the next member in `Members` order, wrapping after the last. It does nothing while paused, while the HUD is hidden, while `LeaderLocked` is set, or with fewer than two members
- **Portrait click** — `PartyPresenter` calls `SetLeader` with the clicked member. While locked it shows only the leader, so there is nothing else to click
- **Combat** — `PartyTurnLeader` moves the lead with the turn. A party run keeps a leader already inside it, otherwise its first agent leads, and when the leader passes, the first member in initiative order still acting takes over ([[Turn System#Ending a turn|Turn System]])
- **Console** — `party:leader:<entity>`

### The roster and joining

Each level's `PlayerSpawnStep` names its player agents in `Roster`, a list of `PartyRosterEntry`:

```csharp
public struct PartyRosterEntry
{
    public SerializablePrefabId PrefabId;
    public bool StartsJoined;
}
```

On `Initialize` the step:

1. throws if no entry `StartsJoined`
2. spawns every roster entry: the first on the spawn point's leader spot, the rest on its follower spots, or `FollowerSpacing` (1.5 m) apart beside the leader when the spawn point runs out of spots
3. restores each from the save, if there is one
4. counts a member as joined when it `StartsJoined` or the saved `PartyData` lists it, and sets `IsNeutral = !joined` on every one
5. registers them all, hands the whole roster to `IPlayerState.SetRoster`, and `Add`s the joined members in their saved order
6. makes the saved leader the leader, or the first joined member

`Shutdown` clears the party and the roster. A member who has not joined still stands in the level, as a neutral `PlayerAgent`.

Later joins come from `JoinPartyPhase`, which clears `IsNeutral` and calls `Add` ([[Encounter System#Shipped phases|Encounter System]]), or from the console (`party:add:<entity>`, which leaves `IsNeutral` as it was). `DemoArena` starts with `lorenzo` joined and `colt` waiting, and its opening encounter brings colt in.

Nothing in play removes a member. Death does not: a dead member stays in `Members`. `EntityFactory.Despawn` removes a despawned entity, and the console has `party:remove:<entity>`.

### Neutral agents

```csharp
public interface INeutral
{
    bool IsNeutral { get; }
}
```

`PlayerAgent` is the only implementation. `IsNeutral` is true while it stands in the level without having joined. Neutrality matters to:

- **Hostility** — see below
- **Ammunition** — `ItemPickupService` gives picked-up rounds to the picker if it has a magazine, else to the first member with one, else to a neutral agent with one

### Hostility

```csharp
public static bool AreHostile(this IPartyService party, EntityId self, IEntity other) =>
    other is not INeutral { IsNeutral: true } && party.Contains(self) != party.Contains(other.EntityId);
```

`self` and `other` are hostile when exactly one of them is in the party, unless `other` is neutral. Only `other` is checked for neutrality: a neutral `self` outside the party still finds every party member hostile, and every other outsider friendly.

| Reader                       | Asks                                                                             |
|------------------------------|----------------------------------------------------------------------------------|
| `TargetEligibility`          | whether a skill's ally-only or hostile-only filter takes an actor                |
| `AIService`                  | which simulated agents are the planner's allies ([[Enemy AI#Hostility and awareness\|Enemy AI]]) |
| `PlanStepRunner`             | how many hostiles an AI step struck                                              |
| `SkillLab`                   | the debug lab's hostile filter                                                   |

Not every reader goes through `AreHostile`. `NoHostilesRemainCondition` counts any living agent outside the party as hostile, neutral or not, and `AITurnController` plays every agent outside the party. A neutral `PlayerAgent` left standing when a fight starts would be in it, be played by the AI and keep the fight from being won. `DemoArena` has colt join before its fight.

### Downing

`DeathService` sets `IAgent.CanBeDowned` on members as they join and clears it as they leave. A member whose health runs out goes `Dying` rather than dying, and any other actor dies. When the whole party is down out of combat, it is a defeat ([[Encounter System#Defeat|Encounter System]], [[Status Effects System#Dying]]).

### Shared sight

The party sees as one. Each member is an `AgentRevealer` on its own `SightRange`, added by `PartyRevealerSource` to the fog, vision and party-sight areas as it joins, removed as it leaves, and resized when its `SightRange` stat changes. `PartySightConcealer` hides every `IConcealable` entity outside the party that is not `AlwaysVisible` until the party's sight lights its cell. `OutsiderRevealerSource` keeps one hard-coded agent outside the party (prefab `colt`) lighting the vision area, and only that area, until he joins. `AreaService.SetupVisionArea` wires it in every level, marked demo only. The grid side is in [[Area System#Revealer Sources|Area System §13]].

Enemies have no such sight of their own. Within a fight they share what they have seen of the party ([[Enemy AI#Hostility and awareness|Enemy AI]]).

### Combat

Consecutive party agents in the initiative order act as one merged run, the player passes the leader through `ManualTurnRouter`, and `IActiveTurn.PlayerMayAct` admits a member only while its run is acting ([[Turn System]]). Agents outside the party are played by `AITurnController`. The fight ends in `Victory` when no living agent outside the party remains in it, and in `Defeat` when no party member in it has health left.

### Saving

`PlayerStateSavable.CaptureTyped` writes a `PartyData` (`"party"`, version 1): each member's `EntityId` with its `PartyOrder`, and the `Leader`. Its agent list holds the members and every roster agent who has not joined, so a waiting member keeps its state. `PlayerSpawnStep` restores both on the next load. The save format is in [[Save & Load System]].

### Debugging

The `party` console command: `party` reports the party, `party:<entity>` or `party:leader:<entity>` sets the leader, `party:add:<entity>` and `party:remove:<entity>` change membership.

---

## Divergence from the GDD

[[Party]] describes a different party from the code:

| Topic             | GDD                                                                                     | Code                                                                      |
|-------------------|-----------------------------------------------------------------------------------------|---------------------------------------------------------------------------|
| Size              | up to 4 active agents, more waiting in the caravan                                      | no cap, no reserve                                                        |
| Splitting         | the party can split into small groups or single agents, to explore or set up a fight    | only the leader moves; the rest stay put. Switching leader moves one agent at a time, with no groups |
| Changing members  | only at the [[Campamento]]                                                              | an encounter adds them (`JoinPartyPhase`); there is no camp, and nothing removes one |
| Party values      | Mythos (hidden), mood (wishlist), group stats (averages of the members)                 | none                                                                      |
| New zone          | the party regroups                                                                      | matches: on arrival every member spawns on the spawn point's spots        |

[[Sigilo]] has stealth put the game into turns with each agent controlled alone; there is no stealth mode. Factions exist in the narrative ([[Culto al Sol]]) but not in the hostility rule, which is the party line alone.

---

## Adding a Party Member to a Level

1. Add a `PartyRosterEntry` to the level's `PlayerSpawnStep.Roster` with the agent's `PrefabId`. Order sets the spawn spot: the first entry stands on the leader spot
2. Set `StartsJoined` to start in the party, or leave it clear and add a `JoinPartyPhase` naming the prefab to an encounter. Until then the agent stands in the level as a neutral `PlayerAgent`
3. Make sure no fight starts while it is neutral (see [[#Hostility]])

---

## Adding a New Leader-Driven Input

Read `IPartyService.LeaderId` when the input fires rather than caching it, and gate it on `IActiveTurn.PlayerMayAct(leader)` as `GroundClickMovementInput` does, so it is refused outside the leader's combat turn. If the input should stop while the lead is locked, check `LeaderLocked` too.
