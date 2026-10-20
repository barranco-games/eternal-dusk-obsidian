## Overview

The save system is built around explicit ownership and a clear separation between what the save system *knows about* and what it *contains*. Only a small number of root savables register into `SaveRegistry`. Everything else is owned and captured recursively by its root.

The system operates in two phases:

- **Pre-transition** — `SaveSessionState` is restored to determine which scene to load
- **Post-transition** — the level pipeline runs `LoadGameStateStep`, which restores every registered savable from the save's envelopes. The steps after it then rebuild what those envelopes only describe: `WorldEntityLoadStep` re-links or re-creates world entities, and `PlayerSpawnStep` restores the party

---

## Key Concepts

### Ownership

Every savable entity is owned by exactly one root. Roots are the only things that register into `SaveRegistry`. The registry stays lean — one entry per logical system.

| State | Owner |
|---|---|
| Scene name | `SaveSessionState` |
| Props, chests, doors, items, and runtime-spawned entities such as enemies | `WorldState` |
| Party members, not-yet-joined roster agents, quest and flag progression | `PlayerState` |
| Surface patches and who stands in them | `SurfaceSavable` (registered per level by `AreaService`) |
| Fog of war | `FogSavable` (registered per level by `AreaService`; the data lives in a per-slot side file) |
| Articy global variables | `ArticyGlobalsSavable` |
| Position of the dice stream | `DiceSavable` |

### Lifecycle dependency

There is no per-creator spawner. Every world entity, whether placed in the scene or spawned at runtime, is tracked by `WorldState` per scene through `EntityRegistry.Track`, and untracked when it is destroyed or despawned. Party members are the exception: `PlayerState` captures them, since the party outlives any one scene.

`WorldState` also outlives the scene. When a level unloads, `UntrackScene` captures that scene's entities into stored envelopes, so the next save still holds a level the player has left. An entity that was removed is remembered by id in the scene's `Despawned` list, so a reload does not bring a scene-placed one back.

### Instance identity

Each persistent entity carries two identifiers:

- `PrefabId` — a pure C# struct in Core identifying which prefab to spawn on restore; used as a dictionary key in `PrefabRegistry` via `IEquatable`; only meaningful for runtime-spawned entities that need to be re-instantiated
- `EntityId` — a pure C# struct in Core that is stable and unique per instance; implements `IEquatable`

For scene-placed entities, `EntityId` is managed through `SerializableEntityId` in the Inspector — a Unity-serializable wrapper with a custom property drawer that auto-generates a GUID on first display and warns if a duplicate is detected in the scene. `PrefabId` is managed through `SerializablePrefabId`, which warns if the value is empty or not found in `PrefabRegistryDefinition`.

For runtime-spawned entities, `EntityFactory.CreateNew` calls `EntityId.Generate()` (unless the caller passes an id) and assigns it with `AssignEntityId`. The id is saved in the `WorldEntityEnvelope` next to the `PrefabId`, so it survives a reload. The `PrefabId` is the one the factory loaded the prefab with from `IPrefabRegistry`.

`RestoreScene` matches on `EntityId`, not `PrefabId`, so multiple instances of the same prefab are unambiguous. `PrefabId` is only used by `WorldEntityLoadStep` when re-instantiating runtime-spawned entities that have no live match (`GetUnmatchedEnvelopes` → `EntityFactory.CreateFromEnvelope`) — scene-placed entities are already in the scene and do not need prefab resolution.

### Root registration

`SaveSessionState`, `PlayerState`, `WorldState`, `ArticyGlobalsSavable`, `FogSlotCleaner` and `DiceSavable` are the savables that register into `SaveRegistry` at the root. This happens in `RootInstaller` via `OnContainerBuilt`, after the DI container is fully built:

```csharp
private void OnContainerBuilt(Container container)
{
    var registry = container.Resolve<ISaveRegistry>();
    registry.Register(container.Resolve<SaveSessionState>());
    registry.Register((ISavable)container.Resolve<IPlayerState>());
    registry.Register((ISavable)container.Resolve<IWorldState>());
    registry.Register(new ArticyGlobalsSavable(() => ArticyDatabase.DefaultGlobalVariables));
    registry.Register(new FogSlotCleaner(new FogPersistenceStore()));
    registry.Register(new DiceSavable(container.Resolve<CapturableRandom>()));
}
```

`WorldState` and `PlayerState` are resolved through their interfaces and cast to `ISavable` for registration. `FogSlotCleaner` saves nothing: it only purges a deleted slot's fog, because `FogSavable` is registered only while a fogged level is loaded. Per-level savables (`SurfaceSavable`, `FogSavable`) are registered by `AreaService` when the level's areas start and unregistered when it tears down; `SaveRegistry.Unregister` removes a savable only if it still holds its id, so a scene unloading after the next one registered keeps the newer one. World entities do not register at all: they track themselves into `IWorldState` through `EntityRegistry.Track`, keyed by `gameObject.scene.name`.

### Savables and persistable entities

There are two kinds of persistent thing, and the split keeps MonoBehaviours out of the registry:

