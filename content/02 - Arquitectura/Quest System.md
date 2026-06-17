## Overview

The **Quest System** is a synchronous, command-driven system designed under Clean Architecture principles. Player actions instantiate pure C# commands (`ICommand`) processed by the **Command Executor**. This executor utilizes an `ICommandContext`—an interface bridge that grants direct access to mutable game systems like the _World State_ and _Inventory_ without coupling the core logic to the Unity Engine.

The architecture strictly separates **Static Data** from **Runtime State**:

- **The Quest Catalog:** A collection of immutable Unity assets (`QuestDefinition`) specifying prerequisites, rewards, and abstract objective configurations.

- **The Quest Journal:** A pure C# runtime structure storing active, serializable quest instances and their current progress.

Following a command's execution, the **Command Executor** immediately triggers the **Quest Evaluator** in the same frame. Each Quest transitions through defined states (_Inactive → Active → Completed / Failed / Skipped_) by delegating state evaluation to polimorphic, abstract objectives. Objectives manage their own lifecycle (_Pending → Active → Completed / Skipped / Failed_). Once all objectives hit the completed state, the evaluator triggers the quest's abstract rewards, applying modifications back into the game world through the context.
### Design Goals

- Asset-based identity over strings.
- Entity lifecycle independence.
- Designer-navigable in the Inspector.
- World state as the source of truth.
- No dependency on MonoBehaviours or scene hierarchy.
### Functional Requirements

- Support linear and non-linear quest structures.
- Allow multiple simultaneous active objectives within a single quest.
- Support branching outcomes based on how objectives are completed.
- Drive progression from world state: stats, inventory, flags, NPC status, and any other registered fact.
- Persist quest state and integrate with external game systems (save/load, dialogue, combat...)

---
## Folder Structure

```text
├── Core/
│   ├── Quests/Interfaces/
│   │   ├── ICommand.cs
│   │   ├── ICommandContext.cs
│   │   ├── ICondition.cs
│   │   └── IQuestService.cs
│   ├── Quests/Runtime/
│   │   ├── QuestInstance.cs
│   │   ├── ObjectiveProgress.cs
│   │   └── Query.cs
│   └── Quests/Enums/
│       ├── QuestState.cs
│       └── ObjectiveState.cs
│
├── Engine/
│	├── Quests/Definitions/
│	│   ├── QuestDefinition.cs
│	│   ├── ObjectiveDefinition.cs
│	│   ├── AbstractCondition.cs
│	│   └── AbstractReward.cs
│	├── Quests/MonoBehaviours/
│	│   ├── QuestJournalUI.cs
│	│   ├── QuestTriggerZone.cs
│	│   └── QuestInstaller.cs
│	│ 
│	└── Quests/Implementations/
│		├── ConcreteObjectives/
│		└── ConcreteRewards/
│
├── Gameplay/Quests/
│   ├── CommandExecutor.cs
│   ├── QuestService.cs
│   ├── QueryResolver.cs
│   ├── QuestJournal.cs
│   ├── QuestCatalog.cs
│   └── QuestEvaluator.cs
│
└── System/
```

---
## Layer Responsibilities

### Core Layer (Pure C# - Unity-Independent)
* **Contents:** Structural interfaces (`ICommand`, `ICommandContext`, `IInventory`, `IWorldState`), pure data entities (`Quest`, `Objective`), and enumerators.
* **Rule:** No use of `using UnityEngine;`. This layer contains pure business logic. It can be 100% tested using native C#.
* **Change from the previous design:** State classes (`Quest` and `Objective`) do not store direct references to `ScriptableObjects`. Instead, they use flat data structures or IDs to link to each other.

### Gameplay Layer (Pure C# / Control Logic)
* **Contents:** `CommandExecutor`, `QuestEvaluator`, and the logical implementation of the quest service (`QuestService`).
* **Rule:** Receives primitive data and orchestrates when a command is executed and when a quest is evaluated. It remains independent of Unity (does not inherit from `MonoBehaviour`).

### Engine Layer (Unity-Dependent)
* **Contents:** Concrete implementation of `ScriptableObjects` (`QuestDefinition`, `Condition`, `Reward`), Unity event listeners (3D Triggers, Collisions), and classes that inherit from `MonoBehaviour` to render the Journal UI on the player’s screen.
* **Rule:** This is the only layer authorized to interact with the Unity API. It translates Unity actions into Core commands.

---
## Key Concepts

- **Query (World Abstraction):** It is the central data abstraction of the system. A `Query` identifies a specific data point somewhere in the world (e.g., Player Weapon Type, ammo, Kill Count of a specific enemy, Quest Progress) but does **not** contain the value itself. It only describes _what_ to locate.

- **Query Resolver (The Bridge):** It is the executioner of the queries. Positioned in the Systems layer, the `QueryResolver` intercepts a `Query` from the Core, fetches the real, live data from the concrete game systems (Inventory, World State, Stats), and returns the primitive value back to the Core.

- **Synchronous Command-Driven Evaluation:** The system does not rely on continuous update loops or decoupled asynchronous events. Every player action is an `ICommand`. The moment the `CommandExecutor` runs a command, it immediately evaluates the active quests and catalog requirements. This ensures 100% determinism.

- **Immutable Definition vs. Serializable Runtime State:**

	- **Definitions (`ScriptableObjects`):** Read-only data assets created in the Unity Editor that describe the blueprints of quests, rewards, and conditions.

    - **Instances (`Pure C# Classes`):** Light, mutable, and fully serializable data structures that live in memory during runtime to track player progress.

