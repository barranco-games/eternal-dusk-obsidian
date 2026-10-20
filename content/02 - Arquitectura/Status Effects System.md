## Overview

A status effect is a lasting condition on an actor: a burn, a poison, a shield, lying dying. Each actor owns one `ActorStatusEffects` (Systems), its `IStatusEffectController`, which holds at most one status per `StatusEffectType` and is the single point of contact for applying, removing, ticking and querying them. A status is a `StatusEffect` subclass (Gameplay) with a `StatusDuration` (Core).

The system works at two levels:

- **Composed statuses** — a `ComposedStatus` whose whole behaviour is a list of `StatusBehaviour`s authored on a `ComposedStatusDefinition` asset. Burning, Poisoned, Berserk, Weakened and Shielded are built this way, with no code of their own
- **Coded statuses** — `Dying`, `Overloaded` and `Provoked`, which keep state a list of behaviours cannot (a turn count, a hidden clock, a provoker)

Statuses reach the rest of the game through hooks the controller sums over every active status: damage in and out, rolls, activity gates, AP recovery.

---

## Key Concepts

### Layered types

| Layer    | Types                                                                                                              |
|----------|--------------------------------------------------------------------------------------------------------------------|
| Core     | `StatusEffectType`, `StatusEffectTypes`, `StatusDuration`                                                          |
| Gameplay | `StatusEffect`, `ComposedStatus`, `StatusBehaviour` (`DamageAdjustment`, `StatModifierBehaviour`, `DamageOverTime`), `Dying`, `Overloaded`, `Provoked`, `StatusProfile`, `StatusDefaults`, `StatusEffectSnapshot`; contracts `IStatusEffectController`, `IStatusEffectService`, `IStatusEffectLibrary` |
| Systems  | `ActorStatusEffects`, `StatusEffectService`; `DeathService` (`Systems/World`) applies and clears `Dying`           |
| Engine   | `StatusEffectDefinition` and its subclasses, `SerializableStatusBehaviour`, `StatusDurationConfig`, `StatusEffectCatalogSO`, `StatusEffectParticles`; the skill effects that apply statuses (`Engine/Actions/Effects`) |

`Actor.Initialize` builds the controller, `new ActorStatusEffects(this, dice)`, and `StatusEffectCatalogSO` is registered at the root as the `IStatusEffectLibrary`.

### Type ids are numbered by hand

```csharp
public enum StatusEffectType : byte
{
    None = 0,
    Burning = 3, Poisoned = 4, Berserk = 5, Weakened = 21,
    Dying = 16, Overloaded = 18, Provoked = 19, Shielded = 20
}
```

Assets and saves store the number, and the gaps are statuses since removed. A new status takes a number never used before, and no number is ever reused. `StatusEffectTypes.Capacity` sizes every array indexed by type.

### One slot per type

`ActorStatusEffects` keeps a `StatusEffect[StatusEffectTypes.Capacity]` indexed by type, plus the active list in the order effects landed (`ActiveEffects`).

```csharp
public bool Apply(StatusEffect effect)
{
    var existing = _effects[(byte)effect.Type];
    if (existing != null)
    {
        existing.Refresh(_owner, effect);   // default: keep the longer duration
        return false;                       // OnDurationChanged if the turns moved
    }

    // store, effect.OnApply(_owner), OnChanged(type)
    return true;
}
```

Re-applying never stacks: the status already there decides what a second application means through `Refresh`. `Remove(type)` calls `OnRemove` and raises `OnChanged`. `OnChanged` fires when a status lands or leaves, and `OnDurationChanged` when its remaining turns change, by a tick or a refresh. The aggregate hooks walk the array in type order, not in the order statuses landed.

### Duration

`StatusDuration` is a value: `Turns` and `IsPermanent`.

- `ForTurns(n)` clamps to at least 1, and `Permanent` never expires
- `Tick()` takes one turn off. `Expired` is a non-permanent duration at 0 turns or fewer
- `Longest(other)` is the default refresh. Permanent wins, otherwise the higher turn count
- `Restored(turns, permanent)` rebuilds a saved duration exactly, an expired one included

Durations are authored with `StatusDurationConfig` (`Mode` Turns or Permanent, `Turns` ≥ 1) on each definition.

### The turn-start tick

`Actor.BeginTurn` calls `StatusEffects.OnTurnStart()` at the start of the owner's turn ([[Turn System#What a turn start does to an actor|Turn System]]). For each slot:

```
expired?  → OnRemove, clear the slot, OnChanged         (the status is gone this turn)
otherwise → OnTurnStart(owner, dice)                    (burn, Overloaded's clock)
            still in its slot? → AdvanceDuration(), OnDurationChanged
```