- **Savables** — pure C# classes implementing `ISavable` (usually via `Savable<TState>`), registered into `SaveRegistry`. Each captures one `SaveEnvelope` of its own state.
- **Persistable entities** — `Entity<TState>` MonoBehaviours implementing `IPersistableEntity` (`TypeName`, `Version`, `Capture`, `Restore`, `RestoreAsNew`). They never register into `SaveRegistry`; `EntityFactory` adopts or creates them, `EntityRegistry` tracks them, and `WorldState` captures them as `WorldEntityEnvelope`s (entity id, prefab id, envelope).

---

## Save Slots

A save is one `SaveFile` per slot: `Metadata` plus the list of `SaveEnvelope`s the registry captured. The file is a JSON file (Newtonsoft, indented) at `<persistent data>/Saves/<SlotId>.json`. In the editor the root is a subfolder named after the project checkout, so parallel editors keep separate saves. Fog is a side file at `AreaTiles/<SlotId>/<areaTypeId>.fog`.

- **Identity** — `SaveFileMetadata.SlotId` is minted once in `GameStateService.NewGame` as `{sanitized name}_{yyyyMMdd_HHmmss}` (`SlotNaming.BuildSlotId`, with a `_2` suffix on a collision). It names the save file and the fog folder and never changes. `SaveName` is only a display label (32 characters at most); renaming rewrites the file's metadata and moves nothing. `SaveFile` carries no separate slot id.
- **Metadata** — `SchemaVersion`, `GameVersion`, `SlotId`, `SaveName`, `PlayTimeSeconds`, `CreatedAt`, `SavedAt`. Slot listings read only this header (`SaveFileHeader`) and sort by `SavedAt`, newest first. A file whose `SlotId` does not match its filename is left out of the list.
- **Refusing a newer save** — load and rename refuse a save with a higher `SchemaVersion`, or one written by a newer game version.
- **Write** — the save is written to `<SlotId>.tmp` and then promoted over `<SlotId>.json` with `File.Replace`. The file it replaces becomes `<SlotId>.bak`. A rename keeps the existing `.bak`. There are no snapshots: each save overwrites the slot it loaded.
- **Slot-scoped side data** — a savable that keeps data outside the envelope (fog) stages it during `CaptureAsync`, promotes it in `ISavable.CommitSlot(slotId)` after the file is written, and purges it in `ISavable.DeleteSlot(slotId)`.
- **Slot screen** — the main menu's Continue entry (shown only while a slot exists) opens a screen to list, load, rename and delete slots, driven by `SaveSlotsPresenter` through `IGameStateService.ListSlotsAsync`, `LoadAsync`, `RenameSlotAsync` and `DeleteSlotAsync`.

What a slot holds, by envelope: scene name (`session_state`), party, roster and progression (`player_state`), world entities per scene (`world_state`), surfaces (`surfaces`), fog (`FogOfWar`, the envelope is a marker and the data is the side file), Articy globals (`ArticyGlobals`) and the dice stream (`Dice`). Dice are saved so that reloading cannot re-roll a check or a hit.

---

## Save Flow

```
GameStateService.SaveAsync(ct)            ← saves Current, to its own slot
  │
  ├── stamp SavedAt, GameVersion and PlayTimeSeconds
  │
  ├── SaveRegistry.GetAll()               ← a snapshot, since savables register as levels load
  │     SaveSessionState, PlayerState, WorldState, ArticyGlobals, Dice,
  │     and while a level is loaded: Surfaces, FogOfWar
  │
  ├── foreach savable → savable.CaptureAsync(envelopeSerializer, ct)
  │     SaveSessionState → captures current scene name
  │     PlayerState      → party, roster agents (joined or not), progression
  │     WorldState       → every scene, each with its tracked IPersistableEntity envelopes and despawned ids
  │     FogSavable       → stages the fog side file, returns a marker envelope
  │     envelopes of earlier saves whose savable is not registered now (fog from another level)
  │       are carried over unchanged
  │
  ├── SaveService.SaveAsync(slotId, saveFile)    ← .tmp, then File.Replace, previous file kept as .bak
  │
  └── foreach savable → savable.CommitSlot(slotId)    ← only after the file is written
```

Saves are serialized: a save, a rename or a delete waits for the one in flight (`WhenSaveSettles`).

Triggers:

- **Autosave on unload** — `SaveGameStateStep.Shutdown` calls `SaveAsync` when its level unloads, unless the run is lost (`IsDefeat`), in combat, or in an encounter, where Continue resumes from the last save. Only levels that list `SaveGameStateStep` autosave (`ILevelLoader.Autosaves`): `Prison_Cells_Start` does, `DemoArena` does not.
- **Save on quit** — `SaveOnQuit` holds a player's quit back while a level that autosaves is loaded, runs that level's unload (and so its autosave, with a 30 s timeout) and then quits. It is inactive in the editor and in batch mode.
- **Not on a new game or a load** — both set an abandon flag, so the level they unload does not write itself into the fresh or just-loaded slot.

---

## Load Flow

