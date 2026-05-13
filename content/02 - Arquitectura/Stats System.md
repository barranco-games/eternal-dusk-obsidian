## Overview

The stats system is built around a clear separation between primitive calculation infrastructure, game rule definitions, and entity-level stat ownership. Stats are owned by `ActorStats` or its subclass `AgentStats`, which is the single point of contact for anything that wants to read or modify an actor's stats.

The system operates at two levels:

- **Base stats** — fixed values authored in `AttributeData` and `ResistanceData` ScriptableObjects
- **Modified stats** — base values passed through `StatsMediator`, which applies all active `StatsModifier` instances via `StatQuery`

---

## Folder Structure

```
Core/
└── Stats/
    ├── StatType.cs
    ├── ModifierMode.cs
    ├── ModifierEffect.cs
    └── StatQuery.cs

Gameplay/
├── DamageType.cs
└── Stats/
    ├── Attribute.cs
    ├── Aptitude.cs
    ├── CombatStat.cs
    ├── DerivedStat.cs
    ├── Resistance.cs
    ├── AttributeData.cs
    ├── ResistanceData.cs
    ├── StatsModifier.cs
    └── StatsMediator.cs

Systems/
└── Stats/
    ├── ActorStats.cs
    ├── AgentStats.cs
    ├── AttributeSet.cs
    ├── AptitudeSheet.cs
    ├── AptitudeFormulas.cs
    ├── DerivedStats.cs
    ├── ResistanceSet.cs
    └── Modifiers/
        ├── ModifierSystem.cs
        └── ActiveModifier.cs

Engine/
└── Stats/
    ├── AttributeDataSO.cs
    └── ResistanceDataSO.cs
```

---

## Layer Responsibilities

### Core
Pure C#. No Unity, no game rules. Contains the primitives the modifier bus runs on.

- `StatType` — short-backed enum; the unified bus type across all stat categories; numeric values are partitioned by category using fixed offsets
- `ModifierMode` — byte-backed enum; defines how a modifier effect is applied: `Flat`, `Percent`, or `Multiplier`
- `ModifierEffect` — readonly struct; pure data carrying a `StatType`, `ModifierMode`, and float value; no application logic
- `StatQuery` — mutable struct; carries a base value and three accumulator fields (`FlatBonus`, `PercentBonus`, `Multiplier`); resolved in a single explicit formula via `Resolve()`

### Gameplay
Depends on Core. Defines what stats exist and what modifiers look like.

- Typed stat enums (`Attribute`, `Aptitude`, `DerivedStat`, `CombatStat`, `Resistance`) — zero-based, clean; each has an extension method converting to `StatType` via a fixed offset
- `AttributeData` / `ResistanceData` — plain C# data classes; authored in the Engine layer via ScriptableObjects
- `DamageType` — flags enum; damage can be composite (e.g. `Explosive = Fire | Blunt`); resistance calculation averages the components
- `StatsModifier` — owns a list of `ModifierEffect`; handles a `StatQuery` by depositing into its accumulators; no knowledge of turns or expiry
- `StatsMediator` — owns the list of active `StatsModifier` instances; runs `PerformQuery` by passing a `StatQuery` through every modifier; fires `OnStatChanged` when modifiers are added or removed

### Systems
Depends on Core and Gameplay. Owns the live stat components and modifier lifecycle.

- `ActorStats` — base class; mandatory for any actor as they can be damaged; owns `ResistanceSet` and `StatsMediator`; exposes `AddModifier` / `RemoveModifier`
- `AgentStats` — extends `ActorStats`; adds `AttributeSet`, `AptitudeSheet`, `DerivedStats`, and `Sanity` for full agents
- `AttributeSet` — queries attributes through the mediator against `AttributeData` base values
- `AptitudeSheet` — queries aptitudes through the mediator; base values computed from `AptitudeFormulas` using live attribute values
- `AptitudeFormulas` — pure static functions; no dependencies; trivially testable
- `DerivedStats` — queries `MaxHP`, `Movement`, `MaxAP`, and `Initiative` through the mediator; `Initiative` rolls a D100 via `DiceRoller`
- `ResistanceSet` — queries resistances through the mediator; handles composite `DamageType` by averaging component resistances
- `ModifierSystem` — owns modifier lifetime externally to `StatsModifier`; tracks duration via `ActiveModifier`; removes expired modifiers each tick
- `ActiveModifier` — wraps a `StatsModifier` with duration tracking; sets `IsExpired` when `RemainingTurns` reaches zero

### Engine
Unity-specific. Composition root only — no logic.

- `AttributeDataSO` / `ResistanceDataSO` — ScriptableObjects that produce plain C# data via `ToData()`
- `EntityBehaviour` — constructs `StatsMediator`, `DiceRoller`, sub-components, and either `ActorStats` or `AgentStats` depending on what is assigned in the Inspector

---

## Key Concepts

### Composable stat ownership

Stats are not monolithic. `ActorStats` covers the minimum any damageable actor needs. `AgentStats` extends it for full agents. Engine decides which to instantiate based on what data is assigned:

```csharp
// Hazard or destructible — resistances only
var actor = new ActorStats(mediator, resistances);

// Full agent — everything
var agent = new AgentStats(mediator, resistances, attributes, aptitudes, derived, sanity);
```

