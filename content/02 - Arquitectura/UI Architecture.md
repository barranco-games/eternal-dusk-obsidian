## Overview

The UI is UI Toolkit, split Model-View-Presenter across the layers ([[TDD#Inyección de dependencias y composición|TDD §2.4]]):

- **View** (Engine) — owns the visual elements. It finds them in the UXML tree it is bound to, raises plain C# events for what the player does, and draws what it is told.
- **Presenter** (Systems) — engine-free. It subscribes to view events and domain events, turns domain state into display values (localised strings included) and pushes them to the view through an interface.
- **Service** (`UIService`, Systems) — seeds the leader-scoped presenters when the HUD first binds and after every reload.

A `PanelRenderer` draws each screen, not a `UIDocument`. It hands its root element out only through a reload callback, which fires again whenever the tree is rebuilt (a UXML save in play mode). `UIManager` catches that callback and rebinds every view to the new tree, so the views must survive losing their elements at any time.

---

## Key Concepts

### Layered types

| Layer   | Types |
|---------|-------|
| Core    | `IUIManager` (`Core/UI`); `ILocalizedText`, `ILanguageService`, `LocKey`, `LocKeys`, `LocTables`, `LanguageCode` (`Core/Localization`) |
| Systems | the presenters and view interfaces, `IUIService`, `UIService`, `IPopup`, `IHudVisibility`, `DisplayNames`, the tooltip model (`Systems/UI`) |
| Engine  | the views, `IBindableUI`, `IActivatable`, `UIManager`, `IUIRootRegistry`, `UIRootRegistry`, `HudVisibility`, `FadeExtensions`, `TooltipHost` (`Engine/UI`); `UIInstaller`, `MenuInstaller` (`Engine/Composition`); `UnityLocalizedText`, `UnityLanguageService` (`Engine/Localization`); `UILifecycleStep` (`Engine/World/InitializationSteps`) |
| Assets  | `Assets/UI Toolkit`: `PanelSettings.asset`, `PanelSettingsWorldSpace.asset`, `VisualTreeAssets/*.uxml`, `Styles/style.uss`, `Text/PanelTextSettings.asset`, `Text/TooltipIcons.asset`, `UnityThemes/UnityDefaultRuntimeTheme.tss` |

Nothing under `Systems/UI` references `UnityEngine`. Engine data crosses the line boxed or as plain values: a tooltip's icon is an `object` the view casts to `Sprite`, and screen positions are `Vector2Data`.

### Views and view interfaces

A view interface is an engine-free contract with events for intent and setters for output:

```csharp
public interface ITurnView
{
    event Action WaitRequested;

    void SetVisible(bool visible);
    void SetWaitAvailable(bool available);
    void SetActionPointsSpent(bool spent);
}
```

The Engine view implements it and `IBindableUI`:

```csharp
public interface IBindableUI
{
    void Bind(VisualElement root);
    void Unbind();
}
```

- `Bind` finds the view's elements by name, `root.Q<T>("name") ?? throw new MissingReferenceException(...)`, hooks their callbacks, and redraws the last state it was given.
- `Unbind` unhooks and drops every cached element.
- Setters store the value and draw only while bound. A view therefore keeps its state across a reload and replays it on `Bind` (`TurnView`, `AmmoView`).

One view may serve several interfaces: `ActionPointsView` is the AP bar, the pending-cost preview and the poisoned-AP marker. Most views are MonoBehaviours on the `PanelRenderer` object, passed to the installer as `[SerializeField]` references. Views that build their own elements in code are plain classes: `TooltipHost`, `CursorInfoView`, `HudNoticeView`, `LeaderStatusEffectsView`, and the label layers `ItemLabelsView` and `BarkView`.

`IActivatable` (`Show`, `Hide`) is for a view that is shown once its root is bound. Only `MainMenuView` implements it.

### Presenters

Presenters are plain classes with constructor injection. A HUD presenter subscribes to its view and its domain events in the constructor, pushes the current state, and undoes every subscription in `Dispose`. Abridged from `TurnPresenter`'s constructor:

```csharp
_view.WaitRequested += OnWaitRequested;
_combat.OnAgentTurnStarted += OnTurnMoved;
_party.OnLeaderChanged += OnTurnMoved;
_gameMode.OnModeChanged += OnModeChanged;
_view.SetVisible(_gameMode.InCombat);
RefreshAvailability();
```

A presenter that shows the leader (`AmmoPresenter`, `LeaderResourcePresenter`, `ActionPointPoisonPresenter`, `LeaderStatusEffectsPresenter`, `SkillBarPresenter`) follows `IPartyService.OnLeaderChanged`: it unbinds from the old leader's resources and events and binds to the new one's. `Initialize(EntityId leaderId)` runs the same path for a given leader. It runs inside the party's event, so a missing leader must not throw and cut off the other listeners. A presenter that needs frame time also implements `IUpdate`.

The main-menu presenters (`MainMenuPresenter`, `SaveSlotsPresenter`) are registered as `IInitializable` instead and subscribe in `Initialize`, which `MenuInstaller` calls on every `IInitializable` once its container is built.

### The service

```csharp
public interface IUIService
{
    void Initialize(EntityId leaderId);
}
```

`UIService.Initialize` seeds, in order: the skill bar, the ammo counter, each `LeaderResourcePresenter` (AP and health), the leader's status icons and the poisoned AP, all for `leaderId`; then the party portraits, the initiative order and the action log. It coordinates no other presenter. The rest either subscribe at build and need no seed, or keep state their views replay on `Bind`.

### The root: PanelRenderer and UIManager

| Panel | Where | Tree | `PanelSettings` |
|-------|-------|------|-----------------|
| Level HUD | a `PanelRenderer` child of `SceneManager.prefab`, in every level scene | `Gameplay.uxml` | `PanelSettings.asset` (screen overlay) |
| Main menu | a scene object in `MainMenu.unity` | `MainMenu.uxml` | `PanelSettings.asset` |
| Enemy health bar | `AgentHealthbar.prefab` | `Elements/enemy-health-bar.uxml` | `PanelSettingsWorldSpace.asset` (world space) |

The screen asset scales with screen size from a 1920 × 1080 reference. Both assets share the theme and the text settings.

`UIManager` (Engine, a MonoBehaviour beside the renderer) finds its views through DI, not a scene search: `[Inject] IEnumerable<IBindableUI>` and `IEnumerable<IActivatable>`. Every view on its panel is registered as `IBindableUI` by its installer, and so are `HudVisibility`, `TooltipHost` and `AudioButtonBinder`, which also need the root. In `OnEnable` it registers `OnUIReload` with the renderer.

```
OnUIReload(renderer, root)
  ├─ UnbindAll: Unbind every view (each in its own try/catch), remove the old root from IUIRootRegistry
  ├─ add root to IUIRootRegistry
  ├─ Bind(root) every view       — one that throws is logged, the rest still bind
  ├─ Show() every IActivatable   — same
  ├─ IsInitialized = true
  ├─ Reloaded                    — before any waiter resumes
  └─ complete WaitForInitialization
```

```csharp
public interface IUIManager
{
    event Action Reloaded;   // after every view has bound to a fresh tree
    UniTask WaitForInitialization(TimeSpan timeout, CancellationToken ct);
}
```

`WaitForInitialization` returns at once when the root is bound. Otherwise it waits for the next reload, with a timeout, because the callback is render-driven and may never fire (a headless run, a disabled panel). The level reaches its `UIManager` through `ILevelContext.UIManager`.

`IUIRootRegistry.Roots` lists the bound root, so code can query the live tree: `UIToolkitPointerOverUIChecker` uses it to tell whether the pointer is over the UI, and the probes find skill buttons there by name. Only `UIManager` adds roots. The world-space health bar registers its own reload callback in `ActorHealthBarView`, is not an `IBindableUI` and is not in the registry, although the registry's doc comment says it tracks every active panel.

### Live reload

On a reload the renderer releases every element of the old tree and detaches it before calling `OnUIReload`. A released element throws on `Clear()`, `Add()` or a style write, so an `Unbind` that edits cached elements checks `element.resourcesReleased` first. `ActionLogView.Unbind` is the pattern. `RemoveFromHierarchy` is safe, which `TooltipHost.Unbind` relies on. The per-view try/catch means a view that still throws is named in the log and the rest of the HUD rebinds.

After the rebind the views show what they cached. The leader-scoped presenters are seeded again by `UILifecycleStep`, which listens to `Reloaded`.

### Starting the HUD

`UILifecycleStep` is a level lifecycle step ([[Level & Scene Loading#Lifecycle steps|Level & Scene Loading]]) listed after `PlayerSpawnStep` in every level:

- **Initialize** — `await context.UIManager.WaitForInitialization(30 s)`, then `IUIService.Initialize(IPartyService.LeaderId)`, then subscribe to `Reloaded` to seed again after every reload. A root that never arrives throws `TimeoutException` and fails the level load.
- **Shutdown** — unsubscribe.

The main menu has no level and no `UIService`. Its only `IActivatable`, `MainMenuView`, is shown by the bind, and its two presenters initialise once their container is built.

### Installers

`UIInstaller` (on `SceneManager.prefab`, in each level's scene container) registers the HUD. `MenuInstaller` (in `MainMenu.unity`) registers the menu's three views, `SettingsPresenter`, `MainMenuPresenter`, `SaveSlotsPresenter`, `AudioButtonBinder` and its own `UIRootRegistry`. The localisation services and `RunNavigation` are root singletons.

- A MonoBehaviour view: `RegisterValue(view, new[] { typeof(IXView), typeof(IBindableUI) })`
- A plain-class view: `RegisterType(typeof(XView), new[] { typeof(IXView), typeof(IBindableUI) }, Lifetime.Singleton, Resolution.Lazy)`, adding `IUpdate` if it ticks
- A presenter is eager when it must hear domain events before anything asks for it (dialogue, turn, pause, settings, tutorial, end game, damage numbers, the world-space health bar, barks, item labels, controls, cursor info, the AP cost preview, the move and pickup refusal notices, and `GameTermsGlossary`), lazy otherwise. `UIService` resolves the lazy leader-scoped ones
- `LeaderResourcePresenter` is registered twice, once over `ActionPoints` and once over `Health`, so `UIService` takes an `IEnumerable<LeaderResourcePresenter>`

The installer also clears the caches of `_portraitCatalog` and `_statusEffectIconCatalog`: entering play without a domain reload would keep last session's.

### HUD presenters

All in `Systems/UI`, registered by `UIInstaller`:

| Presenter | Shows |
|-----------|-------|
| `SkillBarPresenter` | the leader's skill bar: icons, cooldowns, uses, availability, the selected skill |
| `LeaderResourcePresenter` (×2) | the leader's AP bar and health bar, redrawn when the max moves |
| `ActionPointCostPresenter` | the AP the hovered skill or previewed move would spend |
| `ActionPointPoisonPresenter` | the leader's AP held back by poison |
| `AmmoPresenter` | rounds in the main ranged weapon's magazine and the reserve ([[Equipment System#The main item\|Equipment System]]) |
| `LeaderStatusEffectsPresenter` | status icons over the leader's health bar ([[Status Effects System]]) |
| `PartyPresenter` | party portraits: health, passed, statuses; a click sets the leader ([[Party System]]) |
| `TurnPresenter` | the end-turn button: shown in combat, available while the player may act |
| `InitiativeOrderPresenter` | the combat turn queue |
| `CombatBannerPresenter` | the combat-start banner, as an `ICombatIntro` ([[Turn System#Entering combat\|Turn System]]) |
| `ActionLogPresenter` | the newest actions, one line each, from `ActionLedger` |
| `CursorInfoPresenter` | the pointer readout: hit chance while aiming, else the move's distance and AP, or why it is refused |
| `DamageNumbersPresenter` | floating damage, healing, misses and attribute checks over visible actors |
| `MoveRefusalPresenter`, `PickUpRefusalPresenter`, `SkillRefusalPresenter` | a one-line notice above the AP bar explaining a refused click |
| `DialoguePresenter` | the conversation panel: lines, typewriter reveal, choices, skip ([[Action System#8. DialogueService\|Action System]]) |
| `PausePresenter`, `SettingsPresenter` | the pause panel and the settings panel inside it |
| `TutorialPresenter` | one-time tutorial popups (an `IPopup` that holds player input while shown) |
| `ControlsPresenter` | the controls panel, collapsed after 5 s of continuous visible HUD once the player has had control |
| `EndGamePresenter` | the victory and defeat panels (`IEndGameScreen`) |
| `ActorHealthBarPresenter` | the world-space health bar over the hovered agent outside the party |
| `BarkPresenter`, `ItemLabelsPresenter` | barks over their speaker; item names while the reveal key is held |

### HUD visibility

```csharp
public interface IHudVisibility
{
    bool IsHidden { get; }
    IDisposable Hide();
}
```

A counted hold on the `hud-root` element of `Gameplay.uxml`: the HUD stays hidden while any handle is alive, and the count survives a reload. `HudVisibility` also suppresses the world-space health bar. An input lock holds the HUD hidden (`PlayerInputGate`, so a tutorial hides it), and so does an end screen. Dialogue, tutorials, pause and the end panels are siblings of `hud-root`, so they stay up while it is hidden. The layers made in code (labels, cursor info, notices, damage numbers) add themselves inside `hud-root` and hide with it.

`FadeExtensions` gives `FadeIn` (800 ms) and `FadeOut` (500 ms) on panel time, so they play while the game is paused, plus helpers that swap USS classes and collapse an element once its transition ends.

### Tooltips

The content is engine-free (`Systems/UI/Tooltips`):

- `TooltipContent` — a title, an optional icon, a description line and entry rows
- `TooltipLine` — a run of `TooltipSpan`s. `Format` fills `{0}` placeholders with spans, so a game term stays its own run
- `TooltipSpan` — text plus an optional `TooltipLinkId` or a nested panel, which opens a second tooltip when hovered
- `TooltipTerms` marks known terms in prose. `GameTermsGlossary` (eager) registers AP, ammunition, every status and every attribute, builds their panels, and rebuilds them on every language change
- `SkillTooltipFactory` and `HealthTooltipFactory` build content per hover, so it always shows current values. `RollTooltipFactory` is a helper `SkillEffectRows` creates for a skill's roll rows

`TooltipHost` (Engine) draws them on its own full-screen layer. `ITooltipHost.Attach(anchor, content)` shows a panel above the anchor after 150 ms of hover, opens a linked term's panel beside its parent, and closes a stack 120 ms after the pointer leaves it. Each word is its own label, so only a linked word takes the pointer.

Icons inside text are rich-text sprite tags (`<sprite name="Fire">`, built by `TooltipText`) from `TooltipIcons.asset`, the default sprite asset of `PanelTextSettings.asset`. A `*Small` glyph reuses an icon's rect at another scale. The `ui` skill lists the engine's traps with these.

### Localization

Unity Localization with two string table collections and two locales, `en` and `es` (`Assets/Localization`):

| Table (`LocTables`) | Holds |
|---------------------|-------|
| `UI` | the text the code writes: menus, HUD labels, notices, the action log, tutorials, tooltip bodies |
| `Content` | names and descriptions of authored assets, keyed by pattern on the lower-cased id: `skill.<id>.name`, `item.<id>.description`, `actor.<prefabId>.name` |

Code never touches the Unity API. It goes through two Core interfaces, implemented in Engine and registered at the root:

```csharp
public interface ILocalizedText
{
    string Get(LocKey key);
    string Format(LocKey key, object arg0);   // overloads up to arg4
}

public interface ILanguageService
{
    LanguageCode Current { get; }
    IReadOnlyList<LanguageCode> Available { get; }
    event Action LanguageChanged;
    void SetLanguage(LanguageCode language);
}
```

- Fixed keys are `static readonly LocKey` fields in `LocKeys`, so a renamed key fails the build instead of rendering blank. Keys derived from an id (`LocKeys.Names.*`, `LocKeys.Content.*`, `LocKeys.Terms.StatusBody` / `AttributeBody`) are built at runtime: renaming a skill, item or prefab id moves its key, and the table entry has to move with it.
- `UnityLocalizedText` keeps one argument array per arity, so a call adds no array allocation; the returned string and any boxed argument still allocate. A missing key logs once and renders the key's entry name. While the language is still loading, every key renders empty.
- `UnityLanguageService` loads during `GameStartup`. It restores the language saved in `PlayerPrefs` and preloads both tables. At startup and on every change it also sets Articy's language, since dialogue text lives in Articy, not in these tables, but only when Articy has a language pack with the same culture name; otherwise dialogue stays as authored and a warning is logged. `LanguageChanged` fires once the new language answers.
- Views set their labels in `Bind` and again on `LanguageChanged`. Presenters localise in Systems and pass finished strings, and those that cache text (the action log, the notices) rebuild it on `LanguageChanged`. The settings panel's language button cycles `Available`.

Not localised: the `x` before the reserve count, the `+` on healing numbers, the save slot's date and play time formats, and the `D` in dice notation. The UXML still carries English placeholder text, which the views overwrite on `Bind`.

### UXML and USS

`Gameplay.uxml` is the HUD root. It instances templates from `VisualTreeAssets` and `Elements` / `Interactables` (19 `skill-btn`, 10 `ap-point`, the panels). The settings panel is nested in the pause panel. `MainMenu.uxml` instances the buttons and the settings and save-slot panels. `Styles/style.uss` is the only stylesheet and holds the state classes (`.skill--selected`, `.ap-pending`, `.tooltip*`). Layout lives mostly in inline UXML styles. The theme only imports Unity's default runtime theme.

Element names are the contract between UXML and views. `SkillBarView` renames each bound `skill-btn` to `skill-<id>`, which is how tests and probes find a skill's button.

Read sizes from `layout` on the element's first `GeometryChangedEvent`, never from `style`, which only returns values written from C# (`InitiativeOrderView.OnProbeLaidOut`).

### Editor fixes

- `PanelTextSettingsRebinder` re-assigns a `defaultSpriteAsset` that a recompile leaves dead (after a reload and again on entering play), which would print sprite tags as literal text
- `PanelSettingsThemeReloader` reimports the theme sheets and the `PanelSettings` after every domain reload in edit mode (not the one that enters play), since a lost theme leaves the root zero pixels high

---

## Divergence from the GDD

[[Opciones de Interfaz]] lists player options the settings panel does not have:

| Topic          | GDD | Code |
|----------------|-----|------|
| Dice display   | show all rolls, only hit rolls, only damage rolls, or none | no option. `DamageNumbersPresenter` shows damage, misses and attribute checks; the hit roll itself is not shown ([[Combat & Dice]]) |
| Luck popup     | four options: always show it, show it only below a Luck cost the player sets, never show it and always spend a set amount, or never show it | no Luck stat and no Push Luck reaction, so no popup |
| Settings that exist | not listed | volume, camera rotation speed, vsync, fullscreen, frame rate, language |

The GDD's inventory and journal screens ([[Inventario]], [[Diario]]) are not built. `Gameplay.uxml` carries hidden `journal-btn`, `inventory-btn` and `stances-btn` buttons that no code binds, and an unused `enemy-health-bar` instance inside `hud-root` (the live bar comes from `AgentHealthbar.prefab`).

---

## Adding a New HUD Element

1. In Systems, add the view interface (`I<Name>View`: events for intent, setters for output) and a presenter that subscribes in its constructor and unsubscribes in `Dispose`. Localise there through `ILocalizedText`, with new keys in `LocKeys` and entries in the `UI` table for both locales
2. In Engine, add the view implementing the interface and `IBindableUI`. Find elements in `Bind`, cache the last state and redraw it there, and drop everything in `Unbind`, checking `resourcesReleased` before editing a cached element
3. Add the elements to `Gameplay.uxml` (inside `hud-root` if it should hide with the HUD), or build them in code in `Bind`
4. Register both in `UIInstaller`: the view as `IXView` and `IBindableUI`, the presenter eager if it must hear events before anything resolves it. A leader-scoped presenter gets an `Initialize(EntityId)` and a call in `UIService.Initialize`
5. Save the UXML in play mode to force a reload and check that the element comes back with its state
