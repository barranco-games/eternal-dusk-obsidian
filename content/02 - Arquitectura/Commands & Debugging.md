## Overview

A command is one line of text that does one thing to the running game: `resource:colt:hp:=5`, `camera:boss`, `move:lorenzo:4:2:forced`. The same small language serves two very different readers:

- **Authored content** — Articy dialogue lines and barks carry commands in their stage directions, so a line can move an actor, swap a portrait expression or play a sound as it appears. These run in every build, release included
- **Debugging** — the debug console, the scenario harness and the player-build perf driver run command scripts against the live game. These exist only in the editor and in development builds

`CommandFactory` (Systems) parses text into `ICommand`s, `CommandExecutor` runs them against an `ICommandContext`, and the context decides what each command can reach. Player actions are not commands, and encounter phases never run as commands. A command can still call into those services (`move`, `skill`, `encounter`) to drive them from a script ([[Action System]], [[Encounter System]]).

The debug triggers themselves (F9, F10, the console, the perf launch arguments) are listed for playtesting in the game repo's `.claude/DEBUG.md`; this page covers how they are built.

---

## Key Concepts

### Layered types

| Layer   | Types |
|---------|-------|
| Core    | `ICommand`, `ICommandContext`, `ICommandOutput`, `CommandContextExtensions` (`Core/Commands`); `IAssertionSink`, `AssertionReport`, `AssertionResult` (`Core/Testing`) |
| Systems | `CommandFactory`, `CommandInfo`, `CommandCatalog`, `StageDirectionCommands`, `CommandContext`, `CommandExecutor`, `CommandArgs`, `HelpCommand`, and one `*Command` plus `*CommandBuilder` per verb, except `help`, `expression` and `lab`, which register an inline lambda (`Systems/Commands/**`); `DebugConsole`, `FlyCameraController`, `SkillLab` (`Systems/Debugging`) |
| Engine  | `AudioCommand`, `AudioCommandBuilder` (`Engine/Unity/Audio`, the only commands outside Systems); `CombatDebugHotkey`, `DebugCameraHotkey` (`Engine/Unity/Input`); the scenario harness and build drivers (`Engine/Testing`) |

| Registration | Where | Lifetime |
|--------------|-------|----------|
| `CommandFactory` (the shared, root one) | `RootInstaller` | singleton, lazy; `OnContainerBuilt` fills it with the stage-direction verbs and `audio` |
| `CommandContext` as `ICommandContext`, `CommandExecutor` | `SceneInstaller` | singleton, lazy; `OnContainerBuilt` adds the context's capabilities |
| `DebugConsole` | `SceneInstaller.InstallDebugBindings` | singleton, lazy, only when `Debug.isDebugBuild` |
| `FlyCameraController`, `DebugCameraHotkey` | `InputInstaller.InstallDebugBindings` | only when `Debug.isDebugBuild` |
| `CombatDebugHotkey` | `TurnInstaller` | eager `IUpdate`, only when `Debug.isDebugBuild` |

`Debug.isDebugBuild` is true in the editor and in development players, so a release build has no console and no hotkeys, while every stage-direction verb stays live.

### A command

```csharp
public interface ICommand
{
    string Id { get; }
    void Execute(ICommandContext context);
}
```

`Id` is the verb, used only in log and error text. `Execute` is synchronous. A command whose work takes time (a walk, a save, an AI plan, a prefab load) starts it fire-and-forget and returns at once, so the next command in the batch runs before it finishes. Such commands answer at once with a line saying the work is under way (`move` says "requested", `save` "writing ...") and put the real outcome in the Unity log.

### The context is a capability bag

```csharp
public interface ICommandContext
{
    bool TryGet<T>(out T capability) where T : class;
}

public static void Report(this ICommandContext context, string message);   // CommandContextExtensions
```

