## Overview

A level is a Unity scene plus a `LevelDefinition` asset. The scene holds what is placed by hand. The definition holds the level's grid, whether it has fog of war, and an ordered list of lifecycle steps that bring the level up after the scene loads (restore the save, adopt the scene's entities, spawn the party, start the HUD, start an encounter) and take it down again before the next scene replaces it.

Three pieces do the work:

- **`SceneService`** (Systems, root) changes scenes: loading screen, unload the old level, load the new scene, load the new level.
- **`LevelLoader`** (Engine, one per scene) loads and unloads the level of the scene it lives in, by running the definition's steps through a `LevelLifecyclePipeline`.
- **`GameStartup`** (Engine, root) loads the language and the audio banks once at launch. Every transition waits for it.

Scenes load by name through `SceneManager`, one at a time (`LoadSceneMode.Single`). Addressables is installed but loads no scene ([[TDD#3.3 Objetos 3D, terreno y gestión de escenas|TDD §3.3]]). What the save steps restore is [[Save & Load System]]'s, and what the grid is used for is [[Area System]]'s.

---

## Key Concepts

### Layered types

| Layer   | Types |
|---------|-------|
| Core    | `ILevelCatalog`, `ILevelLoader`, `ILevelLoaderProvider` (`Core/Level`); `ISceneService`, `SceneTransitionRequest`, `ISceneLoader`, `ILoadingScreen`, `IStartup` (`Core/Scenes`) |
| Systems | `SceneService`, `LevelTravel`, `LoadingInputLock` (`Systems/Scenes`); `RunNavigation` (`Systems/UI/Navigation`); `GameStateService` (`Systems/GameState`) |
| Engine  | `LevelDefinition`, `LevelCatalogSO`, `ILevelContext`, `LevelContext`, `ILevelLifecycleStep`, `LevelLifecyclePipeline`, `LevelLoader`, `LevelLoaderProvider`, `LevelExit` (`Engine/Level`); the steps in `Engine/World/InitializationSteps` (`StartEncounterStep` in `Engine/Encounters`); `GameStartup`, `UnitySceneLoader`, `UnityLoadingScreen`, `BootController` (`Engine/Unity/Scenes`) |

### Two containers

Reflex builds two scopes ([[TDD#Inyección de dependencias y composición|TDD §2.4]]):

- **Root** — `RootScope.prefab` with `RootInstaller`, built once and kept for the whole run. It registers the scene-independent services as lazy singletons: `SceneService`, `UnitySceneLoader`, `UnityLoadingScreen`, `GameStartup`, `LevelLoaderProvider`, `GameStateService`, `RunNavigation`, `LevelCatalogSO` (as `ILevelCatalog`), and the save and party state.
- **Scene** — a child container per scene. Gameplay scenes get it from an instance of `SceneManager.prefab`, which carries `SceneInstaller`, `InputInstaller`, `UIInstaller`, `AreaInstaller`, `TurnInstaller`, `MovementInstaller` and the scene's `LevelContext`. The main menu has its own `SceneScope` with `MenuInstaller` only, so it has no level.

`SceneInstaller` registers the `LevelContext` (as `ILevelContext`), `LevelLoader` (as `ILevelLoader`) and `LevelTravel`. Once its container is built it hands the loader to the root's `LevelLoaderProvider`, which is how root services reach the current scene's loader. Its `OnDestroy` clears `Current` only if it still holds its own loader, so a scene with no level (the main menu) is left with none rather than the last scene's.

### The level definition

```csharp
[CreateAssetMenu(fileName = "New LevelDefinition", menuName = "EternalDusk/LevelDefinition")]
public sealed class LevelDefinition : ScriptableObject
{
    [SerializeReference] public List<ILevelLifecycleStep> LifecycleSteps = new();
    public string LevelId { get; }       // _levelId, else the scene name
    public string SceneName { get; }
    public Vector3 WorldOrigin { get; }
    public float WorldSizeX { get; }
    public float WorldSizeY { get; }     // the world's Z extent
    public GridMetrics Metrics { get; }  // from _cellSize
    public bool FogEnabled { get; }      // !_disableFogOfWar
    public int ChunkCountX { get; }
    public int ChunkCountY { get; }
}
```

- `SceneName` is the scene file to load and the key `WorldState` stores the scene's entities under.
- `LevelId` keys what the level saves beside the save file (its fog), so renaming the scene does not orphan it.
- `_worldOrigin`, `_worldSizeX/Y` and `_cellSize` size the area grid. `AreaInstaller` builds the `WorldGrid` from them and hands `ChunkCountX/Y`, `LevelId` and `FogEnabled` to `AreaService`. A chunk is always 128 cells, so the cell size decides how many chunks a level needs ([[Area System#Grid Constants|Area System]]). A `_cellSize` of 0 (an asset older than the field) falls back to the project default of 0.1.
- Fog is on unless `_disableFogOfWar` is set.

Music is not on the definition: `MusicService` picks it by scene name from `MusicCatalog.asset` when it starts and whenever `SceneChanged` fires.

### Which level a scene is

There is no lookup by scene name. A gameplay scene's `LevelContext._definition` points at its `LevelDefinition`. `LevelCatalog.asset` (`LevelCatalogSO`) lists the levels in play order, but the code reads only `StartScene`, the first entry's `SceneName`, which is where New Game starts. Today that is `Prison_Cells_Start`.

```csharp
public interface ILevelContext
{
    bool IsNewGame { get; set; }
    string SpawnPointId { get; set; }
    LevelDefinition Definition { get; }
    IReadOnlyDictionary<string, PartySpawnPoint> SpawnPoints { get; }
    IUIManager UIManager { get; }
    TransformData? CameraSpawnPoint { get; }
}
```

`LevelContext` is the scene's own data for the loading level: the definition, the named party spawn points (a leader transform and follower transforms each), an optional camera spawn point and the scene's `UIManager`. Steps get services through `[Inject]` fields, not from the context.

### Boot

1. Unity opens build scene 0, `MainMenu`. Reflex builds the root container, then the menu's scene container.
2. `RootInstaller.OnContainerBuilt` calls `GameStartup.Begin()`, which loads the saved language and the FMOD banks in parallel. `IStartup.WhenReady()` completes when both are done, even if one failed, so nothing waits forever.
3. **New Game** — `MainMenuPresenter` calls `RunNavigation.StartNewRun`, which calls `GameStateService.NewGame(ILevelCatalog.StartScene, transition: true)`. That makes a fresh save file and asks for a transition with `isNewGame: true`.
4. **Continue** — the slot screen calls `GameStateService.LoadAsync(slotId)`, which transitions to the scene the save was made in ([[Save & Load System#Load Flow|Save & Load System]]).

`RunNavigation` also restarts the run (`NewGame` on the current scene) and returns to the main menu (a transition to the hard-coded scene name `"MainMenu"`).

**Pressing play in the editor on a level scene.** `SceneInstaller.Awake` (editor only, `_autoBoot` on) boots the run the first time in a play session (`BootController.HasBooted`). It shows the loading screen, then loads the newest save slot that loads, or starts a new game in the open scene with no transition. A level with no `SaveGameStateStep` (DemoArena) ignores the slots and always starts fresh, so it cannot follow the newest slot into another level. Pressing play on `MainMenu` boots nothing.

`GameStateService` also loads a level without `SceneService` when the scene is already open with no level loaded: the editor boot above, and a load whose save was made in the open scene. Those loads show no transition and raise no `SceneChanged`.

### Scene transitions

```csharp
public readonly struct SceneTransitionRequest
{
    public SceneTransitionRequest(string sceneName, bool showTransition, string spawnPointId = null);
}

UniTask<bool> RequestTransition(SceneTransitionRequest request, bool isNewGame = false, CancellationToken cancellationToken = default);
```

```
SceneService.RequestTransition
  ├─ already transitioning → warn, return false (not queued)
  ├─ ISceneLoader.CanLoad(scene) false → throw ArgumentException   (the old level is still up)
  ├─ IsTransitioning = true
  ├─ ShowTransition → ILoadingScreen.Show
  ├─ IStartup.WhenReady
  ├─ SuspendCollector (players only)
  │    ├─ LevelLoaderProvider.Current.UnloadCurrentLevelAsync   (the old scene's loader)
  │    ├─ ISceneLoader.LoadScene                                (Single mode)
  │    ├─ CurrentScene = scene; SceneChanged
  │    └─ LevelLoaderProvider.Current.LoadLevelAsync(spawnPointId, isNewGame)   (the new scene's loader)
  ├─ ResumeCollector
  └─ ShowTransition → ILoadingScreen.Hide; IsTransitioning = false
```

The loading screen covers both the old level's shutdown (its autosave included) and the new level's pipeline. A scene with no loader (the main menu) skips the unload or the load. `UnitySceneLoader.CanLoad` is `Application.CanStreamedLevelBeLoaded`, so a scene left out of the build list fails before anything unloads. The GC is disabled for the transition in a player build. The editor throws on any GC mode change, so there it stays on.

Errors are not caught: the `finally` blocks hide the screen and clear `IsTransitioning`, and the exception reaches the caller. A step that throws during the new level's load leaves the new scene open, `CurrentScene` updated and the loader reporting `IsLoaded`.

### Loading and unloading a level

```csharp
public interface ILevelLoader
{
    bool IsLoaded { get; }    // true from a load, failed ones included, until its unload
    bool Autosaves { get; }   // the definition lists a SaveGameStateStep
    UniTask LoadLevelAsync(string spawnPoint, bool isNewGame, CancellationToken ct);
    UniTask UnloadCurrentLevelAsync(CancellationToken ct);
}
```

`LevelLoader.LoadLevelAsync`:

1. throws if the level is already loaded, since the scene still holds the live party and a second run would spawn it twice
2. sets `IsNewGame` and `SpawnPointId` on the context
3. injects each step from the scene container (`AttributeInjector.Inject`). An empty slot in the list throws
4. builds a `LevelLifecyclePipeline` over the steps and awaits `Initialize`

`UnloadCurrentLevelAsync` awaits the pipeline's `Shutdown`, then `WorldState.UntrackScene(SceneName)`. A second unload while one runs waits for the first instead of shutting down twice: quitting and a transition can overlap, and a second shutdown would autosave a party already cleared. Unloading with no level loaded does nothing.

The steps are `[SerializeReference]` objects stored inside the definition asset, so the same instances serve every load. After shutdown, `LevelLoader.Release` nulls every `[Inject]` member on them by reflection, or the asset would keep the unloaded scene's services alive. Runtime state on a step must be `[NonSerialized]` or reset in `Shutdown`.

### The lifecycle pipeline

```csharp
public interface ILevelLifecycleStep
{
    UniTask Initialize(ILevelContext context, CancellationToken ct);
    UniTask Shutdown(ILevelContext context, CancellationToken ct);
}
```

- **Initialize** runs the steps in list order, one at a time. A step that throws is logged with its type and rethrown, so the load fails loudly and no later step runs. A cancelled token stops it.
- **Shutdown** runs in reverse, from the last step that started (the one that threw included) down to the first. A step that throws is logged and skipped, so one broken step cannot keep the scene from changing. Reverse order means a step shuts down while what it was built on still stands, and the autosave runs before the party is cleared.

### Lifecycle steps

| Step | Initialize | Shutdown |
|------|------------|----------|
| `LoadGameStateStep` | new game: reset every savable; otherwise restore them from `GameStateService.Current` | — |
| `WorldEntityLoadStep` | adopt the scene's entities, restore their saved state, re-create runtime-spawned ones; wait for the area grid's active region and rebake it. Throws if `SceneName` is not the open scene | — |
| `SkipTutorialsStep` | mark every tutorial seen, so no popup holds input (test levels) | — |
| `PlayerSpawnStep` | spawn the roster at the spawn point, restore each member, build the party and set the leader | clear the party and the roster |
| `UILifecycleStep` | wait for the scene's `UIManager` (up to 30 s), then `IUIService.Initialize(leader)`; re-seed after a live UI reload | unhook the reload |
| `StartEncounterStep` | start the level's encounter without waiting for it, unless it is already completed | cancel it |
| `SaveGameStateStep` | — | autosave, unless defeated, in combat or in an encounter |

The save steps, the spawn and the autosave are covered in [[Save & Load System]], the encounter step in [[Encounter System#Starting an encounter|Encounter System]], the party in [[Party System#The roster and joining|Party System]], and the HUD in [[UI Architecture#Starting the HUD|UI Architecture]].

Order rules, pinned by `LevelDefinitionTests` for every level asset:

- `LoadGameStateStep` comes first: everything after reads restored state, and it resets the savables on a new game.
- `SaveGameStateStep` comes after `PlayerSpawnStep` and every encounter step. Shutdown runs last to first, and those steps clear what the save reads.
- Every level autosaves except DemoArena.

In the shipped definitions `WorldEntityLoadStep` precedes `PlayerSpawnStep`, `UILifecycleStep` follows it (it needs a leader), and `SkipTutorialsStep` comes after `LoadGameStateStep`, whose reset would undo it.

### Shipped levels

All in `Data/Levels`. Only `MainMenu`, `DemoArena` and `Prison_Cells_Start` are in the build list.

| Level | Cell size | World size | Fog | Steps after `LoadGameStateStep`, `WorldEntityLoadStep` | Build / catalog |
|-------|-----------|------------|-----|-------------------------------------------------------|-----------------|
| `Prison_Cells_Start` | 0.05 | 38.4 × 32 | off | `PlayerSpawnStep`, `UILifecycleStep`, `SaveGameStateStep` | build 2, catalog first (start scene) |
| `DemoArena` | 0.05 | 128 × 128 | off | `PlayerSpawnStep`, `UILifecycleStep`, `StartEncounterStep` (`DemoArenaOpening`) | build 1, catalog second |
| `ScenarioBoot` | 0.1 | 1024 × 1024 | on | `PlayerSpawnStep`, `UILifecycleStep`, `SaveGameStateStep` | neither (test scene) |
| `SkillLab` | 0.1 | 1024 × 1024 | on | `SkipTutorialsStep`, `PlayerSpawnStep`, `UILifecycleStep`, `SaveGameStateStep` | neither (test scene) |

DemoArena has no `SaveGameStateStep`, so `Autosaves` is false: leaving it or quitting there writes nothing, and the editor boots it fresh. Since 0.2.0 it is meant for debugging only, although the catalog still lists it second. ScenarioBoot and SkillLab turn `_autoBoot` off and start their own runs (`ScenarioBootRunner`, `SkillLabRunner`).

### Spawn points and arrival

A transition's `SpawnPointId` reaches `ILevelContext.SpawnPointId`. `PlayerSpawnStep` uses that spawn point if the scene has it, else the one named `Default`, else the world origin with a warning. With a named spawn point, restored members keep the spawn position instead of their saved one: the party walked in from another level. With none (New Game, Continue), a restored party goes back to where it was saved. The camera starts on `CameraSpawnPoint` only on a new game.

### Travelling between levels

`LevelExit` is a trigger volume with a `_sceneName` and a `_spawnPointId`. It requires a `Rigidbody`, and `Reset` makes the body kinematic and the collider a trigger (adding a `BoxCollider` if there is none). When a `PlayerAgent` enters it, it calls `LevelTravel.TryExit(agent.EntityId, scene, spawnPoint)`, which refuses (returns false, does nothing) during a transition, when the walker is not the party leader, and in combat or an encounter, the two states in which the outgoing level's autosave also skips. A defeated run is not checked. Otherwise it requests a transition with the loading screen.

The next level restores from the outgoing level's unload autosave, which is why a `LevelExit` placed in a level without `SaveGameStateStep` logs an error on `Start`: the party would arrive as the last save left it.

No scene places a `LevelExit` yet: Prison_Cells_Start is the only level of 0.2.0 so far.

### Loading screen and input

`UnityLoadingScreen` is a black full-screen `UIDocument` with its own `PanelSettings` at the highest sorting order, created on first use and kept across scenes. `Show` fades in over 0.25 s. `Hide` holds black for 0.3 s, warming the outline renderer meanwhile, then fades out over 0.25 s. A frame longer than 1/30 s counts as 1/30 s, so the stall after a scene load cannot eat the hold. A newer `Show` or `Hide` takes over from an older one, and `ShowImmediate` goes black at once (the editor boot).

`LoadingInputLock` (an eager scene singleton from `InputInstaller`) holds an `IPlayerInputLock` while the screen is visible, so clicks, keys and the camera do nothing and the HUD is hidden during a load (Pause still answers). When its scene is disposed it does not release the hold: the scene is unloading behind the screen, and releasing would re-enable that scene's input.

### Debugging

- **`newgame:<scene>`** — console command: a new game in any scene in the build list, start level or not
- **`-smoke`** — in a development or smoke build, `SmokeBuildDriver` starts a new game in the start scene, waits for the leader to spawn, and quits with a pass or fail verdict. CI runs it on every player build
- **`-seed <n>`** — seeds the dice stream ([[Combat & Dice#One seeded stream|Combat & Dice]])

---

## Divergence from the GDD

The GDD says little about how levels load. [[Cárcel General]] proposes the scene naming rule:

| Topic          | GDD | Code |
|----------------|-----|------|
| Scene names    | `Zona_Subzona_Descripción` (`Prison_Cells_Start`) | the 0.2.0 level follows it; `DemoArena` and the test scenes predate it |
| Level states   | an optional iteration suffix (spelled `_Iteracción` there) saves different states of a level as separate scenes, as in `Prison_Cells_MetColEgon_005` | a level's changing state is saved in `WorldState` per scene. A second scene for the same place would be a separate level with its own definition, entities and save record |

The TDD plans to load scenes and prefabs through Addressables ([[TDD#3.3 Objetos 3D, terreno y gestión de escenas|TDD §3.3]]). Scenes still load by name through `SceneManager`, as that section already notes.

---

## Adding a New Level

1. Create the scene, name it by the GDD's rule, add it to the build list, and drop in a `SceneManager.prefab` instance
2. Create a `LevelDefinition` (*EternalDusk/LevelDefinition*) under `Data/Levels`: `_sceneName` (the scene file name), `_levelId`, `_worldOrigin` and `_worldSizeX/Y` covering the playable area, `_cellSize`, and `_disableFogOfWar` if it has no fog
3. Fill `LifecycleSteps`: `LoadGameStateStep`, `WorldEntityLoadStep`, `PlayerSpawnStep` (with the roster), `UILifecycleStep`, any `StartEncounterStep`, then `SaveGameStateStep` last
4. Point the scene's `LevelContext._definition` at it and author a `Default` spawn point, plus one per `LevelExit` that leads here
5. Add a `MusicCatalog.asset` entry for the scene name, or it plays no music and warns
6. Add it to `LevelCatalog.asset`; first place makes it the New Game scene

`LevelDefinitionTests` checks the step order and a unique `LevelId` on every level asset.

---

## Adding a New Lifecycle Step

1. Add a `[Serializable, SourceGeneratorInjectable] sealed partial class` in `Engine/World/InitializationSteps` implementing `ILevelLifecycleStep`, its services in `[Inject]` fields
2. Keep runtime state in `[NonSerialized]` fields, or reset it in `Shutdown`: the instance lives on the asset and is reused by every load
3. Throw from `Initialize` only if the level cannot work without the step: it fails the whole load. Undo in `Shutdown` what `Initialize` set up, since shutdown runs last to first
4. Add it to each level's `LifecycleSteps` where its inputs are ready, and add an order rule to `LevelDefinitionTests` if it depends on another step
