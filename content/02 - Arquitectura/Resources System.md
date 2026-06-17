## Overview

The resource system is built around a clear separation between the interface contract, the bounded behaviour, and the concrete resource types. Resources are owned by `ActorResources`, which implements `IResourceHolder` and is the single point of contact for anything that wants to read or modify an actor's resources.

The system operates at two levels:

- **Live resources** — `IResource` instances owned by `ActorResources`, firing events and driving UI
- **Simulated resources** — `SimulatedResourceSet`, a pure value-type snapshot used by AI and planning code without touching live state

---

## Key Concepts

### Layered types

Every concrete resource type follows the same chain:

```
IResource
  └── IBoundedResource
        └── Resource (abstract)
              └── BoundedResource (abstract, Func<int> getMax)
                    └── Health (sealed)
```

Adding a new resource means extending `BoundedResource` (or `Resource` for an unbounded resource) and declaring its `ResourceType`. Nothing else in the system needs to change.

### ResourceSet

`ResourceSet` is an immutable value type expressing a multi-resource amount — a cost, a yield, or a restoration. It is the preferred way to express any operation that touches more than one resource at once.

```csharp
var cost = ResourceSet.Empty
    .With(ResourceType.ActionPoints, 2)
    .With(ResourceType.Sanity, 1);

if (actor.CanConsume(cost))
    actor.Consume(cost);
```

Iteration over a `ResourceSet` uses `RawAmounts`, a `ReadOnlySpan<int?>` that is allocation-free:

```csharp
var amounts = set.RawAmounts;
for (int i = 0; i < amounts.Length; i++)
    if (amounts[i].HasValue)
        // use (ResourceType)i and amounts[i]!.Value
```

`ResourceSet` does not use `IEnumerable` or `yield return` anywhere — there are no enumerator allocations on hot paths.

### Simulation

AI and planning code must not consume live resources speculatively. `SimulatedResourceSet` provides an identical API over a pure value-type snapshot:

```csharp
var sim = SimulatedResourceSet.From(actor);
sim.Consume(cost);   // no live state touched and can speculate freely
var state = sim.GetState(ResourceType.ActionPoints);
```

Cloning a simulation is a plain struct copy:

```csharp
var branch = SimulatedResourceSet.From(sim);
```

`SimulatedResourceSet` is populated from `IResourceHolder.GetAllStates()`, which returns the cached `ResourceState[]` from `ActorResources` rather than allocating on every call.

### State cache

`ActorResources` maintains a `ResourceState[]` and a `Dictionary<ResourceType, ResourceState>` that are rebuilt lazily when dirty. The dirty flag is set whenever a resource's `OnChanged` event fires, or whenever a resource is registered or unregistered.

```
Register / Unregister     → _stateDirty = true
Resource.OnChanged fires  → _stateDirty = true
GetAllStates() called     → RebuildCache() if dirty, then return _cachedStateDict
```

This means `SimulatedResourceSet.From(holder)` and any other caller of `GetAllStates()` never allocate a new dictionary at runtime — they read the pre-built cache.

### BoundedResource max scaling

`BoundedResource` accepts a `Func<int>` for `Max` rather than a fixed integer. This means max values can be derived from a stat system without any coupling between the resource and whatever owns the stats:

```csharp
Health.Create(() => stats.Get(StatType.MaxHealth));
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

---

## Adding a New Resource Type

1. Add a value to `ResourceType` in Core
2. Define a sealed class extending `BoundedResource` (or `Resource` for unbounded) in `Gameplay/Resources`
3. Implement `Type` to return the new enum value
4. Optionally, register an instance into `ActorResources` at actor setup time

```csharp
public sealed class ActionPoints : BoundedResource
{
    public override ResourceType Type => ResourceType.ActionPoints;

    private ActionPoints(Func<int> getMax, int? initial = null) : base(getMax, initial) { }
    public static ActionPoints Create(Func<int> getMax, int? initial = null) => new(getMax, initial);
}
```

```csharp
// At actor setup
_resources.Register(ActionPoints.Create(() => stats.Get(StatType.MaxAP)));
_resources.Register(Health.Create(() => stats.Get(StatType.MaxHealth)));
```

No other changes are required. `ResourceSet.Capacity`, the state cache, and `SimulatedResourceSet` all derive their size from the enum at runtime.