A command asks the context for each service it needs. `CommandContext` keeps them in a dictionary keyed by **exact type**: `With<IFoo>(x)` is found by `TryGet<IFoo>`, never by `TryGet<Foo>`. `With` ignores null, so an unresolved service simply leaves its capability out. A missing capability is not an exception: the command usually reports `"[verb] no T capability."` through `Report` and returns. `Report` writes to `ICommandOutput` when the context has one and to `Log.Warn` otherwise. The commands that print results (`help`, `list`, `party`, `save`, `load`, `newgame`, `dialogue`, `encounter`) need `ICommandOutput` and only log a warning without it, and `expression` always only logs.

Three contexts are built, and they do not offer the same things:

| Context | Built by | Capabilities |
|---------|----------|--------------|
| Game (stage directions and barks) | `SceneInstaller` | `IEntitySource` and the scene's `TurnCounter` (constructor-injected), `IPortraitExpressionState`, `ICameraController`, `IEntityFactory`, `IWalkableGround`, `IPartyService`, `ICameraShotService`, `MovementService`, `IStatusEffectLibrary`. No output, so reports go to the log |
| Debug console | `DebugConsole` | `IEntitySource`, `IAssertionSink` (its own `AssertionReport`), `TurnCounter`, `SkillService`, `MovementService`, `ICameraController`, `ILanguageService`, `IGameModeService`, `CombatEncounterStarter`, `IPartyService`, `IGameStateService`, `IEncounterService`, `ICombatTurnOrder`, `CombatGovernor`, `IConversation`, `IInteractionPipeline`, `ITurnPlanSource`, `AutoAreaTargetDriver`, `ITurnService`, `IEntityFactory`, `IStatusEffectLibrary`, `IWalkableGround`, `ISceneLoader`, and an `ICommandOutput` buffer |
| Scenario | `ScenarioRun.Run` | `IEntitySource`, `IAssertionSink` (an `AssertionReport`), a fresh `TurnCounter`, and `SkillService` under the boot runner only |

Two gaps follow. The console has no `ICameraShotService` and no `IPortraitExpressionState`: `camera:shot` resolves there but answers with a missing capability, and `expression` answers `ok` while a warning goes to the Unity log. And a scenario script can name any catalog verb, but anything beyond resources, statuses, the turn clock and skills reports a missing capability, which a scenario does not count as a failure.

### The text syntax

```csharp
public IReadOnlyList<ICommand> BuildFrom(string stageDirections, ICollection<string> skipped = null);
```

`CommandFactory.BuildFrom` reads its input one line at a time:

- Lines split on `\n`, each is trimmed. Blank lines and lines starting with `#` are skipped. There is one command per line and no other separator
- A line splits on `:`. The first part is the verb, the rest are the arguments, each trimmed. There is no quoting or escaping, so an argument can never contain a colon (`load` rejoins its arguments with `:` to rebuild a slot id)
- Verb lookup is case-sensitive (`List` is unknown). Sub-verbs inside a builder (`camera:free`, `turn:advance`) compare case-insensitively through `CommandArgs.Is`
- An unknown verb logs an error and is dropped. A builder that rejects its arguments returns `null`, after logging why with `Log.Warn` (`expression` logs nothing), and is dropped too. Either way the rest of the batch still builds. When `skipped` is passed, it gets one note per dropped line (`skipped '<line>': bad arguments, the log says why. usage: ...`)
- A builder that throws is not caught here

Every line in a batch is built before any of them runs. Builders only parse, so no command sees state another command in the same batch has not changed yet.

### Two factories, layered

```csharp
public static CommandFactory Over(CommandFactory fallback);
public void Register(string id, Builder builder, string usage = null);
public void Unregister(string id);
public IReadOnlyList<CommandInfo> Registered { get; }   // own and inherited, sorted by id
public delegate ICommand Builder(IReadOnlyList<string> args);
```

`Over` makes a child factory that builds its own verbs first and falls back to the parent's, without ever adding to the parent. The game uses that to keep debug verbs out of authored content:

