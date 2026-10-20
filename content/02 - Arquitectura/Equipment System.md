## Overview

Equipment is what an agent holds: weapons in two hand sets, one melee and one ranged, plus a single slot for anything that is not a weapon. Holding an item gives the agent the item's skills and stat modifiers, and a ranged weapon brings its own magazine. A cast does not "use the equipped weapon": it uses the held weapon that granted the skill being cast, so an agent with a knife and a revolver stabs with one and shoots with the other in the same turn.

`AgentEquipment` (`Systems/Equipment`) owns the loadout. It is engine-free and is not registered in DI: each `Agent` builds its own. Item and weapon data are authored as ScriptableObjects in Engine and converted to immutable Gameplay definitions. Picking items up is the interaction pipeline's job ([[Action System#ItemPickupService|Action System]]); this page covers what happens on the agent's side. Dropping exists as `ItemPickupService.Drop`, but nothing in the game calls it yet: the player cannot drop an item.

---

## Key Concepts

### Layered types

| Layer    | Types |
|----------|-------|
| Core     | `ResourceType.Ammunition` (`Core/Resources`) |
| Gameplay | `ItemDefinition`, `WeaponDefinition`, `MeleeWeaponDefinition`, `RangedWeaponDefinition`, `StartingItem` (`Gameplay/Data/Definitions`); `WeaponKind`, `HandRequirement`, `Magazine`, `IAmmoCarrier`, `IAmmoSupply` (`Gameplay/Combat/Weapons`); `Ammunition` (`Gameplay/Resources`); `AgentData.EquippedItems`, `EquippedItemData`, `WeaponData` (`Gameplay/Data`); `IItem` (`Gameplay/World`) |
| Systems  | `AgentEquipment`, `IEquipmentAgent`, `EquippedItem`, `WeaponStrike` (`Systems/Equipment`); `IAgent` extends `IEquipmentAgent` and adds `Ammunition` |
| Engine   | `ItemDefinitionSO`, `WeaponDefinitionSO`, `MeleeWeaponDefinitionSO`, `RangedWeaponDefinitionSO` (`Engine/Unity/World/Entities/Items`); the world entities `Item`, `Weapon`, `AmmoPack` (`Engine/World/Entities`); `Agent` (builds the equipment); `ReloadWeaponEffect`, `DealWeaponDamageEffect` (`Engine/Actions/Effects`) |

There is no equipment interface besides `IEquipmentAgent { AgentEquipment Equipment { get; } }`. Inner layers reach the loadout through `IAgent.Equipment`.

### Item and weapon definitions

```csharp
public sealed class ItemDefinition : IEntityDefinition
{
    public string Id { get; }                         // the asset name
    public LocKey NameKey { get; }
    public LocKey DescriptionKey { get; }
    public IReadOnlyList<SkillData> Skills { get; }
    public IReadOnlyList<StatsModifier> Modifiers { get; }
    public WeaponDefinition Weapon { get; }           // null for a non-weapon item
    public bool Bound { get; }
    public bool ConsumedOnPickup { get; }
    public int AmmoSupply { get; }
}
```

A weapon is an item whose `Weapon` is set. `WeaponDefinition` carries `Hands` (`HandRequirement.OneHanded` or `TwoHanded`), `Damage` and `Kind`. `HandsUsed` is 2 for a two-hander and 1 otherwise. `MeleeWeaponDefinition` adds nothing. `RangedWeaponDefinition` adds `MagazineCapacity`.

