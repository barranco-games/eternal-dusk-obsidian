## Overview

The camera is a perspective Cinemachine 3 rig orbiting a point on the ground: a free camera the player pans around, a focus camera locked to the party leader or the acting agent, fixed shots for dialogue, and a debug fly camera. Input is one Input System asset whose actions reach the game through small engine-free contracts in `Core/Input`, so Systems code hears "confirm pressed" or "skill slot 3" and never a key.

Both live mostly in Engine. Inner layers see the camera through `ICameraController`, `ICameraFocus`, `ICameraShotService` and friends (Core), and input through events. What a click does once it reaches the world (hover, the handler pipeline, terrain clicks to movement) is [[Action System#9. Interaction Dispatch|Action System §9]]; this page covers the camera, the ray, the actions and the locks around them.

No GDD page describes the camera or the controls, so everything here is code-first.

---

## Key Concepts

### Layered types

| Layer   | Camera | Input |
|---------|--------|-------|
| Core    | `ICameraController`, `ICameraFocus`, `ICameraShotService`, `ICameraEffectService`, `ICameraInputLock`, `ICameraSettings`, `CameraPose`, `CameraEffectId`, `CameraSettingsChanged` (`Core/Camera`); `IRayProvider`, `IHitSource` (`Core/Interactions/Contracts`) | `IGameplayInput`, `ISkillSlotInput`, `ISkipTurnInput`, `IOutlineRevealInput`, `IPointer`, `IPlayerInputLock` (`Core/Input`); `IPointerOverUIChecker` (`Core/Interactions/Contracts`) |
| Systems | `CameraSettings` (`Systems/Camera`); `FlyCameraController` (`Systems/Debugging`) | the consumers: `PointerInteractionService`, `GroundClickMovementInput`, `CancelCurrentActionInput`, `LeaderCycleInput`, `EntityOutlineReveal`, `DialogueInputLock`, `LoadingInputLock` and the HUD presenters |
| Engine  | `CameraManager`, `CameraLeaderFollower`, `CameraTurnFocus`, `CameraShotService`, `CameraEffectService`, `OcclusionRaycastService`, `UnityCameraRayProvider`, `PhysicsHitSource`, camera effects (`Engine/Unity/Camera`) | `Inputs.inputactions` and its generated `Inputs` class, `GameplayInput`, `MousePointer`, `PlayerInputGate`, `CameraInputGate`, `CameraInput`, the debug hotkeys (`Engine/Unity/Input`); `UnityPauseEffects` (`Engine/Unity/Utils`) |

`SceneInstaller` registers the rig and its services (and `DialogueInputLock`); `InputInstaller` registers the input services plus the ray provider and the hit source; `ICameraSettings` is root-scoped (`RootInstaller`) so it survives scene loads. Everything is a singleton. `CameraManager`, `CameraLeaderFollower`, `CameraTurnFocus`, `OcclusionRaycastService` and the input consumers resolve eagerly, since nothing asks for them but they must listen from the first frame.

```csharp
public interface ICameraController
{
    Vector3Data FocusPoint { get; }
    bool IsFree { get; }
    bool IsDebug { get; }
    CameraPose Pose { get; }
    void MoveTo(Vector3Data position);
    void SetFree(bool free);
    void SetDebug(bool enabled);
    void SetPose(CameraPose pose);
    void SetZoomEnabled(bool enabled);
}
```

### The rig

`SceneInstaller` instantiates `Assets/Prefabs/Camera/CameraManager.prefab` per scene and hands it the scene's `CinemachineBrain` (on `Main Camera`: perspective, 60° FOV). The prefab holds four Cinemachine cameras, and `CameraManager` picks the live one by priority:

| View | Camera | Priority | Behaviour |
|------|--------|----------|-----------|
| Free | `FreeCam`, tracking `FreeCam Pivot` | 1 (focus 0) | the default. The player pans the pivot; no damping |
| Focus | `FocusCam`, tracking the target | 1 (free 0) | locked to the target with 0.5 s position and composer damping |
| Shot | `DialogueCam_01` / `_02` | 50 for the camera just cut to, 49 for the other (they swap each shot); 0 once released | fixed framing for dialogue, alternating so each shot blends from the last |
| Debug | `DebugCam`, created on first use | 100 while active | the free-flying camera ([[Commands & Debugging#Debug hotkeys\|Commands & Debugging]]) |

Free and focus share the same orbit: a `CinemachineOrbitalFollow` sphere of radius 8.5 m, pitch between 40° and 89.9° (starting at 45°), yaw wrapping freely, and an "Orbit Scale" radial axis from 0.3 to 1 (starting at 0.6). The camera sits 2.55 to 8.5 m from its target, 5.1 m at start. The custom blends (`Assets/Data/Camera/CMBlendSettings_Level_1.asset`) snap focus → free in 0.1 s (`HardOut`) and ease free → focus over 0.8 s; any other pair takes the brain's 2 s ease.

`ICameraManager` (Engine) adds what only Engine needs: `ActiveCamera` (the brain's output camera), `ConfigureTarget`, `SetTarget` and `SetInitialPosition`. `SetTarget` takes `object` and silently ignores anything that is not a `Transform`.

### Who points the camera

| When | Who | What happens |
|------|-----|--------------|
| Level start | `PlayerSpawnStep` | `ConfigureTarget(leader)` starts in free view; `SetInitialPosition` then places the pivot at the level's camera spawn point with its yaw. A restored game uses the leader's position with the same yaw, and a level with no spawn point leaves the camera on the leader ([[Level & Scene Loading]]) |
| Leader change | `CameraLeaderFollower` | `SetTarget(leader)`. In free view the pivot glides to the new leader at 10 m/s, then stops; in focus view the focus camera retargets |
| Combat turn start | `CameraTurnFocus` (`ICameraFocus`) | follows the leader when it is in the acting run, else the acting agent; an enemy only while the party can see it, else the leader. It switches a free camera to focus |
| Enemy concealed or revealed, back to exploration | `CameraTurnFocus` | hands the camera back to the leader, or takes it when an enemy comes into sight on its own turn |
| Initiative portrait clicked | `InitiativeOrderPresenter` → `ICameraFocus.Focus` | honoured only for a visible entity |
| Dialogue stage direction | `camera:shot:...` → `ICameraShotService` | see Shots below |

Free view does not follow a walking leader. `SetTarget` makes the pivot glide once, and panning cancels the glide. Between leader changes the player keeps the leader in frame by panning or by switching to focus (Space).

### Camera controls

The `Camera` action map does not go through the generated `Inputs` class. The prefab's `PlayerInput` (Send Messages) calls `CameraInput.OnMoveCamera` and `OnToggleCamera`, and a `CinemachineInputAxisController` on each of `FocusCam` and `FreeCam` reads `OrbitCamera` and `ZoomCamera` directly.

| Control | Binding | Effect |
|---------|---------|--------|
| Pan | WASD, arrow keys, gamepad left stick | `CameraManager.SetMovementDelta`; moves the free pivot at 10 m/s relative to the camera's yaw. Panning from focus view switches to free |
| Rotate | middle mouse + drag; Q / E | the drag turns yaw and pitch (gains 0.7 and -1), Q / E yaw only; both scaled by the rotation-speed setting |
| Zoom | mouse wheel | the radial axis, 0.3 to 1. Suspended while the pointer is over the action log, which takes the wheel (`SetZoomEnabled`) |
| Toggle free / focus | Space | `CameraManager.ToggleCam` |

There is no edge scrolling. The free pivot is kept in bounds by authored colliders, not numbers: a 0.3 m sphere cast against the `CameraWallLimit` layer slides the pan along walls and brakes it over the last 1.5 m, and while panning a downward ray (from 50 m above the pivot, 200 m long) against `CameraGroundLimit` sets the pivot's height, keeping the last height on a miss. Focus view has no bounds; it follows its target.

`ICameraSettings.RotationSpeed` (0 to 1, default 0.25) is the only camera setting. `CameraManager` multiplies each orbit axis's gain by `Lerp(0.1, 1, RotationSpeed)`, leaving zoom alone. It is saved with the user settings and edited by the settings panel's slider ([[UI Architecture]]).

### Shots

```csharp
public interface ICameraShotService
{
    bool IsActive { get; }
    void Focus(EntityId entity, float blendSeconds);
    void Hold(CameraPose pose, float blendSeconds);
    void Release(float blendSeconds);
}
```

A shot is a fixed framing above the gameplay rig. `Focus` frames an entity from the prefab's `_shotOffset` (5 m to the target's left and 5 m up, level front to back, in the target's local space), `Hold` places it on an exact pose, and `Release` drops back to the gameplay camera. The blend is the caller's: an ease over `blendSeconds`, or a cut for 0. Only the `camera` command calls it, as `camera:shot:<entity>[:<sec>]`, `camera:shot:pose:<x>:<y>:<z>:<pitch>:<yaw>[:<sec>]` and `camera:shot:release[:<sec>]`, with a default of 1 s. Articy stage directions are the way shots are authored ([[Dialogue System]]).

Nothing releases a shot by itself. A conversation that frames a shot and ends without `camera:shot:release` leaves the shot camera live.

### Camera effects

`ICameraEffectService.Play(CameraEffectId)` plays a named effect, fire-and-forget. `CameraEffectService` maps ids to `CameraEffectDefinition` assets, each a list of `ICameraEffect` parts: `CameraShakeEffect` (a Cinemachine impulse) and `CameraFovPunchEffect` (a FOV curve applied by `CameraFovPunchExtension` on both rig cameras). The library holds one effect today, `Shake`: a -3° FOV punch and an impulse, both over 0.2 s. The impulse goes in a random direction in the screen plane, since `_randomizeDirection` is on and the authored downward `_direction` goes unused. `SkillCuePlayer` plays a skill cue's camera effect.

### Seeing the party through walls

`OcclusionRaycastService` cuts see-through holes for up to four party members. Each frame it sphere-casts (0.5 m) from the camera to each member against the `Occludable` layer, fades the hit renderers' `_EDOccluded` property over 0.4 s, and publishes the members' viewport points for the shader. The cap of four matches `SEE_THROUGH_MAX_HOLES` in `SeeThroughHole.hlsl`, which a test pins.

### From the screen to the world

```csharp
public interface IRayProvider { RayData CreateRay(Vector2Data screenPosition); }
public interface IHitSource { bool TryHit(in RayData ray, Vector2Data screenPosition, out InteractionHit hit); }
```

`UnityCameraRayProvider` builds the ray from `ICameraManager.ActiveCamera`, the brain's output camera, so it stays right during a blend. `PhysicsHitSource` is the only `IHitSource`. It casts once (up to 16 hits, 100 m) against the interactable mask (`Default` and `Obstacle`) and the terrain mask (`Terrain`), keeps the nearest hit it can resolve, skips a concealed interactable and the entity the aimer is ignoring, and drops a hit hidden behind other scenery. Because the nearest resolvable hit wins whatever its layer, `DefaultHitArbitrationPolicy`'s interactable-over-terrain rule would only matter with a second hit source. Dispatch from there is [[Action System#Pointer resolution and dispatch|Action System §9]].

### Input actions

One asset, `Engine/Unity/Input/Inputs.inputactions`, generates the `Inputs` class. `InputInstaller` creates it and enables the `Gameplay` and `Pointer` maps.

| Map | Action | Default binding | Reaches |
|-----|--------|-----------------|---------|
| Gameplay | `Confirm` | left mouse | `IGameplayInput.ConfirmPressed` → `PointerInteractionService`: entity clicks into the handler pipeline, terrain clicks to movement and ground targeting |
| | `Cancel` | right mouse | `CancelPressed` → `CancelCurrentActionInput`: interrupts the leader's activity |
| | `Pause` | Esc | `PausePressed` → `CancelCurrentActionInput`: resume, else close the popup, else interrupt the leader, else pause. While a player lock is held it does nothing past closing the popup, except in a conversation, where it pauses |
| | `SkillSlot` | 1 to 9, 0 | `ISkillSlotInput.SkillSlotPressed(int)` → `SkillBarPresenter`. The binding index is the slot, and `SkillSlotKeys` gives the bar its key labels |
| | `RevealOutlines` | left Alt, held | `IOutlineRevealInput.RevealHeldChanged(bool)` → `EntityOutlineReveal` |
| | `CycleLeader` | Tab | `CycleLeaderPressed` → `LeaderCycleInput` ([[Party System]]) |
| | `SkipTurn` | T | `ISkipTurnInput.SkipTurnPressed` → `TurnPresenter`, combat only ([[Turn System]]) |
| Pointer | `Point` | mouse position | `IPointer.Position` |
| Camera | `MoveCamera`, `OrbitCamera`, `ZoomCamera`, `ToggleCamera` | see Camera controls | the camera prefab |

`GameplayInput` implements the four Gameplay contracts over the `performed` (and, for the reveal, `canceled`) callbacks. `MousePointer` implements `IPointer`; its `Scroll` and `IsPressed` read `Mouse.current` and `Pointer.current` directly. Dialogue has no action of its own: a click on the dialogue panel advances it ([[Dialogue System]]). The debug keys F9 and F10 poll `Keyboard.current` and are not in the asset.

There is no rebinding (no rebinding API is called anywhere) and no gamepad play: only `MoveCamera` has gamepad, joystick and XR bindings. Only the skill bar's key labels come from the bindings; the on-screen controls panel takes its text from the string table, so a changed binding would not update it.

### Locks and gating

| Situation | Gate | Effect |
|-----------|------|--------|
| Pointer over UI, outside the window, window unfocused | `PointerInteractionService` (`IPointerOverUIChecker`, `IPointer.IsInsideWindow`, `IApplicationFocus`) | no hover, no ray, no dispatch; the click that refocuses the window is swallowed. Camera orbit is not UI-gated |
| Conversation open, loading screen, tutorial popup, an item's after-pickup conversation | `IPlayerInputLock` (`PlayerInputGate`), held by `DialogueInputLock`, `LoadingInputLock`, `TutorialPresenter`, `ItemPickupService` | the first hold disables the whole `Gameplay` map except `Pause`, takes a camera hold and hides the HUD; the last release re-enables the whole map |
| End screen | `EndGamePresenter` takes an `ICameraInputLock` and hides the HUD | camera frozen; gameplay actions stay enabled |
| Paused | `UnityPauseEffects` | disables `Confirm`, `SkillSlot` and `SkipTurn`, takes a camera hold and freezes particles; on resume it re-enables them unless a player lock is held. `Pause` (which resumes), `Cancel`, `CycleLeader` and `RevealOutlines` stay on; the last three check the pause themselves |
| Another agent's turn | not a gate on input | keys and clicks still fire. The consumers that spend the turn (ground clicks, the skill bar, wait, pickup) ask `IActiveTurn.PlayerMayAct` and refuse ([[Turn System#Who may act: IActiveTurn\|Turn System]]); Cancel, Tab and the outline reveal do not. The camera stays free to move |

`CameraInputGate` (`ICameraInputLock`) counts holds the same way: the first deactivates the camera's `PlayerInput` and its axis controllers, the last reactivates them. The `Pointer` map is never disabled, so hover still resolves under a lock; clicks do nothing because `Confirm` is off.

### Ticking and pause

`CameraManager`, `OcclusionRaycastService`, `PointerInteractionService` and the debug camera hotkey are plain `IUpdate`s. `UnityUpdater` skips that loop while the game is paused, so panning, occlusion and hover all freeze. Cinemachine itself keeps running, which is why the pause takes a camera hold to stop the orbit and zoom axes.

---

## Divergences

The GDD has no camera or controls page; [[Opciones de Interfaz]] lists dice and luck display options and no camera ones. Within the code and the vault:

- `UnityPauseEffects`' summary says pause silences gameplay input "all but Cancel, which resumes". `Pause` (Esc) is what resumes; `Cancel` stays enabled but does nothing while paused
- `PlayerInputGate`'s last release re-enables the whole `Gameplay` map without checking the pause, so a lock released while paused turns `Confirm`, `SkillSlot` and `SkipTurn` back on under the pause
- [[Party System]] says `CameraLeaderFollower` points the focus camera at the leader. It calls `SetTarget`, which in free view (the default) glides the free pivot instead
- `CameraTurnFocus` follows an enemy only while the party can see it, a rule [[Turn System]] leaves out
- The prefab's `PlayerInput` also sends `OnOrbitCamera` and `OnZoomCamera`, which nothing receives, and the generated `Inputs.Camera` map is never read

---

## Adding a New Input Action

1. Add the action and its bindings to the `Gameplay` map in `Inputs.inputactions`, with empty binding groups like its neighbours. Saving regenerates `Inputs.cs`; commit both
2. Declare a narrow contract in `Core/Input` with an event (`ISkipTurnInput` is the pattern)
3. Implement it on `GameplayInput`: subscribe to the action's `performed` (and `canceled` for a hold) in the constructor, unsubscribe in `Dispose`, and add the interface to its registration in `InputInstaller`
4. Write the Systems consumer as a plain class taking the contract by constructor. Gate it the way its neighbours do (`IPauseService.IsPaused`, `IHudVisibility.IsHidden`, `IActiveTurn.PlayerMayAct`), and register it eager
5. Decide its lock and pause behaviour. A player lock silences every `Gameplay` action except `Pause` with no extra work; pause silences only the three actions `UnityPauseEffects` lists, so add it there or check the pause in the consumer
6. Add a case to `GameplayInputTests`, and the key to the controls panel's string table entries in both languages if the player should see it

A camera action instead goes in the `Camera` map, received either by an `On<Action>` method on `CameraInput` or by a `CinemachineInputAxisController` entry on both `FocusCam` and `FreeCam`.

## Adding a Camera Follow Rule

1. Write an Engine class like `CameraTurnFocus`: take `ICameraManager` (and `ICameraController` to switch views), subscribe to the domain event, call `SetTarget(transform)` and, to lock on, `SetFree(false)`; unsubscribe in `Dispose`
2. Register it eager beside `CameraTurnFocus` in `SceneInstaller`
3. Test it with `FakeCameraController`, as `CameraTurnFocusTests` does

## Adding a Camera Effect

1. Implement `ICameraEffect` (`[Serializable]`, `Play(CameraManager)`). If it needs a Cinemachine extension, put the extension on both `FocusCam` and `FreeCam`
2. Add it to a `CameraEffectDefinition` asset with a unique `_id` (duplicates make `CameraEffectService.Create` throw), and add that asset to the `CameraEffectLibrary` on `SceneInstaller`
3. Reference the id from a skill cue's camera effect