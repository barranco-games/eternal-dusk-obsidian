## Overview

The resource system is built around a clear separation between the interface contract (Core), the bounded behaviour and concrete resource types (Gameplay), and the holder (Systems). Resources are owned by `ActorResources`, which implements `IResourceHolder` and is the single point of contact for anything that wants to read or modify an actor's resources. Four resource types exist: `Health`, `ActionPoints`, `Sanity` and `Ammunition`.

The system operates at two levels:

- **Live resources** — `IResource` instances owned by `ActorResources`, firing events and driving UI
- **Simulated resources** — `SimulatedAgentState`, an AI-layer snapshot (`ISimulatedActor`) holding a `ResourceState[]` copied from the live actor, used by AI and planning code without touching live state

---

## Key Concepts

### Layered types

Every concrete resource type follows the same chain:

```
IResource                                  (Core)
  └── IBoundedResource                     (Core)
Resource : IResource (abstract)            (Gameplay)
  ├── Ammunition (sealed, unbounded)
  └── BoundedResource : IBoundedResource (abstract, Func<int> getMax)
        ├── Health (sealed)
        ├── ActionPoints (sealed)
        └── Sanity (sealed)
```

Adding a new resource means extending `BoundedResource` (or `Resource` for an unbounded resource) and declaring its `ResourceType`. Nothing else in the system needs to change.

Ammunition is split in two. `Ammunition` (`ResourceType.Ammunition`) is an unbounded resource holding the actor's reserve. It starts at 0, is saved as `AmmoReserve` and is drained by `ReloadWeaponEffect`. The loaded rounds live on the weapons' magazines, not in `ActorResources`, and the simulation mirrors them separately (`RoundsMissing` / `LoadRounds`). `ActionPoints` also carries `MovementCredit`, the metres already paid for with a spent point and not yet walked.

### ResourceState and per-type arrays

`ResourceState` is a readonly struct (`Current`, `int? Max`) that snapshots one resource. `Max` is null for an unbounded resource. It offers `IsEmpty`, `IsFull`, `Ratio`, `CanAfford(amount)`, `WithConsumed(amount)` (floored at zero) and `WithRestored(amount)` (capped at `Max` when bounded).

There is no multi-resource amount type. Operations touch one resource at a time through `IResourceHolder` (`CanConsume(type, amount)`, `Consume`, `Restore`, `SetToMax`), for example `caster.Resources.Consume(ResourceType.ActionPoints, apCost)`.

Per-type storage is a plain array indexed by `(byte)ResourceType` and sized `ResourceTypes.Capacity`, derived from the enum. `ActorResources` holds an `IResource[]` and `SimulatedAgentState` holds a `ResourceState[]`. This avoids dictionary lookups and enumerator allocations on hot paths.

### Simulation

AI and planning code must not consume live resources speculatively. `SimulatedAgentState` (`Systems/AI/Simulation`, pooled through `SimulationStatePool`) is a mutable snapshot of an agent that implements `ISimulatedActor`. Effects that implement `ISimulableEffect` resolve against it instead of the live actor:

```csharp
var sim = pool.GetAgentState().Reset(agent);            // copies resources, skills, statuses, resistances
sim.ConsumeResource(ResourceType.ActionPoints, 2);      // no live state touched
var state = sim.GetResource(ResourceType.ActionPoints); // ResourceState
```

`ConsumeResource` is clamped at zero and `RestoreResource` is clamped at the max when bounded, both through `ResourceState.WithConsumed` / `WithRestored`. `SimulatedAgentState` also tracks fractional expected damage, pending status damage and magazine contents (`RoundsMissing` / `LoadRounds`) that have no live-resource equivalent.

`Reset(IAgent)` populates the resource array from `IResourceHolder.GetAllStates()`, which returns the cached state dictionary from `ActorResources` rather than allocating on every call.

### State cache

`ActorResources` maintains a `Dictionary<ResourceType, ResourceState>` that is rebuilt lazily when dirty. The dirty flag is set whenever a resource's `OnChanged` event fires, whenever a resource is registered or unregistered, and whenever a tracked stat changes (maxima are read off the stats). `Actor.Initialize` wires the last one by calling `TrackStats(Stats)`.

```
Register / Unregister     → _stateDirty = true
Resource.OnChanged fires  → _stateDirty = true
Stats.OnStatChanged fires → _stateDirty = true
GetAllStates() called     → RebuildCache() if dirty, then return _cachedStateDict
```

This means `SimulatedAgentState.Reset(agent)` and any other caller of `GetAllStates()` never allocate a new dictionary at runtime — they read the pre-built cache.

### BoundedResource max scaling

`BoundedResource` accepts a `Func<int>` for `Max` rather than a fixed integer. This means max values can be derived from a stat system without any coupling between the resource and whatever owns the stats:

```csharp
Health.Create(() => Stats.Derived.MaxHP);
```

`SetToMax`, `ClampToMax`, and `Ratio` all read from the delegate on each access.

### Events

`IResource` exposes two events:

| Event | When it fires |
|---|---|
| `OnChanged(int prev, int next)` | Any time the current value changes |
| `OnDepleted` | When current transitions from above zero to zero |

`IBoundedResource` adds one:

| Event | When it fires |
|---|---|
| `OnFilled` | When current transitions from below max to max |

`OnDepleted` and `OnFilled` fire at most once per transition — calling `SetCurrent(0)` when already at zero does not refire `OnDepleted`.

`Health` adds `OnDamaged(int taken)`. It fires only from `TakeDamage`, which wraps `ConsumeClamped`. Costs, drains and restores change health without raising it.

Consumers of these events:
- `LeaderResourcePresenter` redraws the HP and AP bars from `OnChanged`. It also redraws on `Stats.OnStatChanged` when the max moved.
- `ObstacleActor` destroys itself on `Health.OnDepleted`.
- `ActionPointMovementBudget` clears its movement credit on `ActionPoints.OnFilled`.
- `Agent` flags a hurt reaction from `Health.OnDamaged`.

---

## Adding a New Resource Type

1. Add a value to `ResourceType` in Core
2. Define a sealed class extending `BoundedResource` (or `Resource` for unbounded) in `Gameplay/Resources`
3. Implement `Type` to return the new enum value
4. Register an instance into `ActorResources` at actor setup time (`Actor.Initialize` registers `Health`; `Agent.RegisterResources` registers `ActionPoints`, `Sanity` and `Ammunition`)
5. If the debug resource commands should accept it by short name, add a case to `ResourceTypeParser` (`hp`, `ap` and `sanity` exist today; any other type is accepted only by its enum name)

```csharp
public sealed class ActionPoints : BoundedResource
{
    public override ResourceType Type => ResourceType.ActionPoints;

    private ActionPoints(Func<int> getMax, int? initial = null) : base(getMax, initial) { }
    public static ActionPoints Create(Func<int> getMax, int? initial = null) => new(getMax, initial);
}
```

```csharp
// At agent setup
resources.Register(ActionPoints.Create(() => Stats.Derived.MaxAP));
resources.Register(Sanity.Create(() => Stats.Derived.MaxSanity));
resources.Register(Ammunition.Create(initial: 0)); // unbounded: extends Resource, no max delegate
```

No other changes are required. `ResourceTypes.Capacity`, the `ActorResources` array and state cache, and `SimulatedAgentState`'s `ResourceState[]` all derive their size from the enum at runtime.
