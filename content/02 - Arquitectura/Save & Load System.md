## Overview

The save system is built around explicit ownership and a clear separation between what the save system *knows about* and what it *contains*. Only a small number of root savables register into `SaveRegistry`. Everything else is owned and captured recursively by its root.

The system operates in two phases:

- **Pre-transition** — `SaveSessionState` is restored to determine which scene to load
- **Post-transition** — the level pipeline runs `LoadGameStateStep`, which restores all remaining savables

---

## Folder Structure

```
Core/
└── Persistence/
    ├── Contracts/
    │   ├── ISavable.cs
    │   ├── ISceneRestorable.cs
    │   ├── ISaveRegistry.cs
    │   ├── IEnvelopeSerializer.cs
    │   ├── ISaveFile.cs
    │   ├── IWorldState.cs
    │   ├── IPrefabRegistry.cs
    │   ├── IPersistentEntity.cs
    │   ├── ISpawnableEntity.cs
    │   └── IWorldPersistentEntity.cs
    │
    └── Data/
        ├── SaveFile.cs
        ├── SaveFileMetadata.cs
        ├── SaveEnvelope.cs
        ├── SpawnedEntityState.cs
        ├── OwnedSpawnData.cs
        ├── SceneStateData.cs
        ├── WorldStateData.cs
        ├── WorldEntityEnvelope.cs
        ├── EntityId.cs
        └── PrefabId.cs

Engine/
├── Prefabs/
│   ├── PrefabRegistry.cs
│   ├── PrefabRegistryDefinition.cs
│   └── PrefabRegistryInstaller.cs
│
├── Persistence/
│   ├── Savable.cs
│   ├── SpawnerSavable.cs
│   └── WorldStateSavable.cs
│
└── World/
        ├── Persistence/
        │   ├── WorldState.cs
        │   ├── SaveSessionState.cs
        │   ├── SceneSaveRegistryBridge.cs
        │   ├── SerializableEntityId.cs
        │   └── SerializablePrefabId.cs
        │
        └── Entities/
            ├── PersistentEntity.cs
            ├── PersistentSpawner.cs
            └── TransformEntity.cs
```

---

## Layer Responsibilities

### Core
Pure C#, no Unity references. Contains contracts and plain data records only.

Contracts:
- `ISavable` — the minimal contract: `Id`, `Version`, `Capture()`, `Restore()`
- `ISceneRestorable` — extends `ISavable` with `SceneToRestoreOn`, used to bootstrap loading
- `ISaveRegistry` — registers and retrieves savables by id
- `IEnvelopeSerializer` — serializes/deserializes state into `SaveEnvelope`
- `ISaveFile` — read contract over a save file
- `IWorldState` — exposes `Track`, `Untrack`, and `RestoreScene` for world-persistent entity management
- `IPrefabRegistry` — exposes async prefab loading by `PrefabId`; implementation-agnostic, supports future addressables swap
- `IPersistentEntity` — base contract for any entity that can be saved; exposes `EntityId`, `PrefabId`, `Capture()`, `Restore()`
- `ISpawnableEntity` — extends `IPersistentEntity`; marks an entity as lifecycle-bound, owned by a spawner
- `IWorldPersistentEntity` — extends `IPersistentEntity`; marks an entity as world-persistent, owned by `WorldState`

Data:
- `SaveFile` / `SaveFileMetadata` — the serialized save file and its header
- `SaveEnvelope` — a single savable's serialized state blob carrying `TypeName`, `Version`, and `Payload`
- `SpawnedEntityState` — `EntityId`, `PrefabId`, and a `SaveEnvelope` for one spawned instance
- `OwnedSpawnData` — list of `SpawnedEntityState`, captured by a spawner
- `WorldEntityEnvelope` — `EntityId`, `PrefabId`, and a `SaveEnvelope` for one world-persistent entity
- `SceneStateData` — `SceneId` and a list of `WorldEntityEnvelope` for all entities in a scene
- `WorldStateData` — list of `SceneStateData`, one per scene that has persistent entities
- `Vector3Data` — Unity-free position struct
- `EntityId` — Unity-free stable identifier struct; implements `IEquatable`; stored as `string` in data records, used as a value type in live objects
- `PrefabId` — Unity-free prefab identifier struct; implements `IEquatable`; used as dictionary key in `PrefabRegistry`; stored as `string` in data records

### Engine
Unity-aware infrastructure. Depends on Core.

Prefabs:
- `PrefabRegistry` — implements `IPrefabRegistry`; maps `PrefabId` to `GameObject`; currently synchronous, designed to swap to addressables without changing callers
- `PrefabRegistryDefinition` — `ScriptableObject` that holds prefab id to `GameObject` mappings, wired in the Inspector
- `PrefabRegistryInstaller` — MonoBehaviour that populates and validates the registry at scene load time; lives in the scene alongside `LevelContext`

Persistence base classes:
- `Savable<TState>` — base class for anything that can be saved and restored
- `SpawnerSavable` — base class for anything that owns spawned entities; non-generic, delegates serialization to `ISpawnableEntity`
- `WorldStateSavable` — base class for world-level persistent entity ownership; non-generic, delegates serialization to `IWorldPersistentEntity`

Systems:
- `SaveRegistry` — concrete dictionary-backed registry
- `GameStateService` — orchestrates save/load at the session level
- `SceneService` — handles scene transitions
- `LoadGameStateStep` — pipeline step that calls `RestoreAll` then `WorldState.RestoreScene` after the scene loads

World:
- Persistence:
    - `SaveSessionState` — the `ISceneRestorable` savable, captures current scene name
    - `WorldState` — implements `IWorldState`; owns all world-persistent entities grouped by scene, restored by pipeline
    - `SceneSaveRegistryBridge` — MonoBehaviour bridge; connects spawners to `ISaveRegistry` and world-persistent entities to `IWorldState`; injected into both     `PersistentEntity` and `PersistentSpawner`
    - `SerializableEntityId` — Unity-serializable wrapper around `EntityId` with a custom property drawer that auto-generates a GUID and warns on duplicates
    - `SerializablePrefabId` — Unity-serializable wrapper around `PrefabId` with a custom property drawer that warns if the id is empty or not found in     `PrefabRegistryDefinition`

- Entities:
    - `PersistentEntity<TState>` — MonoBehaviour base for world-persistent scene objects; uses `gameObject.scene.name` for scene-aware tracking; each concrete subclass     defines its own state shape
    - `PersistentSpawner` — MonoBehaviour base for spawners of lifecycle-bound entities; non-generic, uses inner `SpawnerAdapter` bridge
    - `TransformEntity` — concrete `PersistentEntity` that saves and restores position

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

---

## Classes at a Glance

| Class | Registered in SaveRegistry |
|---|---|
| `SaveSessionState` | Yes — restored before scene transition |
| `WorldState` | Yes — restored by pipeline |
| `PersistentSpawner` (via adapter) | Yes — one entry per spawner instance |
| `PersistentEntity<TState>` | No — tracked by `WorldState` |
| `TransformEntity` | No — tracked by `WorldState` |
| `ISpawnableEntity` implementors | No — owned by their spawner |
| `SceneSaveRegistryBridge` | No — infrastructure only |
| `PrefabRegistry` | No — asset management only |
| `LevelContext` | No — pipeline infrastructure |
| `LoadGameStateStep` | No — pipeline step, not a savable |
