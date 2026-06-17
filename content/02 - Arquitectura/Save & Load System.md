## Overview

The save system is built around explicit ownership and a clear separation between what the save system *knows about* and what it *contains*. Only a small number of root savables register into `SaveRegistry`. Everything else is owned and captured recursively by its root.

The system operates in two phases:

- **Pre-transition** — `SaveSessionState` is restored to determine which scene to load
- **Post-transition** — the level pipeline runs `LoadGameStateStep`, which restores all remaining savables

---

## Key Concepts

### Ownership

Every savable entity is owned by exactly one root. Roots are the only things that register into `SaveRegistry`. The registry stays lean — one entry per logical system.

| Entity type | Owner |
|---|---|
| Scene name | `SaveSessionState` |
| Props, chests, doors | `WorldState` |
| Spawned enemies, projectiles | `PersistentSpawner` |
| Summons | The summoning character's spawner |
| Dropped items | `WorldState` (transferred at drop time) |

### Lifecycle dependency

The distinction between `WorldState` ownership and spawner ownership is lifecycle:

- **Lifecycle-bound** — dies with its creator → owned by a spawner
- **World-persistent** — outlives its creator → owned by `WorldState`

When a summon drops an item on death, it calls `WorldState.Track(item)`. Ownership transfers at that moment. The summon is gone, the item belongs to the world.

### Instance identity

Each persistent entity carries two identifiers:

- `PrefabId` — a pure C# struct in Core identifying which prefab to spawn on restore; used as a dictionary key in `PrefabRegistry` via `IEquatable`; only meaningful for runtime-spawned entities that need to be re-instantiated
- `EntityId` — a pure C# struct in Core that is stable and unique per instance; implements `IEquatable`

For scene-placed entities, `EntityId` is managed through `SerializableEntityId` in the Inspector — a Unity-serializable wrapper with a custom property drawer that auto-generates a GUID on first display and warns if a duplicate is detected in the scene. `PrefabId` is managed through `SerializablePrefabId`, which warns if the value is empty or not found in `PrefabRegistryDefinition`.

For runtime-spawned entities, `EntityId.Generate()` is called at spawn time and saved into the envelope, ensuring stability within a session. `PrefabId` is assigned by the spawner at instantiation time.

`RestoreScene` matches on `EntityId`, not `PrefabId`, so multiple instances of the same prefab are unambiguous. `PrefabId` is only used by spawners when re-instantiating entities from a saved state — scene-placed entities are already in the scene and do not need prefab resolution.

### Root registration

`SaveSessionState` and `WorldState` are the only savables that register directly into `SaveRegistry`. This happens at composition root level via `OnContainerBuilt`, after the DI container is fully built:

```csharp
private void OnContainerBuilt(Container container)
{
    var registry = container.Resolve<ISaveRegistry>();
    registry.Register(container.Resolve<SaveSessionState>());
    registry.Register((ISavable)container.Resolve<IWorldState>());
}
```

`WorldState` is resolved through `IWorldState` and cast to `ISavable` for registration. All other savables (`PersistentSpawner` adapters) register through `SceneSaveRegistryBridge` at scene load time via `Awake`. All `PersistentEntity` instances track themselves into `IWorldState` through the same bridge.

### The bridge pattern

MonoBehaviours cannot inherit from pure C# base classes without crossing layer boundaries. The bridge pattern solves this: the MonoBehaviour holds an instance of the pure C# savable and delegates to it. The MonoBehaviour wires Unity lifecycle (`Awake`, `OnDestroy`) to registration, and provides data via an interface.

```
MonoBehaviour (Engine.World)
  └── holds → Savable (Engine)
                └── registered in → SaveRegistry
```

`Spawner` uses an inner `SpawnerAdapter` class as the bridge, so `SpawnerSavable` in Engine never touches Unity directly.

---

## Save Flow

```
GameStateService.SaveAsync(fileName)
  │
  ├── SaveRegistry.GetAll()
  │     returns all registered ISavables:
  │       SaveSessionState, WorldState, Spawner A, Spawner B ...
  │
  ├── foreach savable → savable.Capture(envelopeSerializer)
  │     SaveSessionState  → captures current scene name
  │     WorldState        → captures all scenes, each with their tracked IWorldPersistentEntity instances
  │     PersistentSpawner → captures all active ISpawnableEntity instances
  │
  └── SaveService.SaveAsync(fileName, saveFile)
```

---

## Load Flow

