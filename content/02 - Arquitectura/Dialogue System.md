## Overview

Dialogue is authored in Articy:draft and played by Articy's own `ArticyFlowPlayer`, which ticks itself outside every loop the rest of the game runs on. The game wraps it in one adapter, `DialogueSource`, that turns flow-player callbacks into engine-free `NarrativeLine`s, and everything past that adapter (the conversation's lifetime, its presentation, the commands a line carries) is plain C#. Articy types stop at Engine: inner layers see only `IConversation`, `NarrativeLine` and `Choice` (`Core/Narrative`).

This page covers the Articy side and the presentation: how entities link to Articy, how a flow node becomes a line, speakers and portraits, stage directions, the typewriter reveal, barks, script methods, global variables and localization. The conversation as an activity (locks, refusals, the ledger record) is [[Action System#8. DialogueService|Action System §8]], the click that opens one is [[Action System#DialogueInteractionHandler|§9]], and the `IConversation` contract with its emission cadence is [[Action System#10. Narrative Source|§10]].

---

## Key Concepts

### Layered types

| Layer   | Types |
|---------|-------|
| Core    | `IConversation`, `NarrativeLine`, `Choice`, `IBarks` (`Core/Narrative`); `DialogueResult` (`Core/Actions/Dialogue`) |
| Gameplay | `IDialogueItem` (`Gameplay/World`); `ConversedPayload` |
| Systems | `DialogueService`, `DialogueInputLock` (`Systems/Actions/Dialogue`); `DialoguePresenter`, `IDialogueView`, `DialogueRevealSettings`, `DialogueMarkup`, `IPortraitExpressionState`, `PortraitExpressionState` (`Systems/UI/Dialogue`); `BarkPresenter`, `IBarkView` (`Systems/UI/WorldSpace`); `ConversationWalkHold` (`Systems/Actions/Movement`) |
| Engine  | `DialogueSource`, `ArticyLineFactory`, `ISpeakerResolver`, `ArticySpeakerResolver`, `IConversationResolver`, `EntityConversationResolver`, `IArticyLinked`, `IConversationOwner`, `EntityNames`, `ArticyNames`, `ArticyBarks`, `DialogueScriptMethods`, `DialogueInteractionHandler` (`Engine/Narrative`); `Entity.Articy.cs`; `DialogueView`, `PortraitCatalogSO` (`Engine/UI/Dialogue`); `BarkView`; `DialoguePhase`, `ExplorationPhase` (`Engine/Encounters/Phases`); `ArticyGlobalsSavable` (`Engine/Persistence`); `UnityLanguageService` (`Engine/Localization`) |

| Registration | Where | How |
|--------------|-------|-----|
| `DialogueSource` as `IConversation` | `SceneInstaller` | `RegisterValue`: it is a component on `SceneManager.prefab`, beside its `ArticyFlowPlayer` |
| `ArticySpeakerResolver`, `ArticyBarks`, `EntityConversationResolver`, `DialogueInteractionHandler`, `DialogueService`, `PortraitExpressionState` | `SceneInstaller` | singletons, lazy |
| `DialogueInputLock` | `SceneInstaller` | singleton, eager |
| `DialoguePresenter`, `BarkPresenter` | `UIInstaller` | singletons, eager: nothing resolves them, but they must listen from the first line |
| `DialogueView`, `DialogueRevealSettings`, `PortraitCatalogSO` | `UIInstaller` | values |
| `ArticyGlobalsSavable` | `RootInstaller.OnContainerBuilt` | registered into the save registry |
| `DialogueScriptMethods` | not registered | a component on `SceneManager.prefab` that claims Articy's global method provider |

### The chain

```
DialoguePhase / NPC click / item pickup
  → DialogueService.PlayScripted | StartDialogue       Systems  — locks, lifetime, ledger (Action System §8)
  → IConversation.StartOn(start, owner)                Core
  → DialogueSource                                     Engine   — ArticyFlowPlayer callbacks in
       ArticyLineFactory.Create → NarrativeLine            text, speaker, stage-direction commands
       BuildChoices → line.Choices                         only when Articy offers more than one branch
  → LineReady / Finished
  → DialoguePresenter                                  Systems  — runs the commands, reveals, routes choices
  → DialogueView                                       Engine   — UI Toolkit panel and portraits
```

Barks take a shorter parallel path: `ExplorationPhase` → `IBarks.Say` → `ArticyBarks` → `BarkPresenter` → `BarkView`.

### Linking entities to Articy

`Entity<TState>` is `partial`, and `Entity.Articy.cs` gives every entity three serialized fields, in a "Dialogue" box:

```csharp
public ArticyObject ArticyObject => _articy.GetObject();      // IArticyLinked: which Articy entity this is
public IArticyObject Conversation => _dialogue.GetObject();   // IConversationOwner: what talking to it starts
public float TalkRange => _talkRange;                         // IConversationOwner: 0 means the 2.5 m default
```

`_articy` is the entity's identity as a speaker, and it is shared by every instance of a prefab. `_dialogue` is the conversation a click starts. `EntityConversationResolver` returns it for any `IConversationOwner` except an `IDialogueItem`: an item's conversation is played by the pickup, before taking it or 0.3 s after when `DialogueAfterPickup` is set ([[Action System#ItemPickupService|Action System §9]]).

An entity with no `_articy` has a null `ArticyObject`, so `EntityNames.TechnicalName` returns null and its profile icon in the party and initiative HUD is missing. It also cannot be matched as a speaker, so its lines carry no `EntityId` and show the Articy name.

### Starting a conversation

| Route | Calls | Owner |
|-------|-------|-------|
| Clicking an NPC | `DialogueInteractionHandler` walks the leader to 80% of the talk range if needed, then `DialogueService.StartDialogue` | the NPC |
| An item with a conversation | `ItemPickupService` → `StartDialogue` with no owner | none |
| An encounter beat | `DialoguePhase` → `DialogueService.PlayScripted` with its `ArticyRef` | none |
| Debugging | `dialogue:talk:<entity>` dispatches a click through the interaction pipeline ([[Commands & Debugging]]) | as a click |

`StartDialogue` refuses during combat; `PlayScripted` does not, so a victory or defeat conversation can play while the fight is closing. A `DialoguePhase` whose reference is unset or not in the Articy database logs an error and completes without playing ([[Encounter System#Shipped phases|Encounter System]]).

Combat results reach dialogue only through the encounter. `CombatPhase` runs its `OnVictory` or `OnDefeat` phase list, and a `DialoguePhase` there enters the winning or losing conversation at its own first line. No Articy variable carries the result.

### From flow node to line

`StartOn` hands the flow player its start node, and the player walks into the first line by itself, which is why nothing advances after `StartOn` ([[Action System#Emission cadence|Action System §10]]). Each time Articy pauses on a node with branches, `DialogueSource` builds the line:

```csharp
public static NarrativeLine Create(IFlowObject obj, CommandFactory commands, ISpeakerResolver speakers,
    EntityId intendedSpeaker = default);
```

`ArticyLineFactory.Create` takes, in order:

1. **Text** from `IObjectWithLocalizableText` (Articy's current language), else `IObjectWithText`
2. **Speaker** through `ISpeakerResolver.TryResolve`, passing the conversation's owner as the intended speaker
3. **Commands** from `IObjectWithStageDirections`, through `CommandFactory.BuildFrom` (see Stage directions below)

Choices appear only when Articy reports more than one branch; a single branch is a plain advance, so a "missing" choice usually means its other branches evaluated false. Each valid branch becomes a `Choice` labelled with its target's menu text, else its text, else `>>>`. The view has three choice buttons: a fourth branch is hidden and logged.

### Speakers, names and portraits

`ArticySpeakerResolver` matches the line's Articy speaker against every `IArticyLinked` entity in `IEntitySource.All`. Since a prefab's instances share one Articy id, the conversation's owner wins when it matches, and otherwise the match nearest the party leader does. Barks pass no owner, so they always take the nearest.

A matched agent is named from the `Content` table (`actor.<prefabId>.name`), the same entry the action log reads. A speaker with no entity in the world (the narrator) keeps its Articy display name, and a line can then have a name but no `EntityId`. The technical name always comes from Articy.

Portraits come from `PortraitCatalogSO` (`Data/Narrative/PortraitCatalog.asset`), keyed on the Articy technical name: a default splash with optional expression sprites, a profile icon for the party and initiative HUD, and whether the speaker is pinned to the right slot. An entry with no splash (`npc_alchemist` today) shows no portrait. The view has two portrait slots. A speaker keeps its slot, a pinned one takes the right, and the speaker is lit while the other is dimmed and shrunk. The `expression` stage direction sets a speaker's expression in `PortraitExpressionState`, and the catalog falls back to the splash for an unknown one. The state is never cleared, so an expression lasts until another replaces it.

### Stage directions

A dialogue fragment's stage directions are command lines, one per line (`id:arg:arg`, `#` for a comment), parsed by the shared `CommandFactory` ([[Commands & Debugging#The text syntax|Commands & Debugging]]). Only the six verbs on the root factory work here: `resource`, `camera`, `spawn`, `move`, `expression` and `audio`. Any other verb logs an error and is dropped, and the line still shows. The shipped export uses:

```
move:colt:-3:0:-5:forced
camera:shot:korvas
spawn:korvas:8:1
spawn:alchemist:-9:-3:alchemist-1
expression:npc_korvas:corrupted
camera:shot:release
```

`DialoguePresenter.OnLineReady` runs a line's commands before it renders, also while skipping. A line rebuilt for a language change does not run them again. Camera shots stay up until a `camera:shot:release` ([[Camera & Input#Shots|Camera & Input]]).

### Presenting a line

```csharp
public DialoguePresenter(IDialogueView view, IConversation conversation, CommandExecutor commands,
    IGameClock clock, DialogueRevealSettings reveal = null);
```

The presenter drives the conversation: it renders each `LineReady`, routes the view's `ChoiceSelected`, `AdvanceRequested` and `SkipRequested` back into `IConversation`, and hides the view on `Finished`.

**Typewriter reveal.** With reveal on, the line renders with its choices withheld and its text cut to zero visible characters, then reveals one visible character at a time on `IGameClock.Delay`, so it stops with the game clock. Rich-text tags count as zero characters (`DialogueMarkup`). When the text is out, the choices are put back and the line renders again. `DialogueRevealSettings.DelayFor` sets each step:

| After | Delay | Default |
|-------|-------|---------|
| any other character | `CharacterDelay` | 0.024 s (about 42 characters a second) |
| `,` `;` `:` | `MinorPauseDelay` | 0.15 s |
| `.` `!` `?` | `SentenceDelay`, once after a run such as `...` | 0.3 s |

The values are tuned in the "Dialogue reveal" box of `UIInstaller` on `SceneManager.prefab`. A presenter built without settings uses `DialogueRevealSettings.Instant`, which turns the reveal off; that is what the unit tests get.

**Advance, skip and teardown.** A click on the dialogue panel advances: mid-reveal it completes the line, otherwise it asks Articy for the next one. The click that opened the panel is swallowed, and no gameplay key advances dialogue. The Skip button runs ahead line by line, 0.1 s apart, until a line with choices. `_revealCts` is both the reveal's cancellation source and its ownership token: cancelling it while keeping the field completes the line, while nulling the field before cancelling (a new line, `Finished`, dispose) leaves the view alone.

**The view.** `DialogueView` is fed by the flow player, which can emit before `PanelRenderer` binds the panel and after a live reload unbinds it. So it records what it was asked (`_lastLine`, `_visible`) and replays it on `Bind`, and `Unbind` drops its elements ([[UI Architecture#Live reload|UI Architecture]]).

### While a conversation is open

- `DialogueInputLock` holds `IPlayerInputLock` from the first `LineReady` to `Finished`. Gameplay input is off except Pause, the camera is held, and the HUD hides, barks included ([[Camera & Input#Locks and gating|Camera & Input]])
- Esc opens the pause menu (after closing a popup, or resuming if already paused); it never cancels a conversation
- `ConversationWalkHold` freezes a walk already under way and resumes it on close; walks the conversation orders (`move` stage directions) and skill dashes keep going
- A skill is refused with `DuringDialogue` when its caster holds the dialogue activity, which clicked and item conversations claim; a scripted `DialoguePhase` claims none, and there only the input lock stops the player

### Barks

A bark is one line over a speaker's head, outside any conversation. `ExplorationPhase` says its `_bark` set when its phase starts and then every `_barkEverySeconds` (0 says it once), skipping any moment a conversation is open ([[Encounter System#Shipped phases|Encounter System]]). The only authored bark is in `DemoArenaOpening`: three lines for Colt, every 8 s.

`ArticyBarks.Say` takes the set's spoken children (a flow object with a speaker) whose input pins evaluate true and picks one at random, never the one it said last when another is available (that memory is one field shared by all sets). A childless fragment can be its own bark. The pick draws on the shared seeded `Random`, the same stream the dice use and the save stores ([[Combat & Dice#One seeded stream|Combat & Dice]]), so every bark moves the dice stream on.

`BarkPresenter` drops a bark whose speaker is not in the world or whose text is empty (warning once per speaker). Otherwise it runs the bark's stage directions, shows it through `BarkView` (2.4 m above the speaker, hidden while the speaker is concealed or down) and holds it `SecondsShown` = 4 s. A new bark from the same speaker replaces the old one. The hold only counts down while the HUD is visible, so a bark caught by a conversation waits it out.

### Script methods

Articy conditions and instructions can call C# through a script method provider. `DialogueScriptMethods` sets itself as `ArticyDatabase.DefaultMethodProvider` in `OnEnable` and clears it in `OnDisable` only if it still holds it, so with two alive the last enabled wins.

```csharp
public bool StatCheck(string stat, int threshold);   // the leader's stat >= threshold
public int Roll(string stat);                        // a d100 against the leader's stat, as (int)RollThreshold
public bool IsCalledInForecast { get; set; }
```

Both read the party leader's stat by its English enum name (`Strength`, `Insight`, `Intimidate`...), through `AgentStats.TryGet`. `Roll` resolves through `RollResolver` with no advantage, skipping `AttributeCheckService`, so statuses never apply and nothing shows the roll ([[Combat & Dice#Attribute checks|Combat & Dice]]). It returns -2, -1, 1, 2, 3 or 4 (`CriticalFailure` to `CriticalSuccess`), and `Failure` with no leader or an unknown stat.

Articy evaluates conditions speculatively while it works out which branches are open. It flags that with `IsCalledInForecast`, and `Roll` then returns `Regular` without rolling. Any new method that rolls, spends or changes state needs the same guard. `ArticyBarks` evaluates bark pins itself and never sets the flag, so a `Roll` in a bark condition would roll for real.

None of this is live yet. The Articy export defines no script methods (`script_methods.json` is empty, and the generated `IScriptMethodProvider` has no members), so no node calls these, and the class has no tests.

### Global variables

Articy globals are generated code: `ArticyGlobalVariables`, with one namespace per Articy variable set. The export has one variable, `GameState.winCombat`. No C# reads or writes it. Two pins on a flow fragment read it, but the encounter starts the win and lose conversations directly, so that fragment never plays. A hand-written reference to a renamed variable would fail to compile after the re-export; with none today, a rename only costs a save that variable's stored value.

`ArticyGlobalsSavable` (`ArticyGlobals`, version 1) saves them ([[Save & Load System]]):

- **Capture** walks every variable and stores it in one of three dictionaries, `Bools`, `Ints` and `Strings`, keyed by full name (`GameState.winCombat`). Any other type is skipped
- **Restore** resets every variable to its exported default first, then applies each saved value only if the variable still exists with the same type. A variable deleted or retyped in Articy since the save keeps its default
- **New game** resets them to the exported defaults

There is no `Migrate`; the dictionary shape already tolerates added and removed variables.

### Localization

Dialogue text and choice labels are localized by Articy's language packs (English and Spanish in the export), not by Unity's string tables. `UnityLanguageService` keeps the two in step: at startup and on every language change it sets Articy's language to the pack whose culture name matches the locale code, before raising `LanguageChanged`. With no matching pack, dialogue stays in its authored language and a warning is logged ([[UI Architecture#Localization|UI Architecture]]).

On `LanguageChanged`, `DialogueSource` rebuilds the line on screen and emits it again flagged `Rebuilt`. The presenter replaces it whole, without retyping it or running its commands. Speaker names follow two routes: a matched agent's name comes from the Unity `Content` table, any other speaker's from Articy.

### Debugging

The `dialogue` console command reads the open conversation or drives it one step per call (`talk`, `next`, `choose:<n>`, `stop`). The flow player advances on its own `Update`, so several `Advance` calls in one CLI evaluation all land in the same frame: drive it one call at a time. The game repo's `articy` skill covers what a play session leaves dirty in the Articy assets.

---

## Divergence from the GDD

No GDD page describes dialogue, choices or barks. The design pages that touch them:

| Topic | GDD | Code |
|-------|-----|------|
| Showing narrative rolls | [[Dados]]: combat rolls are hidden, while narrative and important ones get a dice-rolling animation, and exploration shows the rolls behind the player's decisions | nothing shows a dialogue roll; `Roll` only returns a level to Articy |
| Social aptitudes | [[Estadísticas de Agentes]] lists Intimidar, Persuadir, Engaño and Rastrear, and the character sheets in `03 - Entidades` give each character a value | `Aptitude` has `Intimidate` but no Persuade, Deceit or Track, so those cannot be checked or rolled from Articy |
| Pushing luck | [[Dados]] and [[Suerte]]: a Normal success where a Hard one is needed can be pushed with Luck | `Roll` answers at once, with no Luck step |
| Critical and fumble bands | [[Dados]]: critical below 5, fumble 98–100 | `RollResolver`: 5 or less, 96 or more, for dialogue rolls as for combat ([[Combat & Dice#Divergence from the GDD\|Combat & Dice]]) |
| Pacts | [[Pactos (Wishlist)]]: a pact can unlock dialogue options | not built (wishlist) |

Against the other architecture pages, [[Action System#One coarse record|Action System §8]] says dialogue mutates state through stage-direction commands and Articy variable writes. Commands do, but no conversation writes an Articy variable today.

---

## Adding a Talkable NPC

1. On the prefab's entity, set `_articy` to the character's Articy entity and `_dialogue` to the conversation to start; set `_talkRange` only to change the 2.5 m default
2. Give the Articy entity a portrait entry in `PortraitCatalog.asset` under its technical name (splash, any expressions, profile)
3. For an agent, add `actor.<prefabId>.name` to the `Content` table in both locales; that, not the Articy name, is what the line shows

## Adding a Script Method

1. Define the method in Articy:draft and re-export. The generated `IScriptMethodProvider` gains its signature, and since `DialogueScriptMethods` implements that interface, it does not compile until step 2 is done. Treat a re-export as a new-files change (a Unity recompile, not a csproj build) and commit `ArticyEditorSettings.asset` with it
2. Implement it as a public method on `DialogueScriptMethods` with the generated signature, taking services through `[Inject]` fields resolvable from the scene container
3. Guard any roll, spend or state change with `if (IsCalledInForecast) return <neutral value>;`, as `Roll` does. A pure read needs no guard
4. A roll on one of the five attributes that should apply statuses and show the usual readout goes through `AttributeCheckService.Check`, which takes an `Attribute` only; aptitude rolls have no such path today

A new stage direction is a command registered on the root factory: [[Commands & Debugging#Adding a Stage-Direction Command|Commands & Debugging]].