```
root CommandFactory            ← StageDirectionCommands: resource, camera, spawn, move, expression
  (RootInstaller)              ← AudioCommandBuilder: audio
      │  used by DialogueSource and ArticyBarks to build stage directions
      ▼
DebugConsole's factory         ← CommandCatalog.RegisterAll: the 21 catalog verbs
  = CommandFactory.Over(root)  ← SkillLabRunner: lab (SkillLab scene only)
```

So the console can run everything, while a stage direction can use only the six root verbs: a `help` or `save` in Articy is an unknown verb. The root registers its verbs with no usage line except `expression`, `move` and `audio`; the console's `help` text for `resource`, `camera` and `spawn` comes from the catalog on its own factory.

### The catalog

`CommandCatalog.RegisterAll` registers 21 verbs with one usage line each. It is the list both the console and the scenario harness start from.

| Verb | Does |
|------|------|
| `help[:<filter>]` | every registered verb with its usage |
| `list[:<filter>]` | every entity: id, type, position, health and AP |
| `camera[:...]` | read or drive the camera: `free`, `focus`, `toggle`, `debug`, an entity, a point, `pose:<x>:<y>:<z>:<pitch>:<yaw>`, and the undocumented `shot:<entity>[:<sec>]`, `shot:pose:...` and `shot:release[:<sec>]` ([[Camera & Input]]) |
| `move:<agent>:<x>[:<y>]:<z>[:forced]` | walk through `MovementService`; `forced` uses `MovementIntent.Forced` from `ActivitySource.Cinematic` |
| `spawn:<prefab>:<x>[:<y>]:<z>[:<id>]` | create a registered prefab; without a y it snaps to walkable ground within 50 m |
| `ai:plan:<agent>`, `ai:why:<agent>` | dry-run an AI turn without executing it ([[Enemy AI]]) |
| `mode[:combat\|exploration\|toggle]` | read or flip the game mode; `combat` goes through `CombatEncounterStarter.StartEncounter` |
| `encounter[:start\|order\|end\|skip\|remove...]` | read or drive the running encounter ([[Encounter System]]) |
| `lang[:next\|<code>]` | read or switch the language |
| `party[:<entity>\|leader\|add\|remove...]` | read or edit the party ([[Party System]]) |
| `save[:list]`, `load:<slot>`, `newgame:<scene>` | the save flow ([[Save & Load System]], [[Level & Scene Loading]]) |
| `resource:<target>:<type>:<value>` | `5` adds, `=5` sets, `max` fills; types `hp`, `ap`, `sanity` or any `ResourceType` name |
| `assert:<target>:<type>:<expected>` | assert a resource; also takes `>`, `>=`, `<`, `<=`, `empty` and `full`, which the usage line leaves out |
| `status:<target>:<type>:<turns\|permanent\|clear>`, `assertstatus:...:<present\|absent>` | apply or assert a status ([[Status Effects System]]) |
| `turn:advance[:<count>]`, `assertturn:<expected>` | advance or assert the turn clock |
| `skill:<caster>:<skillId>[:<target>...]` | cast through `SkillService` from `ActivitySource.Cinematic` |
| `dialogue[:talk\|next\|choose:<n>\|stop]` | read or drive the open conversation, one step per call ([[Dialogue System]]) |

`HelpCommandTests` requires every catalog usage line to contain `" - "`. Nothing pins the list or its count.

### Running commands

```csharp
public sealed class CommandExecutor
{
    public CommandExecutor(ICommandContext context);
    public void Execute(IReadOnlyList<ICommand> commands);
}
```

`Execute` runs the batch in order on one shared context. Each command runs inside a `try`/`catch`: a throw is logged as an error, recorded as a failed assertion when the context has an `IAssertionSink`, otherwise written to its `ICommandOutput`, and the batch carries on. The console has both, so a throw there shows as a `FAIL [id] threw: ...` line and counts against its assertions.

