## Overview

The stats system is built around a clear separation between primitive calculation infrastructure, game rule definitions, and entity-level stat ownership. Stats are owned by `ActorStats` or its subclass `AgentStats`, which is the single point of contact for anything that wants to read or modify an actor's stats.

The system operates at two levels:

- **Base stats** — authored values (`AttributeData`, `ResistanceData`, `DerivedStatsData`, edited through the `AttributeDataSO`, `ResistanceDataSO` and `DerivedStatsDataSO` ScriptableObjects). Derived stats and aptitudes start from a formula over the attributes (plus an authored base for derived stats), not from a fixed value
- **Modified stats** — every base value passed through `StatsMediator.PerformQuery`, which builds a `StatQuery` and lets all active `StatsModifier` instances adjust it

---

## Key Concepts

### Composable stat ownership

Stats are not monolithic. `ActorStats` covers the minimum any damageable actor needs: resistances plus `Precision` and `Evasion`. `AgentStats` extends it for full agents. The Engine entity class decides which to instantiate: `ObstacleActor` uses `ActorStats`, `Agent` builds `AgentStats` in `CreateStats`:

```csharp
// Hazard or destructible — resistances, precision and evasion only
var actor = new ActorStats(mediator, resistances);

// Full agent — everything
var attributes = new AttributeSet(definition.Attributes, mediator);
var resistances = new ResistanceSet(definition.Resistances, mediator);
var aptitudes = new AptitudeSheet(attributes, mediator);
var derived = new DerivedStats(attributes, definition.Derived, mediator, dice);
var agent = new AgentStats(mediator, resistances, attributes, aptitudes, derived);
```

No optional nullables, no feature flags — the type itself expresses the actor's capability.

### Typed stat enums with a unified bus

Each stat category has its own enum in Gameplay (not all are zero-based: `Resistance` starts at 1, `CombatStat.Precision` is 3). `StatType` in Core is the unified bus type used by `StatQuery` and `StatsModifier`. The mapping is a fixed numeric offset per category:

| Category    | Offset | Example                              |
|-------------|--------|--------------------------------------|
| Attribute   | 0      | `Attribute.Strength = 0`             |
| CombatStat  | 10     | `CombatStat.Precision = 3 → 13`      |
| DerivedStat | 20     | `DerivedStat.MaxHP = 1 → 21`         |
| Aptitude    | 30     | `Aptitude.Discover = 0 → 30`         |
| Resistance  | 100    | `Resistance.Fire = 1 → 101`          |

Each enum exposes `AsStatType()` which applies the offset via a single cast. This design is ready for source generation — when introduced, the generator replaces `StatType.cs` and the offset constants with no other changes required.

### StatQuery resolution

`StatQuery` is a mutable struct passed by `ref` through every modifier. Each modifier deposits into one of three accumulators (`FlatBonus` sums, `PercentBonus` sums, `Multiplier` multiplies). Resolution order is a single explicit formula, rounded once at the end (half away from zero):

```
(Base + FlatBonus) × (100 + PercentBonus) / 100 × Multiplier
```

This means resolution order is never an emergent property of handler registration — it is always predictable regardless of the order modifiers were added.

```csharp
public readonly int Resolve()
{
    var scaled = (Base + FlatBonus) * (100.0 + PercentBonus) * Multiplier / 100.0;
    return (int)System.Math.Round(scaled, System.MidpointRounding.AwayFromZero);
}
```

### Composite damage and resistance averaging

`DamageType` is a flags enum. Composite types like `Explosive = Fire | Blunt` decompose into their components during resistance calculation. The final resistance applied is the average of all component resistances:

```csharp
// Explosive damage against Fire=20, Blunt=40 → resistance = 30
int damage = stats.Resistances.ApplyTo(incomingDamage, DamageType.Explosive);
```

Adding a new composite damage type requires no changes to `ResistanceSet` — the flag decomposition handles it automatically.

`ApplyTo` reduces the damage by the averaged percentage, rounds the reduction, and never returns less than 1 for a positive hit. `ApplyToExpected` is the unrounded float version the AI simulation uses.

### Derived stats and aptitudes are attribute-driven