So the turn a status lands on is free, and a status at 0 has already had its last turn. A status applied with `ForTurns(2)` on an enemy's turn acts on the owner's next two turns and is removed at the start of the third. This is the GDD's rule: durations count down at the start of the owner's turn ([[Estados]]).

Who ticks when follows the turn system. In combat, agents tick when their acting run starts and non-agent actors in the world phase. Out of combat, every actor ticks on each exploration turn, so a 3-turn burn lasts three exploration turns.

### Hooks a status can override

| `StatusEffect` member                        | Called from                                                         | Shipped users            |
|----------------------------------------------|---------------------------------------------------------------------|--------------------------|
| `OnApply` / `OnRemove`                       | `Apply` / `Remove`, and expiry                                      | all                      |
| `OnTurnStart(target, dice)`                  | the turn-start tick                                                 | Burning, `Overloaded`    |
| `ModifyOutgoingDamage` / `ModifyIncomingDamage` | `EffectContext.DealDamage`, before resistance ([[Combat & Dice#Damage pipeline\|Combat & Dice]]) | Berserk, Weakened, Shielded |
| `OnOwnerRolls` / `OnRollAgainstOwner`        | `AttributeCheckService.Check`, through `ContributeAsRoller` / `ContributeAsTarget` | none yet |
| `Blocks(ActivityKind)` / `Allows(ActivityQuery)` | `CanStart` (the activity gate) and `StatusEffectService.Apply` (interrupt) ([[Action System#11. Status Effect Integration\|Action System §11]]) | none yet |
| `BlocksRecovery(ResourceType)`               | `AllowsRecovery`, read by `Agent.BeginTurn` before the AP refill    | `Overloaded`             |
| `Refresh(target, incoming)`                  | `Apply` on an occupied slot                                         | `Overloaded`, `Provoked` |
| `Profile`                                    | readers that do not run the status (below)                          | composed statuses        |

Damage hooks run in type order, so a floor such as Weakened's sees the hit after every lower-numbered status changed it.

### Composed statuses

`ComposedStatus(type, duration, behaviours)` runs its behaviours in the authored order, skipping nulls, and builds its `Profile` from each behaviour's `Describe`. Its `OnTurnStart` stops as soon as a behaviour has taken the status off its owner (a burn that downs it).

| Behaviour               | Does                                                                                           |
|-------------------------|------------------------------------------------------------------------------------------------|
| `DamageAdjustment`      | adds `Amount` to every hit dealt (`Outgoing`) or taken (`Incoming`); a negative amount stops at `Floor` and leaves a hit already under the floor as it was |
| `StatModifierBehaviour` | holds one `StatsModifier` on the owner from `OnApply` to `OnRemove` ([[Stats System#Modifier lifetime separation\|Stats System]]) |
| `DamageOverTime`        | at the owner's turn start, rolls its `Damage` and deals it through `EffectContext.DealDamage` with no caster, so incoming modifiers and resistance apply |

`StatusBehaviour` exposes only `OnApply`, `OnRemove`, `OnTurnStart`, the two damage hooks and `Describe`. A status that needs rolls, activity blocks or recovery blocks is a coded status.

Authoring: a `ComposedStatusDefinition` asset (menu *EternalDusk/Status Effects/Status Effect*) sets `_type`, `_duration` and `_behaviours`, a `[SerializeReference]` list of `SerializableDamageAdjustment`, `SerializableStatModifier` and `SerializableDamageOverTime`. Each converts to its Gameplay behaviour in `ToGameplay` and prices itself for the AI in `Simulate`. The base `StatusEffectDefinition` also carries `_particles`, a looping effect `StatusEffectParticles` keeps on the actor while the status lasts.

### Shipped statuses

All eight definitions live in `Assets/Data/StatusEffects` and are listed on `StatusEffectCatalog.asset`:

| Status     | Id | Definition             | Duration  | Does                                                                     |
|------------|----|------------------------|-----------|--------------------------------------------------------------------------|
| Burning    | 3  | composed               | 3 turns   | 1D4 Fire at each turn start (`DamageOverTime`)                           |
| Poisoned   | 4  | composed               | 2 turns   | MaxAP −1 (`StatModifierBehaviour`)                                       |
| Berserk    | 5  | composed               | 2 turns   | +2 on hits dealt, +2 on hits taken                                       |
| Dying      | 16 | `DyingDefinition`      | permanent | see [[#Dying]]                                                           |
| Overloaded | 18 | `OverloadedDefinition` | 2 turns   | see [[#Overloaded]]                                                      |
| Provoked   | 19 | `ProvokedDefinition`   | 1 turn    | see [[#Provoked]]                                                        |
| Shielded   | 20 | composed               | 1 turn    | +15 to every resistance, −4 on hits taken (floor 0)                      |
| Weakened   | 21 | composed               | 2 turns   | −2 on hits dealt, never below 1                                          |

`StatusDefaults.TryCreate` rebuilds Berserk, Weakened, Poisoned and Shielded in code, for tests and for a harness running without the catalog. `StatusDefaults.Burning(damage, duration)` needs its damage passed in, so without the catalog nothing can build Burning by type. `StatusEffectDefinitionTests` pins those four assets against `StatusDefaults`, and `Dying.asset` against the `Dying` and `HitChance` constants.

### Dying

Moribundo. `DeathService` decides what running out of health means. A hostile dies and leaves the initiative order ([[Turn System#Removal mid-encounter|Turn System]]). A party agent (`IAgent.CanBeDowned`, which `DeathService` sets for party members) is downed instead:

1. its health reaches 0, and `Actor` sheds every status
2. `DeathService` applies `Dying` through `IStatusEffectService`, built from the library, or `new Dying()` if none builds it
3. `Dying.OnApply` removes anything else left and adds one modifier: MaxAP down to half rounded up (a flat penalty, since a 0.5 multiplier would round half to even), Movement ×0.5, Precision −60 (35 − `HitChance.BasePrecision`, so 35 with no other precision modifier). Current AP is clamped to the new maximum
4. each `OnAgentTurnStarted` for it calls `RecordTurn()`. In the world phase, a dying agent with `TurnsTaken` ≥ `DeathService.DyingTurns` (3) is killed
5. a heal from 0 stands it up (`Dying` removed), and a won fight gives each dying member `HealthAfterCombat` (1) HP

A dying agent is not dead (`IsAlive()` in `ActorStateExtensions`): it stays in the order and fights on. `DyingSkills` applies each skill's `SkillData.WhileDying` (disabled, extra AP cost, damage modifier, shorter range). Out of combat nothing counts dying turns. If the last party member standing runs out of health there, the run closes on the defeat screen.

### Overloaded

The Overcharge debt, on a three-turn clock (apply turn, bonus turn, debt turn), so its duration is 2:

| Owner turn  | Effect                                                                                  |
|-------------|-----------------------------------------------------------------------------------------|
| apply       | MaxAP + `_apBonus` (2), then `_apBonus` AP restored. The ceiling rises first, or the restore would clamp the bonus away |
| bonus turn  | the normal refill, against the raised ceiling                                           |
| debt turn   | the ceiling drops, `BlocksRecovery(ActionPoints)` skips the refill, and `_debtRecovery` (2) AP are restored instead |

A recast is a fresh cast: `Refresh` resets the duration and the clock and grants the AP again.

### Provoked

The Taunt compulsion: a failed Power check leaves the owner compelled to close on `Provoker` and attack it in melee. The status records the provoker (the caster), and a fresh provocation re-points it. Nothing acts on it yet: the AI only prices it as a hindrance (`StatusValue`). It is a marker on purpose, rather than a restriction the GDD does not describe.

### Applying and removing

| Source                              | Path                                                                                   |
|-------------------------------------|----------------------------------------------------------------------------------------|
| `ApplyStatusEffect`                 | `context.Target.StatusEffects.Apply(definition.Create(caster, target))`. Not an attack, so a skill made only of statuses never rolls to hit |
| `ApplyStatusOnFailedCheckEffect`    | target agent rolls an attribute check with the caster as opponent. Success is tallied as resisted; failure deals the authored damage, if any, and applies the status. Fire surfaces apply Burning this way on entry (`FireDefinition`, Constitution) |
| `RemoveStatusEffect`                | `context.Target?.StatusEffects.Remove(type)`                                           |
| `DeathService`                      | `IStatusEffectService.Apply` / `Remove` for `Dying`                                    |
| save restore                        | `Agent.RestoreStatusEffects`, below                                                    |
| `status` command                    | `StatusCommand` builds through `StatusEffectFactory`: the library when the context has one, `StatusDefaults` otherwise. `Provoked` and `Overloaded` are not supported |

The first three are `IEffect`s, run by skills and by surfaces on entry ([[Area System#The turn pass|Area System §17]]). They call the controller directly, so the interrupt-on-apply in `StatusEffectService.Apply` ([[Action System#As an interrupter|Action System §11]]) only runs for `Dying` today. No shipped status blocks an activity, so nothing is lost yet. A blocking status applied by an effect would have to go through the service.

Dead actors carry no statuses: `Actor` removes any status that lands on one at once.

### Readers that do not run a status

`StatusProfile` summarises what a status does to its owner's numbers: `MaxApChange` and the damage adjustments (`AdjustOutgoing`, `AdjustIncoming`, `OutgoingAmount`, `IncomingAmount`). The AI's simulation copies each active status's profile into `SimulatedAgentState` ([[Resources System#Simulation|Resources System]]), and `StatusValue` scores statuses for the planner. `ActionPointPoisonPresenter` shows the AP that Poisoned takes away. On a skill, `StatusEffectDefinition.Simulate(target, chance)` records the status at its hit chance, and `SerializableDamageOverTime` adds its damage over the duration (a permanent one is priced for 3 turns).

### Saving

Only agents save statuses. `StatusEffectSnapshot.TryCapture` writes a `StatusEffectData` (`Type`, `Turns`, `Permanent`), plus `TurnsTaken` for `Dying` and `SourceId` (the provoker) for `Provoked`. On load, `TryRestore` rebuilds `Provoked` in code and every other type from the library with its saved duration. `Dying` comes from the library too, so authored `DyingDefinition` values survive a load, and gets its `TurnsTaken` back. With no library it falls back to the code defaults. `Overloaded` is not saved: its hidden clock cannot be rebuilt. Any other `StatusEffect` subclass is dropped unless it gets its own case. See [[Save & Load System]].

### UI and VFX

`StatusEffectsBinding` keeps one view showing the effects of whichever actor was bound last. It backs the party leader's icon strip (`LeaderStatusEffectsPresenter`), the party panel (`PartyPresenter`) and the world-space health bar (`ActorHealthBarPresenter`). The icons come from `StatusEffectIconCatalogSO`. `StatusEffectParticles` spawns a definition's particles the first time its status lands and reuses them after.

---

## Divergence from the GDD

[[Estados]] describes these differently from the code:

| Status                 | GDD                                                                 | Code                                                                       |
|------------------------|---------------------------------------------------------------------|----------------------------------------------------------------------------|
| Berserk                | takes 1D4 more damage, deals 1D6 more                               | flat +2 taken, +2 dealt                                                    |
| Quemado (Burning)      | fixed damage each turn                                              | 1D4 Fire each turn                                                         |
| Envenenado (Poisoned)  | gains one AP less at turn start                                     | MaxAP −1, which with the full refill takes one AP a turn and also lowers the cap |
| Moribundo (Dying)      | incapacitated, spends its turns on Constitution rolls; three passed and it is back | keeps fighting on half AP, half movement and 35 precision; dies in the world phase after 3 dying turns; a heal or a won fight stands it up |

Debilitado (Weakened, −2) matches, and the code adds a floor of 1. Durations ticking at the owner's turn start match.

Not built: Derribado, Sangrado, Descuidado, Vigilancia, Catatónico, Temblores, Paranoia, Pánico, Ceguera, Marcado, Ralentizado, Daga Clavada, Acorralado, Oculto. Sangrado and Daga Clavada stack, which one slot per type does not support. Overloaded, Provoked and Shielded are not on the Estados page; they come from skills (Overcharge, Taunt, Colt's Damage Reduction).

---

## Adding a New Composed Status

1. Add a value to `StatusEffectType` in `Core/StatusEffects/StatusEffectType.cs` with a number never used before
2. Create a *Status Effect* asset (`ComposedStatusDefinition`) in `Assets/Data/StatusEffects`: set the type, duration and behaviours, and particles if any
3. Add it to `StatusEffectCatalog.asset`, so the library can build it on load
4. Give it an icon in `StatusEffectIconCatalog.asset`, or it shows the fallback
5. Reference it from an `ApplyStatusEffect` or `ApplyStatusOnFailedCheckEffect` on a skill, or on a surface's on-enter effects
6. For tests and the harness, add a builder to `StatusDefaults` and a case to `StatusDefaults.TryCreate`, and pin it against the asset in `StatusEffectDefinitionTests`

---

## Adding a New Status Behaviour

1. Subclass `StatusBehaviour` in `Gameplay/StatusEffects` and override the hooks it needs; add to the profile in `Describe` if it changes AP or damage
2. Add its authored form to `SerializableStatusBehaviour.cs` (Engine): a `[Serializable]` subclass of `SerializableStatusBehaviour` with `ToGameplay`, and `Simulate` if the AI should price it beyond its profile

---

## Adding a New Coded Status

Needed when the status holds state or uses a hook `StatusBehaviour` does not have (rolls, `Blocks`, `BlocksRecovery`, a custom `Refresh`).

1. Subclass `StatusEffect` in `Gameplay/StatusEffects`
2. Subclass `StatusEffectDefinition` in `Engine/Unity/World/StatusEffects/Definitions` with `Create(caster, target)`; override `TryCreate` if it can be built without a cast, and `Profile` if the AI or HUD should see its numbers
3. Create its asset and add it to the catalog
4. Add a case to `StatusEffectSnapshot.TryCapture` and `TryRestore` for whatever it must keep; without one it is dropped on save
5. If it blocks an activity, apply it through `IStatusEffectService` so a held activity is interrupted