```
GameStateService.LoadAsync(fileName)
  │
  ├── SaveService.LoadAsync → SaveFile
  ├── SaveRegistry.Get(SaveSessionState.StateId)
  ├── SaveSessionState.Restore(envelope)   ← now knows SceneToRestoreOn
  │
  └── SceneService.RequestTransition(SceneToRestoreOn)
        │
        ├── LevelLoader.UnloadCurrentLevelAsync
        │     └── LevelLifecyclePipeline.Shutdown
        │
        ├── SceneLoader.LoadScene
        │     └── Unity loads scene
        │           └── MonoBehaviours Awake()
        │                 PersistentEntity  → Bridge.Track(gameObject.scene.name, this)
        │                                    → WorldState.Track(sceneId, this)
        │                 PersistentSpawner → Bridge.Register(adapter)
        │                                    → SaveRegistry.Register(adapter)
        │
        └── LevelLoader.LoadLevelAsync
              └── LevelLifecyclePipeline.Initialize
                    └── LoadGameStateStep.Initialize
                          ├── SaveRegistry.RestoreAll(save.Envelopes)
                          │     WorldState        → caches WorldStateData (_lastRestoredData)
                          │     PersistentSpawner → despawns all, respawns from state
                          │
                          └── WorldState.RestoreScene(currentScene)
                                → matches tracked entities by EntityId
                                → calls entity.Restore(envelope, serializer)
```

The ordering is safe by design: `Awake` registration happens during `SceneLoader.LoadScene` before the pipeline runs. `PersistentEntity` uses `gameObject.scene.name` rather than `SceneService.CurrentScene` to avoid a timing issue — `SceneService` is only updated after the load completes, but `gameObject.scene.name` is correct as soon as the object exists in the scene.

---

## Adding a New Savable

### World-persistent scene object

1. Define a state record in Core/Persistence/Data/Entities, e.g. `DoorData`
2. Create a class extending `PersistentEntity<DoorData>` in Engine/World/Entities
3. Implement `TypeName`, `Version`, `CaptureTyped`, and `RestoreTyped`
4. Attach it to the GameObject in the scene
5. Set a unique `EntityId` and the correct `PrefabId` in the Inspector, wire the `SceneSaveRegistryBridge` reference

```csharp
public sealed class DoorEntity : PersistentEntity<DoorData>
{
    public override string TypeName => "door";
    public override int Version => 1;

    protected override DoorData CaptureTyped() => new()
    {
        Position = transform.position.ToData(),
        IsOpen = _isOpen
    };

    protected override void RestoreTyped(DoorData state)
    {
        transform.position = state.Position.ToUnity();
        _isOpen = state.IsOpen;
    }
}
```

Each entity type owns its own state shape — there is no shared base data record.

### Spawner

1. Define a state record in Core/Persistence/Data/Entities, e.g. `EnemyData`
2. Create a MonoBehaviour that implements `ISpawnableEntity` for the spawned entity
3. Extend `PersistentSpawner` and implement:
   - `Spawn` — instantiate from `SpawnedEntityState`, return the `ISpawnableEntity`
   - `Despawn` — destroy or return to pool

```csharp
public sealed class EnemySpawner : PersistentSpawner
{
    [SerializeField] private GameObject _enemyPrefab;
    [Inject] private IEnvelopeSerializer _serializer;

    protected override IEnvelopeSerializer Serializer => _serializer;

    protected override ISpawnableEntity Spawn(SpawnedEntityState state)
    {
        var go = Instantiate(_enemyPrefab);
        var enemy = go.GetComponent<Enemy>();
        enemy.Restore(state.Envelope, Serializer);
        ActiveInstances.Add(enemy);
        return enemy;
    }

    protected override void Despawn(ISpawnableEntity instance)
    {
        Destroy(((Enemy)instance).gameObject);
    }
}
```

### Summoner

Same as a spawner. The summoning character extends `PersistentSpawner`. Summons are lifecycle-bound — they are captured inside the character's envelope, not registered separately.

When a summon drops an item on death:

```csharp
// Inside summon death logic
_worldState.Track(gameObject.scene.name, droppedItem);
```

Ownership transfers to `WorldState` at that point.

---

## Migration

When a savable's data shape changes, override `Migrate`:

```csharp
protected override MyData Migrate(int fromVersion, MyData state)
{
    if (fromVersion == 1)
    {
        // e.g. populate a new field with a default
        state.NewField = "default";
    }
    return state;
}
```

`Restore` calls `Migrate` automatically when `envelope.Version != Version`. If no migration is defined, the base implementation logs a warning and passes the data through as-is.