No optional nullables, no feature flags — the type itself expresses the actor's capability.

### Typed stat enums with a unified bus

Each stat category has its own zero-based enum in Gameplay. `StatType` in Core is the unified bus type used by `StatQuery` and `StatsModifier`. The mapping is a fixed numeric offset per category:

| Category    | Offset | Example                              |
|-------------|--------|--------------------------------------|
| Attribute   | 0      | `Attribute.Strength = 0`             |
| CombatStat  | 10     | `CombatStat.Initiative = 2 → 12`     |
| DerivedStat | 20     | `DerivedStat.MaxHP = 0 → 20`         |
| Aptitude    | 30     | `Aptitude.Discover = 0 → 30`         |
| Resistance  | 100    | `Resistance.Standard = 0 → 100`      |

Each enum exposes `AsStatType()` which applies the offset via a single cast. This design is ready for source generation — when introduced, the generator replaces `StatType.cs` and the offset constants with no other changes required.

### StatQuery resolution

`StatQuery` is a mutable struct passed by `ref` through every modifier. Each modifier deposits into one of three accumulators. Resolution order is a single explicit formula:

```
Base + FlatBonus → apply PercentBonus → apply Multiplier
```

This means resolution order is never an emergent property of handler registration — it is always predictable regardless of the order modifiers were added.

```csharp
public int Resolve()
{
    int afterFlat = Base + FlatBonus;
    int afterPercent = (int)Math.Round(afterFlat * (1f + PercentBonus / 100f));
    return (int)Math.Round(afterPercent * Multiplier);
}
```

### Composite damage and resistance averaging

`DamageType` is a flags enum. Composite types like `Explosive = Fire | Blunt` decompose into their components during resistance calculation. The final resistance applied is the average of all component resistances:

```csharp
// Explosive damage against Fire=20, Blunt=40 → resistance = 30
int damage = stats.Resistances.ApplyTo(incomingDamage, DamageType.Explosive);
```

Adding a new composite damage type requires no changes to `ResistanceSet` — the flag decomposition handles it automatically.

### Modifier lifetime separation

`StatsModifier` knows nothing about turns or expiry — it only knows how to modify a query. Duration is external state managed by `ModifierSystem` through `ActiveModifier`:

```csharp
// Permanent modifier
modifierSystem.Add(modifier);

// Lasts 3 turns
modifierSystem.Add(modifier, turns: 3);

// Tick at end of turn — expired modifiers are removed automatically
modifierSystem.Tick();
```

This means `StatsModifier` can be reused across different duration strategies without modification.

### Sanity as a resource-driven stat

`Sanity` is a `BoundedResource` owned by the resource system, not a fixed base value. `AgentStats` holds a direct reference and exposes `Current` as a read-only stat:

```csharp
public int Sanity => _sanity.Current;
```

The `Sanity` resource's max is wired at construction in `EntityBehaviour`:

```csharp
sanity = Sanity.Create(() => attributes.Constitution / 4);
```

No coupling between the stat system and the resource system beyond this wiring point in Engine.

---

## Adding a New Aptitude

1. Add a value to `Aptitude` in `Gameplay/Stats/Aptitude.cs`
2. Add the formula to `AptitudeFormulas` in `Systems/Stats/AptitudeFormulas.cs`
3. Add the property and `Get()` case to `AptitudeSheet` in `Systems/Stats/AptitudeSheet.cs`

Nothing else in the system needs to change.

---

## Adding a New Damage Type

1. Add a flag value to `DamageType` in `Gameplay/DamageType.cs`
2. If it is a primitive type, add a corresponding value to `Resistance` and a `HasFlag` check in `ResistanceSet.GetComponents()`
3. If it is composite, define it as a combination of existing flags — `GetComponents` handles it automatically

---

## Classes at a Glance

| Class                | Layer    | Responsibility                                      |
|----------------------|----------|-----------------------------------------------------|
| `ActorStats`         | Systems  | Base stat owner; resistances + modifier bus         |
| `AgentStats`         | Systems  | Full agent stats; extends `ActorStats`              |
| `AttributeSet`       | Systems  | Live queried attribute values                       |
| `AptitudeSheet`      | Systems  | Live queried aptitude values                        |
| `AptitudeFormulas`   | Systems  | Pure static aptitude base value calculations        |
| `DerivedStats`       | Systems  | MaxHP, Movement, MaxAP, Initiative                  |
| `ResistanceSet`      | Systems  | Live queried resistance values; damage application  |
| `ModifierSystem`     | Systems  | Modifier lifetime, duration, expiry                 |
| `ActiveModifier`     | Systems  | Duration wrapper around `StatsModifier`             |
| `StatsMediator`      | Gameplay | Modifier list; query bus; change notification       |
| `StatsModifier`      | Gameplay | Query modification via `ModifierEffect` list        |
| `StatQuery`          | Core     | Accumulator struct; explicit resolution formula     |
| `ModifierEffect`     | Core     | Pure effect data; type, mode, value                 |
| `DiceRoller`         | Core     | `System.Random` backed; used for Initiative rolls   |