They are authored as `ItemDefinitionSO` (*EternalDusk/Definitions/Item Definition*) pointing at a `MeleeWeaponDefinitionSO` or `RangedWeaponDefinitionSO` (*EternalDusk/Definitions/Weapons/...*). The weapon asset's `_damageType` also picks the weapon class for the damage bonus: `Blunt` is Heavy, `Piercing` is Precise, anything else is Standard ([[Combat & Dice#Weapon damage bonus|Combat & Dice]]). `DealWeaponDamageEffect` adds that bonus only when the attack skill's `_applyDamageBonus` is on, and among the authored weapon skills only the rifle shot has it on. `_name` and `_description` are only source wording: the game shows the `Content` string table entries keyed on the lower-cased asset name, `item.<name>.name` and `item.<name>.description` ([[UI Architecture#Localization|UI Architecture]]).

`EntityCatalog.asset` (`Data/Registries`) maps each item's `PrefabId` to its definition, and `EntityDefinitionCatalogSO.BuildProvider` converts them all once into the `IEntityDefinitionProvider` that pickup, spawning and save restore read.

| Field              | Meaning |
|--------------------|---------|
| `_weapon`          | the weapon data, or none for a non-weapon item |
| `_bound`           | once held it can never be unequipped or dropped (Lorenzo's arm) |
| `_consumedOnPickup`| used up on pickup instead of held: its skills go to the picker, its `_ammoSupply` to a ranged carrier |
| `_skills`          | granted while held (or once, when consumed) |
| `_modifiers`       | `StatsModifierDataSO`s added to the holder's stats while held |

### Two hand sets

```csharp
public const int HandsPerKind = 2;

public int FreeHands(WeaponKind kind);
public bool CanEquip(ItemDefinition definition);
```

The loadout is one list, in the order things were equipped. A "set" is the items of one `WeaponKind`, and each set has `HandsPerKind` hands of its own. So an agent can hold, at the same time:

- in the melee set: one two-hander, or two one-handers (two knives)
- in the ranged set: one two-hander (the rifle), or two one-handers (two revolvers)
- one non-weapon item (`Gear`)

`CanEquip` is false for a null definition, for gear while the gear slot is taken, and for a weapon whose `HandsUsed` exceeds its set's `FreeHands`. There is no reason code: the pickup turns a refusal into `PickUpRefusal.HandsFull`. No authored item is gear today, since every non-weapon item is consumed on pickup.

There is no active set and no "wield" step. Everything held is usable at once.

### The main item

Callers that need "the" weapon rather than the one a skill names read the main one:

```csharp
public EquippedItem MainWeapon(WeaponKind kind);   // first held of that kind
public EquippedItem MainItem => MainWeapon(WeaponKind.Ranged) ?? MainWeapon(WeaponKind.Melee) ?? Gear;
public WeaponDefinition Weapon => MainItem?.Weapon;
public Magazine Magazine => MainWeapon(WeaponKind.Ranged)?.Magazine;
public EquippedItem FirstDroppable { get; }        // MainItem unless bound, else the first unbound item
```

`Magazine` is the main ranged weapon's magazine, or null with no ranged weapon. The HUD ammo counter (`AmmoPresenter`), the skill bar, the reload sound parameter (`MissingRoundsParamSource`) and the "who can fire this ammo" check all read it, so with two revolvers the HUD shows the first one equipped. `ItemPickupService.Drop` drops `FirstDroppable` unless it is given an item, though nothing calls it yet.

### Equipping and unequipping

```csharp
public bool TryEquip(ItemDefinition definition, PrefabId prefabId, int ammo = -1);
public bool TryUnequip(EquippedItem item);
public void Clear();
public event Action OnChanged;
```

`TryEquip` checks `CanEquip`, wraps the definition in an `EquippedItem` (creating its magazine), adds the item's `Modifiers` through `ActorStats.AddModifiers` and its `Skills` through `AgentSkillSet.AddSkills`, then raises `OnChanged`. A skill already held is not added twice.

`TryUnequip` refuses a null item, a bound item and one not held. Otherwise it removes the item's modifiers, then removes each of its skills that no other held item still grants: dropping one of two revolvers keeps the shot. `AgentSkillSet.Remove` shelves a skill that is on cooldown or consumable, so picking the weapon back up restores its cooldown and uses rather than readying it ([[Stats System#Modifier lifetime separation|Stats System]] covers the modifier side).

`Clear` empties the loadout, bound items included, and deletes the skills outright. Only save restore calls it.

No authored item has a modifier yet (`_modifiers` is empty on every item asset), so stat changes from equipment are wired but unused.

### Which weapon a cast uses

```csharp
public EquippedItem WeaponFor(SkillId skill);
public Magazine MagazineFor(SkillId skill, int rounds = 0);
public Magazine MagazineToReload(SkillId skill);
```

`EquippedItem.Grants(skill)` is true when the item's definition lists that skill. Each lookup walks the loadout in equip order:

| Lookup             | Returns |
|--------------------|---------|
| `WeaponFor`        | the first held weapon that grants the skill, else null |
| `MagazineFor`      | among the granting weapons' magazines, the first holding `rounds`; else the first granting one (so the refusal names that weapon); else the main `Magazine` |
| `MagazineToReload` | among the granting weapons' magazines, the first that is not full; else the first granting one; else the main `Magazine` |

The fallback to the main magazine lets a skill that no ranged weapon granted (a class skill with an ammo cost) still draw from the main gun.

Weapon damage goes through `WeaponStrike`:

```csharp
public static Damage EquippedDamage(IActor caster, SkillId skill);   // WeaponFor(skill) → Weapon (main) → default
public static RollValue Bonus(DamageType type, IActor caster);
```

`DealWeaponDamageEffect` rolls `EquippedDamage` unless the effect overrides it (`_overrideWeaponDamage`, as the fist skills and the explosive shot do), and `SkillEffectRows` builds the skill tooltip from the same two calls, so the tooltip shows what will be rolled. A non-agent caster, or an agent holding no weapon, gets `default` damage.

### Magazines and the reserve

Ammunition lives in two places ([[Resources System#Layered types|Resources System]]):

- **The magazine** — one per held ranged weapon, on its `EquippedItem`. `Magazine` holds `Capacity` and `Current`, raises `OnChanged(previous, current)`, and spends with `TrySpend(rounds)`. `ammo < 0` on `TryEquip` creates it full; any other value is clamped to `[0, Capacity]`. Melee weapons have none.
- **The reserve** — the agent's `Ammunition` resource, unbounded and not tied to a weapon or calibre. It starts at 0 and is saved as `AmmoReserve`.

Firing and reloading:

- A skill with an `AmmoCost` is blocked with `NoRangedWeapon` when `MagazineFor` finds nothing, and with `NotEnoughAmmo` when that magazine is short. `SkillService` spends AP and rounds together, refunding the AP if the rounds fail ([[Action System#Validation chain|Action System]]).
- `ReloadWeaponEffect` fills `MagazineToReload(skill)` from the reserve with `ConsumeClamped`, so a short reserve gives a partial reload. Its gate refuses with `NoRangedWeapon`, `MagazineFull` or `NoRoundsInReserve`. The revolver and the rifle grant the same `Reload` skill (1 AP), so with both held it fills the first with room.

A world `Weapon` carries its loaded rounds as `IAmmoCarrier.LoadedAmmo` (`-1` = full, from the prefab's `_initialAmmo`). The pickup passes it to `TryEquip`, and the drop writes the magazine's `Current` back onto the spawned weapon, so the count survives a drop and a pickup. An ammo pack (`AmmoPack`, `ConsumedOnPickup`) adds its `AmmoSupply` (the instance's own `_ammoSupply`, else the definition's) to the reserve of the first ranged carrier: the picker, else a party member, else a neutral agent. If none can fire it the pickup is refused as `NoGunner`.

### Starting items

`AgentDefinitionSO._startingItems` lists `StartingItemEntry { Item, Prefab, LoadedAmmo }`. `Agent.OnInitialize` builds the equipment and equips them on every spawn, warning when one does not fit. `LoadedAmmo` 0 means full, because entries authored before the field existed deserialize as 0; a starting weapon cannot be authored empty. `Prefab` must be the item's catalog id, since saves and drops go through it.

| Agent    | Starts holding |
|----------|----------------|
| colt     | knife, revolver with 1 round |
| lorenzo  | his arm (bound, one-handed, blunt melee, 1D6 + 1). Its one skill, `punch_cowboy`, overrides the damage with 1D6, so the arm's own value is never rolled |

### Saving

`Agent.CaptureTyped` writes one `EquippedItemData { PrefabId, Ammo }` per held item, in equip order (`Ammo` is the magazine's `Current`, or `-1` without one), plus `AmmoReserve`. Definitions and modifiers are not saved, and neither is which skills the items grant: restore re-derives them. The skills' cooldowns and remaining uses are saved separately (`Skills`, `UsedUpSkills`) and applied once the loadout is back.

`Agent.RestoreTyped` restores the loadout before the resources, since equipment moves the maxima they clamp to. `RestoreEquipment` calls `Clear` (dropping the starting loadout the spawn just equipped), then `TryEquip`s each saved item by its `PrefabId`. A save from before agents could hold several items has an empty list, and the legacy `EquippedItemPrefabId` / `EquippedAmmo` pair is read instead. An item whose definition is gone, or that no longer fits, is skipped silently. The reserve is set last. Agent capture as a whole is in [[Save & Load System]].

### The AI

The AI plans on copies, not on `AgentEquipment`. `SimulatedAgentState` snapshots every held magazine, which magazine each skill draws from, and each skill's weapon damage. Its `MagazineFor` and `MagazineToReload` copy `AgentEquipment`'s lookups by hand, so a change to one must be made to the other ([[Enemy AI]]).

### Debugging

No console command edits equipment. The generic resource command reaches the reserve (`Ammunition`), `spawn` can place a weapon or ammo pack to pick up, and the skill lab's refill reloads `MagazineFor` for ammo skills. In the editor, `EntityInspectorWindow` lists an agent's held items, free hands and reserve.

---

## Divergence from the GDD

[[Equipamiento]], [[Armas]], [[03 - Entidades/Armas/General|the weapon table]], [[Inventario]], [[Progresión]] and [[Habilidades de Agentes]] describe more than is built:

| Topic              | GDD | Code |
|--------------------|-----|------|
| How much an agent carries | each weapon needs one or two hands; how many weapons an agent may hold is not stated | a melee set and a ranged set, two hands each, plus one non-weapon slot |
| Inventory          | a shared party inventory, Tetris-style, 8×8, with stacking | none. An item is held, consumed on pickup, or left on the ground |
| Armour             | flat damage reduction (armour 1 turns 15 damage into 14) | none from equipment. The only damage reduction is the agent's percentage resistance per damage type, never flat ([[Stats System#Composite damage and resistance averaging\|Stats System]]) |
| Trinkets           | skills or stat modifiers in a number of slots that grows in play, from 1 up to 3 | none. The gear slot exists, but no item fills it |
| Throwing and breaking | every weapon can be thrown and does damage; weapons can break; durability (wishlist) | none |
| Jams               | a firearm's fumble roll jams it, and Desencasquillar (2 PA) clears it | none |
| Revolver           | 1D6 + 1, Standard | 1D6 with no flat bonus, `Piercing` (Precise), but its shot has the damage bonus off, so plain 1D6 is rolled |
| Fists              | Puño (Vaquero) 1D6 + BD and Puño Base 2 + BD, both Heavy weapons | skills that override the damage with no bonus: `punch_cowboy` (Lorenzo's arm) 1D6, `punch_base` (the prison boss's own skill, no item) a flat 3 |
| Lorenzo            | cannot use two-handed weapons | nothing stops it: his arm fills one melee hand, and a rifle fits his ranged set |
| Reload             | 1 PA, allowed while rounds are missing, impossible with no ammo left | matches: `Reload` costs 1 AP and is gated by `MagazineFull` and `NoRoundsInReserve` |

The knife (1D4 + 1, Standard), the rifle (2D8, Precise, magazine 1, two-handed) and the revolver's magazine of 6 match the table. There is no shotgun or hammer asset.

---

## Adding a New Weapon

1. Create a `MeleeWeaponDefinitionSO` or `RangedWeaponDefinitionSO` under `Data/Entities/Items/Weapons`: `_hands`, `_damageType` (it also sets the damage-bonus class, which counts only where the attack skill has `_applyDamageBonus` on), `_damage`, and for a ranged weapon `_magazineCapacity`
2. Create an `ItemDefinitionSO` beside it pointing at the weapon, with the skills it grants. A ranged weapon that should reload lists the shared `Reload` skill. Its attack skills use `DealWeaponDamageEffect` to roll the weapon's damage
3. Add `item.<name>.name` and `item.<name>.description` (the asset name, lower-cased) to the `Content` string table, in both locales
4. Make the world prefab (a `Weapon` component; `_initialAmmo` -1 spawns it loaded), register it in `PrefabRegistry.asset`, and map that `PrefabId` to the item definition in `EntityCatalog.asset`
5. To start an agent with it, add a `_startingItems` entry with the same `Prefab` id

---

## Adding a New Consumable Item

1. Create an `ItemDefinitionSO` with no weapon and `_consumedOnPickup` on
2. Give it `_skills` to grant the picker (each grant tops up a consumable skill's uses, as the medkit's Heal does) and/or an `_ammoSupply` for the reserve
3. Make the prefab: an `Item`, or an `AmmoPack` when one instance should carry a different supply (`_ammoSupply` 0 uses the definition's), then register it as in step 4 above