The scene's `CommandExecutor` serves stage directions and barks. The console and each scenario build their own over their own context.

### Where commands come from

| Source | Built | Run |
|--------|-------|-----|
| Dialogue lines | `ArticyLineFactory` builds `NarrativeLine.Commands` from the fragment's stage directions (`IObjectWithStageDirections`) whenever `DialogueSource` emits a line | `DialoguePresenter.OnLineReady`, before the line renders or starts its reveal, and also while skipping. A line rebuilt for a language change does not run them again |
| Barks | `ArticyBarks` builds the line the same way | `BarkPresenter.OnBarked`, just before the bubble shows. A bark whose speaker is not in the world, or whose text is empty, is dropped and its commands do not run |
| Debug console | `DebugConsole.Execute(string)` | at once, synchronously |
| Scenarios | `ScenarioRun.Run` | at once, the whole script |
| Perf build driver | any `-perfscript` line that is not a driver step goes to `DebugConsole.Execute` | in script order |
| SkillLab scene | `SkillLabRunner` adds `lab` to the console's factory | through the console |

Commands run when a line appears, not when the player advances past it. Neither dialogue source passes a `skipped` collection, so a bad stage direction only shows in the Unity log. The [[Dialogue System]] page covers the line pipeline around them.

### The debug console

`DebugConsole` has no in-game UI: no key opens it, and it has no text field, history or autocomplete. It is an API. The editor CLI resolves it from the scene container and calls `Execute`, which is how agents drive a playtest:

```csharp
public IAssertionSink Assertions { get; }   // every assertion this session
public CommandFactory Commands { get; }     // the console's own factory
public string Execute(string input);
```

`Execute` builds every line (noting skipped ones), runs the batch, then appends the assertions this call added as `PASS ...` / `FAIL ...` lines. It always returns something: the output, `ok` when commands ran silently, or `no command run — empty input`.

Output only reaches the return value while `Execute` is running. A command that reports after an `await` writes into a buffer the next call clears, so the long-running commands log their outcome with `Log.*` instead. `spawn` is the exception: it reports after `IEntityFactory.CreateNew` awaits the prefab load, so its confirmation line is lost unless the load completes synchronously.

### Debug hotkeys

| Key | Class | Does |
|-----|-------|------|
| F9 | `CombatDebugHotkey` | out of combat, `CombatEncounterStarter.StartEncounter()` (every standing actor joins); in combat, `IGameModeService.EnterExploration()`. A fight started this way has no encounter phase list ([[Encounter System]]) |
| F10 | `DebugCameraHotkey` → `FlyCameraController` | toggle the free-flying camera: WASD moves, Q/E lower and raise, right-drag looks (0.15 sensitivity), shift boosts ×4 over 12 m/s, pitch clamped to ±89° |

Both poll `Keyboard.current` directly rather than going through the Input System actions ([[Camera & Input]]), and both are registered only when `Debug.isDebugBuild`. `FlyCameraController` holds no pose: it moves `ICameraController`'s debug camera, which runs at priority 100 over the gameplay rig.

### The scenario harness

A scenario is a `.txt` command script in `Assets/Scenes/Test/Scenarios/` (five today: `resources_basic`, `resources_clamp`, `resources_compare`, `status_basic`, `turn_basic`). They act on the entity `scenario-actor` and check results only through the assert verbs.

```csharp
public AssertionReport Run(string scenarioName, string script, IEntitySource entities, CommandFactory factory, SkillService skills = null);
```

`ScenarioRun.Run` builds and runs one script. A skipped line, a throwing builder or a throwing command each count as a failed assertion, and a run with no results fails. Two MonoBehaviour runners drive it, each in its own test scene:

| Runner | Scene | Against |
|--------|-------|---------|
| `ScenarioRunner` | `TestRunner.unity` | a fresh in-memory `ScenarioTestActor` (100 health, 10 AP, 100 sanity) per script, no boot |
| `ScenarioBootRunner` | `ScenarioBoot.unity` | a real new game: it waits up to 10 s for a party leader, maps `scenario-actor` onto it, and passes `SkillService` |

