## 1. Overview

The **Quest System** is a synchronous, command-driven system designed under Clean Architecture principles. Player actions instantiate pure C# commands (`ICommand`) processed by the **Command Executor**. This executor utilizes an `ICommandContext`—an interface bridge that grants direct access to mutable game systems like the _World State_ and _Inventory_ without coupling the core logic to the Unity Engine.

The architecture strictly separates **Static Data** from **Runtime State**:

- **The Quest Catalog:** A collection of immutable Unity assets (`QuestDefinition`) specifying prerequisites, rewards, and abstract objective configurations.

- **The Quest Journal:** A pure C# runtime structure storing active, serializable quest instances and their current progress.

Following a command's execution, the **Command Executor** immediately triggers the **Quest Evaluator** in the same frame. Each Quest transitions through defined states (_Inactive → Active → Completed / Failed / Skipped_) by delegating state evaluation to polimorphic, abstract objectives. Objectives manage their own lifecycle (_Pending → Active → Completed / Skipped / Failed_). Once all objectives hit the completed state, the evaluator triggers the quest's abstract rewards, applying modifications back into the game world through the context.
### 1.1. Design Goals

- Asset-based identity over strings.
- Entity lifecycle independence.
- Designer-navigable in the Inspector.
- World state as the source of truth.
- No dependency on MonoBehaviours or scene hierarchy.
### 1.2. Functional Requirements

- Support linear and non-linear quest structures.
- Allow multiple simultaneous active objectives within a single quest.
- Support branching outcomes based on how objectives are completed.
- Drive progression from world state: stats, inventory, flags, NPC status, and any other registered fact.
- Persist quest state and integrate with external game systems (save/load, dialogue, combat...)

---
## 2. Core Concepts

- **Query (World Abstraction):** It is the central data abstraction of the system. A `Query` identifies a specific data point somewhere in the world (e.g., Player Weapon Type, ammo, Kill Count of a specific enemy, Quest Progress) but does **not** contain the value itself. It only describes _what_ to locate.

- **Query Resolver (The Bridge):** It is the executioner of the queries. Positioned in the Systems layer, the `QueryResolver` intercepts a `Query` from the Core, fetches the real, live data from the concrete game systems (Inventory, World State, Stats), and returns the primitive value back to the Core.

- **Synchronous Command-Driven Evaluation:** The system does not rely on continuous update loops or decoupled asynchronous events. Every player action is an `ICommand`. The moment the `CommandExecutor` runs a command, it immediately evaluates the active quests and catalog requirements. This ensures 100% determinism.


---
## 3. Centralized Execution Flow

```
Player Action triggers Unity Input / UI Event
        │
        ▼
Instantiates concrete ICommand
        │
        ▼
CommandExecutor.Execute(command)
        │
        ▼
command.Execute(ICommandContext)
        │
        ▼
Changes to WorldState / Inventory / etc.
        │
        ▼
CommandExecutor invokes QuestEvaluator.Evaluate()
        │
        ▼
QuestJournal State is updated
        │
        ▼
If Quest completes -> CommandExecutor dispatches Reward Commands
```

---
## 4. Query 

An `Query` is simply a type marker containing data properties.

### 4.1. Query Resolver

The `QueryResolver` maps query data configurations to concrete runtime evaluations without exposing the underlying systems directly to the domain.

### 4.2. Adding a new Query

To add a new query to the system, follow these 3 steps across the layers:

1. **Core/Domain:** Define the immutable query record.

```
public record HasDiscoveredZoneQuery(string ZoneId) : IQuery<bool>;
```

2. **Gameplay / System Boundary:** Implement the handler that reads from the concrete subsystem.

```

public class HasDiscoveredZoneHandler : IQueryHandler<HasDiscoveredZoneQuery, bool>
{
    private readonly IExplorationSubsystem _explorationSystem;

    public HasDiscoveredZoneHandler(IExplorationSubsystem explorationSystem)
	    => _explorationSystem = explorationSystem;

    public bool Execute(HasDiscoveredZoneQuery query)
	    => _explorationSystem.IsZoneDiscovered(query.ZoneId);
}
```

3. **System:** Register the handler into the `QueryResolver` instance during Bootstrapping.

## 5. Conditions

Conditions bind an `Query` to a static evaluation rule using a comparison operator and a target literal value.

Example:

```text
Player.Health >= 50
```

becomes:

```csharp
new Condition(playerHealthQuery, ComparisonOperator.GreaterOrEqual, 50);
```

### 5.1. Composite Conditions

Complex validation conditions are assembled utilizing the Composite Pattern. These are also nested structural DTOs without self-evaluation capabilities:

- **AndCondition:** True if all nested sub-conditions return true.
- **OrCondition:** True if at least one nested sub-condition returns true.
- **NotCondition:** Inverts the result of the nested sub-condition.

---
## 6. Objectives

An objective tracks state through explicit lifecycles: `Pending`, `Active`, `Completed`, `Failed`, or `Skipped`.
### 6.1. Graph Constraints