`DerivedStats` computes each derived value as an authored base (`DerivedStatsData`, default 10 HP / 4 AP / 2 m / sight 10) plus an attribute contribution, then sends the sum through the mediator so `StatsModifier`s stack on top:

| Stat       | Formula                                                                   |
|------------|---------------------------------------------------------------------------|
| MaxHP      | base + Constitution / 8                                                   |
| MaxAP      | base + 0-4 from Power + Cognition (65 → 1, 85 → 2, 125 → 3, 165 → 4)      |
| MaxSanity  | base + Power                                                              |
| Movement   | base + 1-3 from Dexterity and Strength against Constitution               |
| Evasion    | `HitChance.BaseEvasion` (5) + base + Dexterity / 10 rounded up            |
| SightRange | base                                                                      |

`Precision` (`HitChance.BasePrecision` = 95) and `Initiative` (Dexterity + d100) are `CombatStat`s queried the same way. Aptitudes are pure attribute formulas in `AptitudeFormulas` (e.g. `Discover = 25 + Cognition / 2`), also queried through the mediator. `StatsMediator` raises `OnStatChanged(StatType)` once per affected stat each time a modifier is added or removed (`ActorStats` forwards it), and `ActorResources.TrackStats` listens to it.

### Modifier lifetime separation

`StatsModifier` knows nothing about turns or expiry — it only knows how to modify a query. Whoever owns the effect adds and removes it through `ActorStats.AddModifier` / `RemoveModifier`; there is no `ModifierSystem` or `ActiveModifier`. Duration lives in the owner:

```csharp
// Status effect: StatModifierBehaviour holds the modifier while the status lasts
public override void OnApply(IActor target) => target.Stats.AddModifier(_modifier);
public override void OnRemove(IActor target) => target.Stats.RemoveModifier(_modifier);
```

- **Status effects** (`StatModifierBehaviour`, `Dying`, `Overloaded`): the status adds the modifier in `OnApply` and removes it in `OnRemove`. `StatModifierBehaviour` lasts as long as its `StatusDuration`: `ActorStatusEffects` advances the duration at the start of each owner turn and calls `OnRemove` once it expires. `Dying` is permanent until healed. `Overloaded` drops its modifier itself on its debt turn.
- **Equipment**: `AgentEquipment` adds an item's `Modifiers` on equip and removes them on unequip.

This means `StatsModifier` can be reused across different duration strategies without modification.

### Sanity as a resource-driven stat

`Sanity` is a `BoundedResource` owned by the resource system, not a stat. `AgentStats` does not reference it; the maximum is the derived stat `MaxSanity` (authored base + Power, passed through the mediator), so modifiers to `MaxSanity` move the cap.

The max is wired when `Agent` registers its resources:

```csharp
Sanity = Sanity.Create(() => Stats.Derived.MaxSanity);
resources.Register(Sanity);
```

No coupling between the stat system and the resource system beyond this wiring point in Engine.

---

## Adding a New Aptitude

1. Add a value to `Aptitude` in `Gameplay/Stats/Aptitude.cs`
2. Add the matching entry (offset 30 + value) to `StatType` in `Core/Stats/StatType.cs`
3. Add the formula to `AptitudeFormulas` in `Gameplay/Stats/AptitudeFormulas.cs`
4. Add the property and `Get()` case to `AptitudeSheet` in `Gameplay/Stats/AptitudeSheet.cs`

`AgentStats.TryGet` parses aptitudes by enum name, so lookups by name pick it up automatically.

---

## Adding a New Damage Type

1. Add a flag value to `DamageType` in `Gameplay/Combat/DamageType.cs`
2. If it is a primitive type, add a corresponding value to `Resistance` and `StatType` (offset 100), a field on `ResistanceData` and `ResistanceDataSO`, a property and `Get()` case on `ResistanceSet`, a `(damageType & DamageType.X) != 0` line in `ResistanceSet.TotalAgainst()`, and the `SetResistances(...)` copy in `SimulatedAgentState` (`Systems/AI/Simulation`), so the AI simulation sees it
3. If it is composite, define it as a combination of existing flags — `TotalAgainst` handles it automatically