- **Polymorphic Evaluation:** The Core engine knows absolutely nothing about specific gameplay mechanics (like "kill 10 enemies" or "talk to Colt"). It only manages states. The concrete victory or progression logic is entirely delegated to abstract implementations (`ICondition`), allowing designers to create new types of content without touching a single line of core code.

---
## Centralized Execution Flow

```
Player Action (Unity)
        │
        ▼
 ICommand instance
        │
        ▼
 CommandExecutor.Execute(command)
        │
        ▼
 command.Apply(context)
        │
        ▼
 Changes to WorldState / Inventory / etc.
        │
        ▼
 QuestEvaluator.Evaluate(...)
        │
        ▼
 QuestState update
        │
        ▼
 ObjectiveState update
        │
        ▼
 Rewards / completion / unlocks
```

---

### Conditions

Conditions are predicates evaluated against world state. Every objective ultimately evaluates one or more conditions.

Example:

```text
Player.Health >= 50
```

becomes:

```csharp
new Condition(
    playerHealthQuery,
    ComparisonOperator.GreaterOrEqual,
    50);
```

Conditions are read-only. Never modify the world.

---
### Composite Conditions

Complex conditions are composed from simpler Conditions.

Example:

```text
Player.Health >= 50
AND
Player.Stamina >= 20
```

becomes:

```text
AndCondition
├── HealthCondition
└── StaminaCondition
```

Supported composites:

- `AndCondition`
- `OrCondition`
- `NotCondition`

Condition can be nested arbitrarily.

---
### Objective Evaluation

An objective is considered complete when all of its required conditions evaluate successfully.

Example:

```text
Reach Village
AND
Own Iron Sword
```

```text
Objective
├── Condition
│   └── CurrentZone == Village
└── Condition
    └── Inventory.IronSword >= 1
```

---
### Quest Progression

Quests are evaluated sequentially.

```text
Quest
├── Objective 1
├── Objective 2
└── Objective 3
```

Only active objectives are evaluated.

When an objective completes:

1. Results are executed
2. Rewards are granted
3. The next objective becomes active
4. Quest completion is checked

---
### Player Actions (ICommand)

Actions modify the world. Unlike conditions, actions are write operations.

Examples:

```text
Player.Health += 20

Player.CurrentWeapon.Ammo += 30
```

All actions target a `Query`.

Example:

```csharp
new ModifyValueAction(
    playerHealthQuery,
    +20);
```

This keeps the action system independent of gameplay implementations.

---

### Runtime State

Definitions are immutable assets. Runtime progress is stored separately.

```text
QuestDefinition
    ↓
QuestInstance
```

```text
ObjectiveDefinition
    ↓
ObjectiveProgress
```

This allows:

- save/load support
- quest resets
- multiple concurrent instances
- simulation and testing

---

### Evaluation Flow

```text
QuestEvaluator
    ↓
Objective
    ↓
Query
    ↓
WorldPath
    ↓
IWorldPathResolver
    ↓
Gameplay Systems
```

The evaluator never reads gameplay systems directly.

All world access is routed through the resolver abstraction.

---

## Adding a New Query Type

1. Implement `IQuery`
2. Add evaluation logic
3. Register it with the evaluator if required

Example:

```csharp
public sealed class HasItemQuery : IQuery
{
    public WorldPath Path;
    public int Amount;

    public bool Evaluate(IWorldPathResolver resolver)
    {
        return resolver.TryGetValue(Path, out var value)
            && value >= Amount;
    }
}
```

No quest code needs to change.

---

## Adding a New World Value

1. Create a new resolver implementation
2. Register it with `WorldPathResolver`
3. Expose the value through the world path picker

Example:

```text
Player.Reputation

Player.FactionRank

Merchant.Disposition

Companion.Loyalty
```

No quest code needs to change.

---

## Classes at a Glance

| Class                      | Layer    | Responsibility                                                                                                                  |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ICommand`                 | Core     | Immutable player action                                                                                                         |
| `ICommandContext`          | Core     | An interface that displays the game's systems                                                                                   |
| `QuestDefinition`          | Core     | Immutable quest asset                                                                                                           |
| `ObjectiveDefinition`      | Core     | Immutable objective asset                                                                                                       |
| `QuestInstance`            | Core     | Runtime quest state                                                                                                             |
| `ObjectiveProgress`        | Core     | Runtime objective state                                                                                                         |
| `Query`                    | Core     | Reference to world data                                                                                                         |
| `ICondition`               | Core     | Condition contract                                                                                                              |
| `ComparisonCondition`      | Core     | Numeric comparison                                                                                                              |
| `(or, not, and) Condition` | Core     | Composite Condition                                                                                                             |
| `QuestEvaluator`           | Systems  | Evaluates active quests                                                                                                         |
| `QuestJournal`             | Systems  | Stores quest instances                                                                                                          |
| `QuestCatalog`             | Systems  | Provides definitions                                                                                                            |
| `QueryResolver`            | Systems  | Resolves query references                                                                                                       |
| `CommandExecutor`          | System   | Receives the `ICommand` injects the `ICommandContext` into it to execute it, and then immediately triggers the `QuestEvaluator` |
| `ModifyValueAction`        | Gameplay | Writes world values                                                                                                             |
| `RewardExecutor`           | Gameplay | Executes rewards                                                                                                                |