- **Parallel Activation:** Any node whose `PrerequisiteNodeIds` are fully satisfied (`Completed`) transitions instantly from `Pending` to `Active`.
- **Optional Nodes:** If a node has `IsOptional == true`, its failure or pending status does not block prerequisites for child nodes, nor does it block total quest completion.
- **Mutual Exclusion:** When an objective node transitions to `Completed`, any node ID listed under its `MutuallyExclusiveObjectiveIds` is instantly forced into a `Failed` state during that exact same evaluation loop cycle.

### 6.2. Create a new Objective

To create a new objective, you must inherit from an abstract base class in the domain that defines the node, and its evaluation will depend entirely on the resolution of the associated conditions using data from the QuestCatalog at runtime.

``` c#
public abstract class ObjectiveNode
{
    public string Id { get; init; }
    public List<string> PrerequisiteNodeIds { get; init; } = new();
    public List<string> MutuallyExclusiveObjectiveIds { get; init; } = new();
    public bool IsOptional { get; init; }
    public ICondition Condition { get; init; }
}
```

---
## 7. Quests

A Quest definition consists of a collection of structural nodes and a set of command descriptors to trigger upon completion or failure. A Quest is structurally defined as a network of Objective Nodes.

When an objective completes:

1. Results are executed
2. Rewards are granted
3. The next objective becomes active
4. Quest completion is checked

### 7.1. Create a new Quest

```C#
[CreateAssetMenu(menuName = "EternalDusk/Quests/Quest Definition")]
public class QuestDefinitionSO : ScriptableObject
{
    [SerializeField] private string _questId;
    [SerializeField] private List<ObjectiveNodeData> _nodes;
    [SerializeField] private List<CommandDescriptor> _rewards;

    public QuestRuntimeState ConvertToRuntimeState()
	    => new QuestRuntimeState(_questId, _nodes.Select(n => n.ToDomainNode()));
}
```

---
## 8. Player Actions (Commands)

Player actions are pure write operations that modify the game state. Any action relevant to the game world is modeled as a pure C# command that implements the ICommand interface.

The mission system does not generate these actions; it reacts to them synchronously and immediately through the CommandExecutor.
### 8.1. Anatomy of an Action (ICommand)

An action encapsulates the data necessary to execute the modification, but it does not contain Unity logic or references to scene components.

```C#
public interface ICommand 
{
    void Execute(ICommandContext context);
}

public record PickUpWeaponAction(string WeaponId) : ICommand 
{
    public void Execute(ICommandContext context) 
    {
        context.Inventory.AddItem(WeaponId);
    }
}

public record EnterZoneAction(string ZoneId) : ICommand 
{
    public void Execute(ICommandContext context) 
    {
        context.WorldState.SetFlag($"Visited_{ZoneId}", true);
    }
}
```

### 8.2. Execution Flow

To maintain decoupling, the **Gameplay** layer (physics, Unity triggers, UI) is responsible for instantiating and sending these actions to the central executor.

1. **Trigger (Gameplay):** The player enters the invisible Saloon trigger in Unity.
2. **Instantiation:** The trigger script creates the action: `new EnterZoneAction(“Saloon”)`.
3. **Synchronous Processing:**
    - The `CommandExecutor` receives the action.
    - The action is executed by modifying the state via the `ICommandContext`.
    - **Immediately in the same frame**, the `CommandExecutor` calls `QuestEvaluator.Evaluate()`.
    - The evaluator uses the `QueryResolver` to check if any active quests required `Visited_Saloon` to be `true`.

---
## 9. Evaluation Flow

The `QuestEvaluator` performs iterative evaluations over the structural topology graphs of all `Active` quests within the runtime journal.

```
QuestEvaluator (System)
    │
    ├──► Loops through Active Quests in Journal
    │     │
    │     ├──► Iterative Node Traversal (Resolves Parallel, Optional & Prereqs)
    │     │     │
    │     │     └──► Resolves Node Conditions via QueryResolver
    │     │           │
    │     │           └──► Pulls data from Concrete Subsystems
    │     │
    │     └──► Processes Mutual Exclusion Rules (Forces instantaneous propagation)
    │
    └──► Returns triggered State Mutation Commands back to CommandExecutor
```

### 9.1. Node State Resolution Algorithm

During a single frame evaluation pass, the state engine processes node state shifts using the following rules:

1. **Prerequisite Check:** If a node is `Pending` and all its non-optional `PrerequisiteNodeIds` are `Completed`, its state shifts to `Active`.
    
2. **Condition Resolution:** If a node is `Active`, its structural `Condition` configuration is extracted and passed to the `QueryResolver`. If the condition evaluates to true, the node state shifts to `Completed`.
    
3. **Mutual Exclusion Cascade:** If a node shifts to `Completed`, all target node IDs specified in its `MutuallyExclusiveObjectiveIds` list shift directly to `Failed`.
    
4. **Loop Stabilization:** Steps 1–3 repeat iteratively until no further state changes are recorded for that evaluation pass, preventing multi-frame delays or race conditions.
