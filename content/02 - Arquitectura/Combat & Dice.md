## Overview

Combat resolution is split by what it rolls. Dice primitives live in Core (`Core/Dice`): die types, roll values, the graded percentile result and the seeded random stream behind every roll. Percentile checks live in Gameplay (`Gameplay/Dice`): advantage, disadvantage and success levels. Attacks and damage live in `Gameplay/Combat`: hit chance, damage types, the weapon damage bonus. `SkillService` and the skill effects are the callers ([[Action System#7. SkillService|Action System §7]]).

The system works with two kinds of roll:

- **Attribute checks** — a graded d100 against a threshold, open to advantage and disadvantage from status effects (`AttributeCheckService` → `RollResolver`)
- **Hit and damage rolls** — a plain d100 against a hit percentage, then the damage dice (`HitChance`, `RollValue`), sent through the damage pipeline in `EffectContext.DealDamage`

Every gameplay roll draws from one seeded stream, and the save keeps its position.

---

## Key Concepts

### One seeded stream

`RootInstaller` builds one `CapturableRandom` and registers it as both `System.Random` and `CapturableRandom`. `DiceRoller`, `RollResolver` and everything else that rolls take that `Random`, so a seed replays a whole session:

```csharp
int seed = DiceSeed.Resolve(Environment.GetCommandLineArgs(), Environment.TickCount);
builder.RegisterValue(new CapturableRandom(seed), new []{ typeof(Random), typeof(CapturableRandom) });
```

`DiceSeed.Resolve` takes `-seed <n>` from a player's command line, or a seed pinned in the editor with `DiceSeed.PinNextRun` (read by the next play only), and falls back to the tick count. The seed is logged as `Dice seed <n>`.

`CapturableRandom` reimplements `System.Random`'s own subtractive generator, so a seed rolls the same sequence as before, with its state exposed: `Capture()` returns the 56-entry table and two cursors, and `Restore(state)` refuses a state of the wrong shape (table length, cursor range, cursor gap) and keeps rolling where it was. `DiceSavable` (id `Dice`) saves it, so reloading cannot re-roll a check or a hit ([[Save & Load System#Root registration|Save & Load System]]).

### Dice and roll values

`DiceType` values are face counts (`D4 = 4` … `D100 = 100`, `None = 0`), so `DiceRoller.Roll` is a single call:

```csharp
public int Roll(DiceType diceType) =>
    diceType == DiceType.None ? 0 : _random.Next(1, (int)diceType + 1);
```

`RollValue` is a flat `Base` plus a list of dice (`Dices`). It answers `Min()`, `Max()`, `Average()` and `Roll(DiceRoller)`, and adds with `+` (to an int, or to another `RollValue`, concatenating the dice). The AI's simulation prices damage with `Average()`. Live resolution calls `Roll`. A `readonly struct` stores nothing behind `[SerializeField]`, so authored data goes through `SerializableRollValue` and `SerializableDamage` (Engine). `Damage` pairs a `DamageType` with a `RollValue`.

### Percentile checks and success levels

`RollResolver.Resolve(threshold, resolution)` rolls the d100 and grades it. The critical bands come first, so they hold at any threshold:

| `RollThreshold`   | Roll                                   |
|-------------------|----------------------------------------|
| `CriticalSuccess` | ≤ `CriticalSuccessMax` (5)             |
| `CriticalFailure` | ≥ `CriticalFailureMin` (96), or auto-fail (reported as 100) |
| `Extreme`         | ≤ threshold / 5                        |
| `Hard`            | ≤ threshold / 2                        |
| `Regular`         | ≤ threshold                            |
| `Failure`         | above the threshold                    |

The divisions are integer, so they round down as the GDD asks. `RollResult` carries `Roll`, `Threshold` and `ThresholdLevel`, plus `IsSuccess` (any level above `Failure`), `IsCriticalSuccess` and `IsCriticalFailure`.

### Advantage and disadvantage

Sources do not roll extra dice themselves. They deposit into a `RollAccumulator`, a mutable struct passed by `ref`, and the accumulator nets them:

```csharp
var acc = new RollAccumulator();
acc.Advantage();      // +1
acc.Advantage();      // +2
acc.Disadvantage();   // net +1 → RollResolution(Advantage, steps: 1)
```

`AutoFail()` overrides everything. `RollResolver` rolls `Steps + 1` whole d100s and keeps the lowest on advantage, the highest on disadvantage. Stacking and cancelling one for one follow the GDD ([[Dados#Ventaja y Desventaja|Dados]]). The GDD rolls an extra tens die rather than a whole d100, so the odds differ slightly.

### Attribute checks

`AttributeCheckService.Check(subject, attribute, threshold, opponent)` is the d100 check a GDD ability calls for:

1. builds a `RollContext` (`RollKind.AttributeCheck`, the attribute, the opponent)
2. lets the subject's statuses contribute as roller and the opponent's as target (`ContributeAsRoller` / `ContributeAsTarget`, [[Status Effects System#Hooks a status can override|Status Effects System]])
3. resolves through `RollResolver` and raises `OnChecked(EntityId, Attribute, RollResult)`, which `DamageNumbersPresenter` shows

The threshold is passed in because attributes live on `AgentStats` in Systems, which Gameplay cannot see. Callers read `Stats.Attributes.Get(attribute)`. The only caller today is `ApplyStatusOnFailedCheckEffect`, run by skills and by surfaces on entry: Taunt rolls Power, Venom, Poison Shot and fire surfaces roll Constitution, Weakening rolls Cognition. No shipped status contributes to a roll yet, so every check rolls `Normal`.

The Articy script method `DialogueScriptMethods.Roll` calls `RollResolver.Resolve` directly with a `Normal` resolution and hands Articy `(int)result.ThresholdLevel`. Statuses never reach it and `OnChecked` is not raised. No authored dialogue node calls it yet.

### Hit chance

A skill is an attack when any of its effects is (`IEffect.IsAttack`, read through `HitChance.IsAttack` and cached as `Skill.IsAttack`). `SkillService` rolls once per target on each strike step of the skill's sequence, the caster excepted. Every shipped skill has one strike step. A non-attack reaches every target, and a ground skill rolls nothing:

```csharp
var percent = HitChance.Percent(caster, target, HitChance.DistanceBonus(data, caster.Position, target.Position));
if (!HitChance.Rolls(_dice, percent))   // d100 ≤ percent
{
    tally.AddMiss(id);
    continue;
}
```

`Percent` is `Math.Clamp(precision + distanceBonus - evasion, 0, 100)`. Precision is `CombatStat.Precision` (base `HitChance.BasePrecision`, 95), and evasion is the derived `Evasion` (base `HitChance.BaseEvasion`, 5, plus Dexterity), both through the stat mediator ([[Stats System#Derived stats and aptitudes are attribute-driven|Stats System]]). A dying agent's precision drops to `HitChance.DyingPrecision` (35), through a modifier ([[Status Effects System#Dying|Status Effects System]]).

`DistanceBonus` rewards closeness: all of `PointBlankBonus` (10) at the near edge of the skill's range window, nothing at the far edge, linear between and rounded. A skill that moves its caster gets none, and neither does a window with no span or an infinite one.

The hit roll is a plain `DiceRoller` d100. It is not graded, takes no advantage or disadvantage and has no critical.

### Damage pipeline

Every damage effect ends in `EffectContext.DealDamage(amount, type)`, the single door into a target's health:

```
amount
  + DamageModifier                      — DyingSkills: a skill's WhileDying damage change
  → caster.StatusEffects.ModifyOutgoingDamage
  → target.StatusEffects.ModifyIncomingDamage
  → target.Stats.Resistances.ApplyTo(amount, type)
  → target.Health.TakeDamage(Math.Max(0, amount))   — returns what the pool gave up
  → ActionTally.Add(dealt, type)
```

`TakeDamage` answers with what it actually removed, so overkill is not counted twice. Resistance averaging over composite types (`Explosive = Fire | Blunt`) and the minimum of 1 for a positive hit are the stat system's ([[Stats System#Composite damage and resistance averaging|Stats System]]). An effect that writes to `Health` directly bypasses all of it. `Heal(amount)` is the matching door for healing. With no target (a ground skill) both warn and do nothing.

Damage effects, all in `Engine/Actions/Effects` and all attacks:

| Effect                     | Rolls                                                                                               |
|----------------------------|-----------------------------------------------------------------------------------------------------|
| `DealDamageEffect`         | the authored `SerializableDamage`                                                                   |
| `DealWeaponDamageEffect`   | the weapon that granted the skill (`WeaponStrike.EquippedDamage`), or authored damage for unarmed strikes (`_overrideWeaponDamage`), plus the damage bonus; floored at 0 |
| `DealScalingDamageEffect`  | the authored damage plus one `_perStatusDie` (D6) per status on the target ("Ultra Explosive Smackdown") |

`ApplyStatusOnFailedCheckEffect` also deals its damage on a failed check, and counts as an attack only when it has some. `DamageOverTime` deals its tick through the same door with no caster ([[Status Effects System#Composed statuses|Status Effects System]]). Each effect's `Simulate` mirrors `Apply` with averages, for the AI.

### Weapon damage bonus

`WeaponDamageBonus` is the GDD's damage bonus ([[Armas#Bonificadores de Daño (BD)|Armas]]). A weapon's class is read off its `DamageType`, matched exactly, so composites stay Standard:

| Class    | `DamageType` | Value graded                        |
|----------|--------------|-------------------------------------|
| Heavy    | `Blunt`      | caster's Strength                   |
| Precise  | `Piercing`   | caster's Dexterity                  |
| Standard | anything else| `StandardValue` (50): no bonus      |

`ForValue` grades the value: ≤ 20 → −2, ≤ 45 → −1, ≤ 60 → none, ≤ 80 → +1D4, above → +1D6. The GDD's table overlaps at 45, and the code reads 45 as −1. `WeaponStrike.Bonus(type, caster)` picks the attribute off the caster, and `DealWeaponDamageEffect` adds it unless `_applyDamageBonus` is off.

---

## Divergence from the GDD

[[Dados]], [[Armas]] and [[Habilidades de Agentes#Reacciones (Secundario)|Habilidades de Agentes]] describe these differently from the code:

| Topic                  | GDD                                                                                         | Code                                                                                         |
|------------------------|---------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------|
| Hit chance             | Tasa de Acierto = (25 + Tipo / 2)%, with Tipo 50 (Standard), Strength (Heavy) or Dexterity (Precise) | precision 95 + closeness bonus (0–10) − evasion (5 + Dexterity / 10 rounded up + base); weapon class only feeds the damage bonus |
| Critical band          | a d100 below 5                                                                              | ≤ 5 (`CriticalSuccessMax`)                                                                   |
| Fumble band            | 98–100                                                                                      | ≥ 96 (`CriticalFailureMin`)                                                                  |
| Criticals on attacks   | a critical adds another roll of the damage dice plus bonuses and recovers Sanity and Luck; a fumble loses Sanity | the hit roll is not graded: no critical damage, no Sanity or Luck change              |
| Reactions              | Esquivar, Contratacar, Saltar a cubierto, Empujar Suerte                                    | none built. `RollKind.Dodge`, `Counterattack` and `Attack` are declared and unused (only `AttributeCheck` is rolled), and Luck has no stat yet |
| Opposed rolls          | two agents compare success levels                                                           | no opposed roll; a check is one subject against a threshold                                 |

Advantage and disadvantage, the three success levels and the damage bonus table match the GDD.

---

## Adding a New Damage Effect

1. Add a `[Serializable]` class in `Engine/Actions/Effects` implementing `ISimulableEffect` and `IDescribedEffect`
2. Return `true` from `IsAttack`, so the skill rolls to hit before the effect runs
3. In `Apply`, roll with `context.Dice` and finish with `context.DealDamage(amount, type)`, never `Health` directly, so statuses, resistances and the tally see the hit
4. Mirror it in `Simulate` with `Average()` and `context.DealDamage(expected, type)`, so the AI prices it
5. Describe it in `Describe` for the skill tooltip

For a new damage type, see [[Stats System#Adding a New Damage Type|Stats System]].

---

## Adding a New Attribute Check

Resolve it through `AttributeCheckService.Check`, never with a d100 of its own, so statuses can add advantage, disadvantage or an auto-fail and `OnChecked` reaches the UI. Read the threshold from `agent.Stats.Attributes.Get(attribute)` in the calling layer and pass the actor forcing the check as `opponent`.