Both show a pass/fail overlay, and a headless batch-mode player exits with code 1 on failure. No menu item or CI script opens these scenes. The gates are tests: `ScenarioHarnessTests` (EditMode) runs every script against the deterministic actor and checks that both scenes list every script, and `SceneBootTests` (PlayMode) boots `ScenarioBoot`. The skill script tests (`ColtSkillScriptTests` and the like) use the same text → factory → executor pipeline against the real `SkillService`.

### Build drivers

`PerfBuildDriver` (`-perfscript <file> -perfout <dir>`, optionally `-perfcap <fps>`) plays a script in a development player, writing profiler segments of up to 1800 frames. It understands its own steps (`seg`, `wait`, `newgame`, `click`, `shot`, `quit` and others) and passes any other line to the console, so its own `newgame` step shadows the console verb. `SmokeBuildDriver` (`-smoke`) starts a new game and passes once the leader spawns and 5 s go by with no exception logged, else it quits with code 1; it runs no commands ([[Level & Scene Loading#Debugging|Level & Scene Loading]]). Both files compile only under `UNITY_EDITOR || DEVELOPMENT_BUILD` (the smoke driver also under `ETERNALDUSK_SMOKE`).

---

## Divergences

No GDD page describes commands or debug tools.

- [[Quest System]] describes `CommandExecutor` calling a `QuestEvaluator` after every command, with player actions as `ICommand`s. None of that exists: no `QuestEvaluator` type, no hook in `CommandExecutor`, and commands carry only stage directions and debugging
- `.claude/DEBUG.md` says `FlyCameraController` is always registered and only the F10 key is gated, by `UNITY_EDITOR || DEVELOPMENT_BUILD`. In code both are gated by `Debug.isDebugBuild` (pinned by `InputInstallerTests`). It also says the console's commands all come from `CommandCatalog`, when `audio`, `expression` and `lab` do not, and it omits `camera:shot`
- `party:add`, `party:remove` or `party:leader` with no id is read as an entity named `add` (or `remove`, `leader`), since a lone argument is an entity id

---

## Adding a New Command

1. Write `Systems/Commands/<Area>/<Name>Command.cs`: a `sealed` `ICommand` whose `Execute` gets each service with `context.TryGet<T>`, and on a miss calls `context.Report("[verb] no T capability.")` and returns. For slow work, start it with `.Forget()` and log the outcome rather than `Report` it after an `await`
2. Write a static `<Name>CommandBuilder.Build(IReadOnlyList<string> args)` that returns the command, or logs its usage with `Log.Warn` and returns `null` on bad arguments. Use `CommandArgs.Is` for sub-verbs and `CommandArgs.TryParseFloat` for numbers (invariant culture)
3. Register it in `CommandCatalog.RegisterAll` with a usage line containing `" - "`. That makes it reachable from the console, `help` and scenarios
4. If it needs a service no context offers, add it: the console takes an optional constructor parameter plus a `.With(...)`; the game context gets a `.With(container.Resolve<T>())` in `SceneInstaller.OnContainerBuilt`
5. Add `<Name>CommandTests` and `<Name>CommandBuilderTests` under `Tests/EditMode/Systems/Commands/`, and the line to `.claude/DEBUG.md`

## Adding a Stage-Direction Command

1. Build the command as above
2. Register it in `StageDirectionCommands.Register` (the root factory), and add a case to `StageDirectionCommandsTests`. A command needing Engine services registers from `RootInstaller.OnContainerBuilt` instead, as `AudioCommandBuilder` does
3. Give the game context any capability it needs, in `SceneInstaller.OnContainerBuilt`
4. In Articy, write it one per line in the fragment's stage directions. Remember it runs as the line appears, in release builds too