```
GameStateService.LoadAsync(slotId)
  │
  ├── SaveService.LoadHeader   ← refuse a newer schema or game version
  ├── SaveService.LoadAsync → SaveFile
  ├── the registered ISceneRestorable (SaveSessionState) restores its envelope   ← now knows SceneToRestoreOn
  ├── Current = save   (rolled back if the load fails)
  │
  ├── scene already open with no level loaded (a boot save)
  │     └── LevelLoader.LoadLevelAsync in place, no transition
  │
  └── otherwise SceneService.RequestTransition(SceneToRestoreOn)
        │
        ├── LevelLoader.UnloadCurrentLevelAsync
        │     ├── LevelLifecyclePipeline.Shutdown   (no autosave: the load set the abandon flag)
        │     └── WorldState.UntrackScene(scene)
        │
        ├── SceneLoader.LoadScene
        │
        └── LevelLoader.LoadLevelAsync
              └── LevelLifecyclePipeline.Initialize
                    ├── LoadGameStateStep
                    │     new game → Reset() every savable
                    │     otherwise SaveRegistry.RestoreAllAsync(Current.Envelopes)
                    │       WorldState → stores each scene's entity envelopes and despawned ids
                    │       PlayerState → keeps LastRestoredData
                    │       Surfaces, Fog, Dice, Articy → restore themselves
                    │
                    ├── WorldEntityLoadStep
                    │     → adopts scene entities, despawning those the save saw removed
                    │     → WorldState.RestoreScene(sceneId): matches tracked entities by EntityId
                    │       and calls entity.Restore(envelope, restoreContext)
                    │     → recreates unmatched (runtime-spawned) entities from their PrefabId
                    │       (EntityFactory.CreateFromEnvelope)
                    │
                    └── PlayerSpawnStep
                          → restores party members from PlayerState.LastRestoredData
```

Savables are registered before the pipeline runs, and `WorldEntityLoadStep` runs after `LoadGameStateStep`, so the world's stored envelopes are in place before any entity is matched. `EntityRegistry` keys entities by `gameObject.scene.name`, and `WorldEntityLoadStep` throws if the level definition's `SceneName` differs from the loaded scene, since entities would otherwise be looked up under a key nothing wrote. A savable only some levels register (fog) is absent from a save made elsewhere; the save carries its last envelope over unchanged.

---

## Adding a New Savable

### World-persistent scene object

1. Define a state record in Gameplay/Data, e.g. `DoorData` (see `EntityData`, `WeaponData`)
2. Create a class extending `Entity<DoorData>` in Engine/World/Entities
3. Implement `TypeName`, `Version`, `CaptureTyped`, `RestoreAsNew` and `RestoreTyped`
4. Attach it to the GameObject in the scene
5. Set a unique `EntityId` and the correct `PrefabId` in the Inspector

No registration code is needed: `WorldEntityLoadStep` finds every `IPersistableEntity` in the scene and `EntityFactory.Adopt` tracks it.

```csharp
public sealed class DoorEntity : Entity<DoorData>
{
    public override string TypeName => "door";
    public override int Version => 1;

    protected override DoorData CaptureTyped() => new()
    {
        EntityId = EntityId.ToString(),
        TransformData = transform.ToData(),
        IsOpen = _isOpen
    };

    public override void RestoreAsNew() { }

    protected override void RestoreTyped(DoorData state, RestoreContext context)
    {
        transform.SetData(state.TransformData);
        _isOpen = state.IsOpen;
    }
}
```

State records derive from `EntityData`, as `ActorData` and `WeaponData` do.

### Runtime-spawned entity

An entity created while the game runs needs no spawner of its own. It is an `Entity<TState>` prefab, built exactly as above, with:

1. its `PrefabId` registered in `PrefabRegistryDefinition` (the `SerializablePrefabId` drawer warns when it is not)
2. creation through `IEntityFactory.CreateNew(prefabId, position, ct)`, which loads the prefab, generates an `EntityId`, initializes it and tracks it in `EntityRegistry` and so in `WorldState`

On load, `WorldEntityLoadStep` finds the saved envelopes that match no live entity and recreates each one with `EntityFactory.CreateFromEnvelope`, using the saved `EntityId` and `PrefabId`.

### Root savable (state that is not an entity)

State that belongs to no entity — a stream, a set of variables — is a `Savable<TState>`:

1. Define a serializable state class
2. Extend `Savable<TState>` and implement `Id`, `Version`, `CaptureTyped` (it must build a fresh object: the payload is serialized off the main thread) and `RestoreTyped`; override `Reset` to clear it on a new game
3. Register it in `RootInstaller.OnContainerBuilt`, or from a per-level service that unregisters it on teardown (`AreaService` does this)
4. If it keeps data outside the envelope scoped to a slot, override `CommitSlot` and `DeleteSlot`

`DiceSavable` is the smallest example.

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

`Restore` calls `Migrate` automatically when `envelope.Version < Version`. An envelope newer than the build (`envelope.Version > Version`) cannot be migrated downward, so `ThrowIfNewerThan` refuses it instead of restoring misread data. If no migration is defined, the base implementation logs a warning and passes the data through as-is. `Entity<TState>` has the same `Migrate` hook for persistable entities, and `SaveFileMetadata.SchemaVersion` guards the file as a whole.