# Action System

## Table of Contents

- [[Action System#1. Overview|Overview]]
- [[Action System#2. Core Concepts|Core Concepts]]
- [[Action System#3. Ground Rules|Ground Rules]]
- [[Action System#4. ActivityRegistry|ActivityRegistry]]
- [[Action System#5. Interruptibility & Precedence|Interruptibility & Precedence]]
- [[Action System#6. MovementService|MovementService]]
- [[Action System#7. SkillService|SkillService]]
- [[Action System#8. DialogueService|DialogueService]]
- [[Action System#9. Interaction Dispatch|Interaction Dispatch]]
- [[Action System#10. Narrative Source|Narrative Source]]
- [[Action System#11. Status Effect Integration|Status Effect Integration]]
- [[Action System#12. ActionLedger|ActionLedger]]
- [[Action System#13. Request Lifecycle|Request Lifecycle]]
- [[Action System#14. Invariants & Edge Cases|Invariants & Edge Cases]]
- [[Action System#15. Cost & Allocation|Cost & Allocation]]

---

## 1. Overview

The Action System is the single coordination layer for everything an entity _does over time_: moving along a path, casting a skill, holding a conversation. It enforces one global rule — **an entity is doing at most one activity at a time** — sequences each activity through `Plan → Validate → Execute`, and records committed outcomes to a ledger that drives the player-facing action feed.

It is a CPU-side, event-driven coordinator. The cost model is "a handful of dictionaries and one `CancellationTokenSource` per request." Its job is _correctness of the activity state machine and its cancellation paths_, not throughput.

### Design Goals

- **One activity per entity** — a single registry slot per entity is the source of truth; "busy" is one lookup
- **Uniform start contract** — every activity either supersedes-with-interrupt or is refused, by one central policy, never by per-service branching over kinds
- **Cancellation correctness** — cancel-and-replan, external cancellation, status interrupts, and pre-emption all converge on one per-activity token; teardown is idempotent and ownership-checked
- **Ledger as a projection** — committed outcomes only; world-state reconstruction is the save/load snapshot path's job

---

## 2. Core Concepts

### Activity vs Action

Two words, deliberately distinct:

- **Activity** — a _runtime occupancy_. While an activity runs it holds the entity's registry slot. It has duration and may be interruptible. Kinds: `Movement`, `Skill`, `Dialogue`.
- **Action** — a _recorded fact_. A committed activity appends an `ActionRecord` (a turn-stamped `IActionPayload`) to the `ActionLedger`. Actions outlive the activity that produced them.

**An action does not require an activity.** Durative activities record actions on commit, but instantaneous interactions also record directly — picking up and dropping items append `PickUpItemPayload` / `DropItemPayload` without ever touching the registry ([[Action System#9. Interaction Dispatch|§9]]). The registry tracks activities (transient present state); the ledger accumulates actions (append-only history) from both sources.

### The Slot Model

The registry holds **at most one `Entry` per `EntityId`**. Starting a new activity overwrites the slot; the superseded scope's `Dispose` becomes a no-op via an ownership check. The single slot expresses three start situations:

|Situation|Mechanism|
|---|---|
|Same entity, same kind, new request (e.g. new move destination)|cancel-and-replan — supersede own slot|
|Same entity, different kind pre-empting (skill over movement)|supersede-with-interrupt via `TryInterrupt`|
|Same entity, slot held by a non-yielding activity|**refused** — the incoming activity does not start|

### Terminal Dispositions

Every activity ends in exactly one disposition. Only **non-cancelled** dispositions record to the ledger.

|Disposition|Records?|Meaning|
|---|---|---|
|Completed|yes|reached natural end (path done, skill resolved, dialogue end-branch)|
|HaltedByBudget|yes (movement)|ran out of movement budget mid-path|
|Cancelled|**no**|superseded, externally cancelled, interrupted, or torn down|
|Refused / GateRejected|**no**|never started — gates or registry refused it|

### ActivitySource

`ActivitySource { PlayerInputExploration, PlayerInputCombat, Ai, Cinematic }`. This single enum answers _who drives the activity_ and, by derivation, _whether it can be interrupted_ ([[Action System#5. Interruptibility & Precedence|§5]]). Player input is interruptible; `Ai` and `Cinematic` are not. Dialogue is the one case where driver and interruptibility diverge — it is player-driven yet should not be movement-interruptible — so its interruptibility is set deliberately at registration rather than read off the driver.

---

## 3. Ground Rules

The three rules the system enforces:

1. **An entity holds at most one activity in the registry at a time.** Starting another either supersedes-with-interrupt or is refused, per the central precedence policy ([[Action System#5. Interruptibility & Precedence|§5]]). This is a _bookkeeping_ invariant: the registry holds one slot, but a superseded activity may still be physically unwinding for a few frames after its slot is taken. "One at a time" means "the registry holds one," not "the world contains one."
    
2. **An activity has duration and may be interruptible.** Interruptibility is derived from `ActivitySource`. `Movement` covers path-following; instantaneous displacement such as knockback or scripted shoves is handled as a skill effect on the target, not as a movement activity.
    
3. **An activity records its outcome on reaching a non-cancelled terminal state.** Cancellation records nothing — movement skips `Cancelled` and cancel-and-replan, and a cancelled skill never reaches its record ([[Action System#7. SkillService|§7]], [[Action System#12. ActionLedger|§12]]).
    

---

## 4. ActivityRegistry

The single-slot state machine, keyed on `EntityId` alone: at most one activity per entity.

### Interface

```csharp
bool IsBusy(EntityId entity);
bool TryGetActivity(EntityId entity, out ActivityKind kind);
IDisposable Begin(EntityId entity, ActivityKind kind, ActivitySource source, Action onInterrupt = null);
bool TryInterrupt(EntityId entity);
```

### Begin — supersede-by-default

`Begin` unconditionally writes the entity's slot and returns a `Scope`. It does **not** refuse on a busy slot — refusal is the caller's responsibility, expressed one of two ways:

- **Gate first** (movement): query `TryGetActivity` / `IsBusy` before calling `Begin`, and reject the request if the slot is held by something else.
- **Honour `TryInterrupt`** (skill, dialogue): call `TryInterrupt` first; only `Begin` if it returned `true`.

This keeps `Begin` dumb and puts the precedence decision in one well-understood place per caller, not inside the registry.

### TryInterrupt — "is the slot takeable?"

```
true  ← nothing held the slot, OR the held activity yielded (OnInterrupt fired, once)
false ← the held activity refuses (its source is non-interruptible)
```

`TryInterrupt` is idempotent on the _interrupting_ flag: a second call while an interrupt is already in flight does not re-fire `OnInterrupt`. It returns `true` for an empty slot, so callers treat "nobody home" and "the occupant stepped aside" identically.

### Scope.Dispose — ownership-checked removal

```csharp
// Remove only if we still own the slot — a newer Begin (supersede / replan)
// may have replaced it, and that newer activity is the live one.
if (_entries.TryGetValue(_entry.Entity, out var current) && current == _entry)
    _entries.Remove(_entry.Entity);
```

This is the load-bearing invariant that makes supersede safe: when activity A is superseded by activity B, A's eventual `Dispose` finds B in the slot, sees `current != _entry`, and removes nothing. Without the identity check, A's teardown would evict B's live entry.

### Interruptibility derivation

```csharp
private static bool IsInterruptible(ActivitySource source) => source switch
{
    ActivitySource.PlayerInputCombat or ActivitySource.PlayerInputExploration => true,
    _ => false,
};
```

This is the whole precedence engine — no priority number, no per-kind matrix. See [[Action System#5. Interruptibility & Precedence|§5]] for the resulting behaviour.

---

## 5. Interruptibility & Precedence

Precedence is derived entirely from the held activity's `ActivitySource` plus _how the incoming activity asks for the slot_. This section is that policy made explicit.

### How each activity asks for the slot

|Incoming|Mechanism|Outcome when slot is held|
|---|---|---|
|Movement|gate (`TryGetActivity` before `Begin`)|own movement → cancel-and-replan; any other kind → **GateRejected**|
|Skill|`TryInterrupt(caster)`|interruptible holder → pre-empt; non-interruptible holder → **"busy"** failure|
|Dialogue|`TryInterrupt(owner)` then `TryInterrupt(initiator)`|either refuses → **Refused**|
|Status effect|`TryInterrupt(target)` if `effect.Blocks(heldKind)`|non-interruptible holder → no-op + warn|

### Registration sources

|Activity|Registered source|Interruptible?|
|---|---|---|
|Movement|`request.Source` (player or AI)|depends on caller|
|Skill|`ActivitySource.PlayerInputExploration`|yes|
|Dialogue — initiator|`ActivitySource.PlayerInputExploration`|yes|
|Dialogue — owner|`ActivitySource.Ai`|no|

### Resulting behaviour

- **Skill pre-empts a player-driven move** — the move's `OnInterrupt` (its `Cancel`) fires, the move tears down, the skill takes the slot. The canonical interrupt path.
- **An AI mid non-interruptible move cannot also start a skill** — `TryInterrupt` returns `false` on the AI's own move, so the skill fails "busy."
- **You cannot open a dialogue with an NPC executing a non-interruptible `Ai` move** — the owner slot refuses. "Talk to a wandering NPC" therefore requires that NPC's movement to be interruptible.
- **A dialogue-blocking status on the _owner_ does not end the conversation** — the owner side is `Ai` (non-interruptible), so the interrupt no-ops and warns; the same status on the _initiator_ tears the whole conversation down via the shared token.

All of these follow directly from the source-derived interruptibility rule; tuning them is a matter of choosing the source an activity registers under.

---

## 6. MovementService

Single entry point for all movement (player input, AI, cutscene). Enforces eligibility gates, sequences `Plan → Validate → Execute`, registers the running move as an activity, and resolves the awaiting producer with a `MoveResult`. A new request cancels the agent's in-flight move (cancel-and-replan).

### Request flow

```
RequestMove(request, externalCancellation)
  1. unknown agent               → PlanFailed (fail, don't throw)
  2. registry gate               → busy with non-Movement ? GateRejected
  3. status gate                 → Immobilized ? GateRejected
  4. same dest+intent in flight  → AlreadyMoving (leave running, no record)
  5. CancelInFlight(self)        → cancel-and-replan
  6. register InFlight + CTS     → linked to externalCancellation if cancelable
  7. RunPipeline                 → Plan → Evaluate → Execute
  finally: clear slot if still ours, dispose CTS
```

### The registry gate

```csharp
if (_activity.TryGetActivity(request.AgentId, out var heldKind) && heldKind != ActivityKind.Movement)
    return Reject(request.AgentId, GateRejectReason.ActivityConflict);
```

The gate asks "held by anything that isn't _my own_ movement?" The entity's own in-flight move is not a conflict — that is the cancel-and-replan path below. Because the check is kind-agnostic (anything that isn't movement blocks), any new blocking activity blocks movement with no edit to this file.

### Execution & recording

The move registers itself as a `Movement` activity for the duration of `Executor.MoveAlongPath`, routing a registry interrupt back to its own `Cancel`. On return:

```csharp
report.Result switch {
    Completed => MoveResult.Completed(plan.Status, report.DistanceTravelled),
    HaltedByBudget => MoveResult.HaltedByBudget(report.DistanceTravelled),
    Cancelled => MoveResult.Cancelled(report.DistanceTravelled)
}
// Record committed movement only:
if (report.Result is Completed or HaltedByBudget)
    _ledger.Record(agentId, new MovePayload(destination, report.DistanceTravelled));
```

`Cancelled` carries the partial distance walked before the cancel — available to callers but deliberately not recorded (an abandoned half-step is feed noise, and the position change is captured by the snapshot path regardless). The `OperationCanceledException` catch is a safety net; the executor is expected to return a `Cancelled` report itself.

---

## 7. SkillService

Validates a cast, pre-empts movement, awaits interactive target acquisition, applies effects, records.

### Validation chain

All return `ActionResult.Failed` without touching the registry:

```
caster exists → status allows skills → skill known → skill executable
→ AP affordable → (if ammo) ranged weapon equipped → ammo affordable
```

### Pre-empt — honour the result

```csharp
if (!_activity.TryInterrupt(casterId))
    return ActionResult.Failed("Caster is busy with another activity.");
```

A refused interrupt fails the cast cleanly; the skill never overwrites a non-interruptible activity's slot.

### Target acquisition is the awaited collaborator

```csharp
using (_activity.Begin(casterId, ActivityKind.Skill, ActivitySource.PlayerInputExploration, cts.Cancel))
{
    var targetData = await _targetDriver.Acquire(casterId, skill.TargetingStrategy, cts.Token);
    // consume AP / ammo → ApplyEffects → ConsumeUse → StartCooldown → ledger.Record
}
```

`_targetDriver.Acquire` is the interactive boundary. It is resolved against `TargetingPresenter` in the interaction pipeline ([[Action System#9. Interaction Dispatch|§9]]): the player picks targets from the resolved skill area (driven by `SkillAreaService`) while the cast awaits. The skill activity holds the slot for the whole acquisition-plus-resolution window.

### Cancellation

If `Acquire` is cancelled it throws `OperationCanceledException` out of `UseSkill`. The `Begin` scope disposes (slot freed), but `_ledger.Record` is never reached — a cancelled skill records nothing, consistent with the non-cancelled-terminal rule.

### CancelSkill — scoped to actual skills

```csharp
public bool CancelSkill(EntityId casterId) =>
       _activity.TryGetActivity(casterId, out var kind)
       && kind == ActivityKind.Skill
       && _activity.TryInterrupt(casterId);
```

Because the slot is kind-agnostic, `CancelSkill` confirms the held activity _is_ a skill before interrupting — otherwise it would cancel whatever the entity happens to be doing.

---

## 8. DialogueService

A conversation is a durative, multi-entity activity. The service owns the **lock and the lifetime**; `DialoguePresenter` drives the conversation flow.

### Two slots, one token

A conversation locks **both** participants: the initiator (so the player can't walk away mid-line) and the owner NPC (so its AI can't be moved away). Two `Begin` scopes, disposed together, both routing their interrupt to one shared `CancellationTokenSource`:

```csharp
if (!_activity.TryInterrupt(ownerId)) return DialogueResult.Refused;
if (!_activity.TryInterrupt(initiatorId)) return DialogueResult.Refused;   // owner checked first

using var cts = CancellationTokenSource.CreateLinkedTokenSource(token);
// ... subscribe Finished ...
using (_activity.Begin(initiatorId, ActivityKind.Dialogue,
    ActivitySource.PlayerInputExploration, cts.Cancel))
using (_activity.Begin(ownerId, ActivityKind.Dialogue, ActivitySource.Ai,       cts.Cancel))
{
    _conversation.StartOn(start);
    _conversation.Advance();
    try { await finished.Task.AttachExternalCancellation(cts.Token); }
    catch (OperationCanceledException)
	{
		_conversation.Stop();
		return DialogueResult.Cancelled;
	}
	
    _ledger.Record(initiatorId, new ConversedPayload(ownerId));
    return DialogueResult.Completed;
}
```

The **owner is checked first** so a refusal doesn't leave the initiator's move already interrupted for a dialogue that never opens. Pre-empting either participant (or external cancellation) trips the shared `cts`, tearing down the whole conversation and freeing both slots together.

### Presenter drives; service awaits `Finished`

`DialoguePresenter` is the conversation driver: it subscribes to `LineReady` / `Finished`, renders lines, executes embedded commands, and wires the view's choice/advance back into `IConversation.Choose` / `Advance`. The service therefore subscribes **only** to `Finished`, awaits it, and treats cancellation as the only other exit. The two must share one `IConversation` instance ([[Action System#14. Invariants & Edge Cases|§14]]).

### Opaque start token

`StartDialogue(initiatorId, ownerId, object start, token)` takes the Articy start token as `object` and never inspects it — the action system references no Articy types (the reason `IConversation.StartOn` also takes `object`). The token is resolved at the interaction handler ([[Action System#9. Interaction Dispatch|§9]]) and passed straight through. The initiator id is whatever the interaction supplied as `context.Interactor`.

### Results

`DialogueResult { Completed, Cancelled, Refused }`. An entity with no conversation never reaches the service — the resolver returns `false` and the handler never delegates.

### One coarse record

Dialogue's real mutations land _mid-session_ through the presenter's `CommandExecutor` and Articy variable writes, not as a terminal payload. The ledger gets exactly **one** `ConversedPayload(ownerId)` on `Completed`, mirroring movement's skip-on-cancel.

---

## 9. Interaction Dispatch

A click becomes a handled interaction in two stages: a pointer service resolves _what_ was clicked and dispatches it, then an ordered pipeline of handlers decides _what to do_ with it. Targeting, dialogue, and item pickup are all handlers in that pipeline; terrain clicks bypass it and drive movement.

### Pointer resolution and dispatch

`PointerInteractionService` ticks every frame (via the `IUpdate` chain) and owns hover and click:

- **UI first.** If the pointer is over UI, hover is cleared and nothing dispatches — UI is screen-space and always-on-top, so this short-circuits before any ray or physics query is paid for.
- **Hit resolution.** Otherwise it builds a ray (`IRayProvider`), queries every registered `IHitSource`, and keeps the best hit per `IHitArbitrationPolicy.IsBetter`. The winning `InteractionHit` carries an optional `IInteractable`, a distance, an `InteractionLayer` (`Interactable` / `Terrain`), and a world point.
- **Hover.** The resolved interactable receives `OnHoverEnter` / `OnHoverExit` as the current target changes.
- **Confirm.** On the confirm input: an `IInteractable` that is also an `IEntity` is dispatched into the pipeline with `InteractionContext.Default`; a `Terrain` hit instead raises `OnTerrainClicked(worldPoint)` (see below). Hover clears either way.

### Hit sources

`IHitSource.TryHit` is the pluggable producer of hits; several can be registered and arbitrated together.

```csharp
public interface IHitSource { bool TryHit(in RayData ray, Vector2Data screenPosition, out InteractionHit hit); }
```

`PhysicsHitSource` issues a single raycast against the combined interactable + terrain mask, then resolves the result from the collider's layer: an interactable-layer hit walks up for an `IInteractable` (falling through to the terrain check if the collider sits on both masks but exposes no interactable), a terrain-layer hit yields just a world point. The arbitration policy (`IHitArbitrationPolicy`) decides between competing sources — nearest, interactable-over-terrain, and so on.

### The handler pipeline

`InteractionPipeline` sorts its `IInteractionHandler`s by `Order` once at construction and, on `Dispatch`, runs them in order until one's `TryHandle` returns `true` — **first claim wins, the rest are skipped**.

```csharp
public void Dispatch(IEntity target, InteractionContext context)
{
    foreach (var h in _handlers)
        if (h.TryHandle(target, context))
            return;
}
```

`InteractionContext` carries the `Interactor` (the acting entity). `InteractionContext.Default` leaves it empty, and that is what the pointer dispatches — pointer-initiated interactions therefore arrive with no interactor set, and a handler that needs one reads `context.Interactor`.

`Order` encodes precedence:

|Order|Handler|Claims when|Effect|
|---|---|---|---|
|`Targeting` (0)|`TargetingPresenter`|a targeting session is active|selects targets / swallows the click|
|`Dialogue` (100)|`DialogueInteractionHandler`|the target resolves to a conversation|starts the dialogue activity|
|`Pickup` (200)|`ItemPickupService`|the target is an `IItem`|equips to the party leader, records|

Because targeting sits at `Order 0`, an open targeting session intercepts entity clicks before dialogue or pickup can see them; with no session it returns `false` and the click falls through.

### TargetingPresenter — the live end of skill acquisition

This handler is what [[Action System#7. SkillService|§7]]'s awaited target acquisition resolves against. `Begin(caster, strategy, session, completion)` opens a session:

- **Self-target** highlights the caster directly and waits.
- **Single / multi** drive the skill area: `SkillAreaService.BeginTargeting(caster, range)`, subscribe `OnAreaChanged`, and on every change recompute the desired candidate set as `InAreaEntities` filtered by the strategy (excluding the caster for single/multi), diffing it against the currently highlighted set to add and clear highlights.

While a session is open, `TryHandle` claims **every** entity click. Clicking a highlighted candidate adds it via `session.TryAdd` and marks it selected; when the session reports complete it resolves the `UniTaskCompletionSource<TargetData>` and tears down. Clicking a non-candidate entity is still claimed (returns `true`) so stray clicks don't leak through to dialogue or pickup mid-targeting. `End` releases the highlights and ends the skill-area session; `EndIfCurrent` does so only if the supplied completion is the live one, guarding against a stale cancellation tearing down a newer session.

### DialogueInteractionHandler

Resolves the target to a conversation start token and, on success, delegates to `DialogueService` and claims the interaction:

```csharp
public bool TryHandle(IEntity target, InteractionContext context)
{
    if (!_resolver.TryResolve(target, out var start))
        return false;
    _dialogue.StartDialogue(context.Interactor, target.EntityId, start, CancellationToken.None).Forget();
    return true;
}
```

- The handler does **not** call `StartOn` — the service does, after acquiring both locks ([[Action System#8. DialogueService|§8]]).
- The initiator is `context.Interactor`. It passes `CancellationToken.None`, so the conversation's teardown is driven entirely by the registry interrupt callbacks (status, pre-empt), not an external token.
- `TryHandle` claims synchronously while `StartDialogue` may return `Refused` after its await; for player-initiated talk the initiator lock effectively always succeeds, so the click is treated as consumed.

### ItemPickupService

Claims any `IItem`, equips it to the party leader, and records — an instantaneous action with no registry slot, so it is **not** an activity:

```csharp
public bool TryHandle(IEntity target, InteractionContext context)
{
    if (target is not IItem item) return false; // not claimed
    if (_entities.TryGet<IEquipmentAgent>(leaderId, out var equipper)
        && _definitions.TryGet<ItemDefinition>(item.Id, out var def))
    {
        var ammo = item is IAmmoCarrier carrier ? carrier.LoadedAmmo : -1;
        if (equipper.Equipment.TryEquip(def, item.Id, ammo))
        {
            _ledger.Record(leaderId, new PickUpItemPayload(item.Id, ammo));
            _factory.Despawn(item);
        }
    }
    
    return true; // claims any item; records only on equip
}
```

The interaction is claimed for any item (returns `true`), but the record and despawn happen only on a successful `TryEquip`. `ammo` is the carrier's `LoadedAmmo`, or the sentinel `-1` for a non-ammo item. `Drop(agent, at, ct)` is the asynchronous inverse — unequip, spawn the world item, restore its ammo, then record `DropItemPayload` against the dropping agent.

### Terrain clicks → movement

A confirmed terrain hit does not enter the handler pipeline. `PointerInteractionService` raises `OnTerrainClicked(worldPoint)` carrying the already-resolved world point, so movement (or any other subscriber) acts on it without re-raycasting. This is the entry point that turns a ground click into a `MovementRequest`.

---

## 10. Narrative Source

The Articy boundary. The action system sees only `INarrativeSource` / `IConversation`; the concrete `DialogueSource` is the only thing that touches the Articy flow player.

### Contracts

```csharp
interface INarrativeSource { event Action<NarrativeLine> LineReady; event Action Finished; }

interface IConversation : INarrativeSource {
    void StartOn(object start); // start is ArticyRef | IArticyObject | null
    void Advance();
    void Choose(in Choice choice);
    void Stop();
}
```

### DialogueSource

A `MonoBehaviour` wrapping `ArticyFlowPlayer`. Translates flow callbacks into `LineReady` / `Finished`:

- `OnBranchesUpdated` with empty/null branches → `Finished`; otherwise builds a `NarrativeLine` from the paused object (via `ArticyLineFactory`, with `CommandFactory` and `ISpeakerResolver`) and fires `LineReady`.
- `BuildChoices` emits an empty list for ≤1 branch (linear advance) and a `Choice` per valid branch otherwise, labelling from `IObjectWithLocalizableMenuText` → `IObjectWithLocalizableText` → `">>>"`.
- `Stop()` clears branches and `StartOn`, returning the player to a neutral state.

### Speaker resolution

`ISpeakerResolver.TryResolve(flowObj, out EntityId speakerId, out string speakerName)` maps a flow object's speaker to a domain identity and display name. `ArticySpeakerResolver` walks `IEntitySource.All`, matching an entity's `IArticyLinked.ArticyObject.Id` to the speaker, and falls back to display-name-only when no entity is linked. `NullSpeakerResolver` is the no-op default.

### Emission cadence

`DialogueSource` emits one `LineReady` or `Finished` per drive call (`Advance` / `Choose`). `DialoguePresenter` renders each `LineReady` as it arrives without awaiting between lines, so it tolerates an auto-advancing node that produces several lines in quick succession.

---

## 11. Status Effect Integration

`StatusEffectService` is both a _gate_ (queried before activities start) and an _interrupter_ (cancels in-progress activities a new effect forbids).

### As a gate

```csharp
public bool CanStart(EntityId entity, in ActivityQuery query) =>
    !_entities.TryGet(entity, out IActor a) || a.StatusEffects.CanStart(query);
```

Movement's `Immobilized` rejection and skill's "caster cannot use skills" both flow through this. An unknown entity is permissive by design.

### As an interrupter

```csharp
public bool Apply(EntityId target, StatusEffect effect)
{
    if (!_entities.TryGet(target, out IActor actor)) return false;
    if (!actor.StatusEffects.Apply(effect)) return false;

    if (_activity.TryGetActivity(target, out var kind) && effect.Blocks(kind) && !_activity.TryInterrupt(target))
        Log.Warn($"[Status] {effect.Type} could not interrupt protected {kind} on '{target}'.");

    return true;
}
```

One slot per entity means one check: read the held kind, and if the effect blocks that kind, interrupt it. This covers `Dialogue` for free — a dialogue-blocking effect interrupts a held conversation with no extra branch. A `false` return (non-interruptible holder) logs a warning and cancels nothing.

---

## 12. ActionLedger

Append-only history. Each `Record` stamps the actor, the current turn (`TurnCounter.Current`), and an `IActionPayload`, then fires `OnActionRecorded`.

```csharp
public readonly struct ActionRecord { EntityId ActorId; TurnNumber Turn; IActionPayload Payload; }
```

### Role

The ledger drives the **player-facing action feed**. World-state reconstruction is handled by the save/load snapshot path (`IPersistableEntity.Capture` / `Restore` reads and writes live state), so the ledger does not need to capture every mutation — cancelled partials and mid-dialogue variable writes are intentionally omitted. The feed wants committed, presentable outcomes, which is exactly what gets recorded.

### Payloads

|Payload|Source|Recorded when|Carries|
|---|---|---|---|
|`MovePayload`|Movement activity|move `Completed` / `HaltedByBudget`|destination, distance travelled|
|`UseSkillPayload`|Skill activity|skill resolves|skill id, target ids|
|`ConversedPayload`|Dialogue activity|dialogue `Completed`|owner id|
|`PickUpItemPayload`|`ItemPickupService` interaction|successful equip by party leader|prefab id, ammo|
|`DropItemPayload`|`ItemPickupService.Drop`|after unequip + spawn|prefab id, ammo|

For the item payloads, `ammo` is the loaded round count, or `-1` for an item that does not carry ammo.

### Ordering

Records are turn-stamped. Within a single turn, ordering is `List` insertion order.

---

## 13. Request Lifecycle

A movement request, end to end, with the cross-service interactions it can trigger:

```
producer → RequestMove(request)
  ├─ unknown agent → PlanFailed
  ├─ registry: held by non-Movement? → GateRejected(ActivityConflict) ⟵ skill / dialogue holds the slot
  ├─ status: CanStart(Movement)? → GateRejected(Immobilized)
  ├─ same dest+intent in flight? → AlreadyMoving (no record)
  ├─ CancelInFlight(self) → cancel-and-replan (prior move → Cancelled, no record)
  └─ RunPipeline
       Plan ─ unusable ───────────────────────→ PlanFailed
       Evaluate (MovementRuleSet) ─ blocked ──→ GateRejected(rule reason)
       using Begin(Movement, request.Source, Cancel):
         await Executor.MoveAlongPath(path, budget, token)
           ├─ Completed → record MovePayload → MoveResult.Completed
           ├─ HaltedByBudget → record MovePayload → MoveResult.Halted
           └─ Cancelled → (no record) → MoveResult.Cancelled(partial)
```

The ground-click entry point: a terrain click resolves to `OnTerrainClicked(worldPoint)` ([[Action System#9. Interaction Dispatch|§9]]), which a subscriber turns into the `RequestMove` above — no re-raycast, the world point is already resolved.

Cross-service interrupt paths that converge on a move's `cts`:

```
SkillService.UseSkill → TryInterrupt(agent) → move's OnInterrupt = Cancel(agent) → move tears down → skill takes slot
StatusEffectService.Apply (effect blocks Movement) → TryInterrupt(agent) → move cancels
DialogueService.StartDialogue (agent is owner) → TryInterrupt(agent) → AI move cancels (if interruptible) OR Refused
```

Every terminal path routes through `Complete`, so `OnCompleted` fires exactly once per request — `AlreadyMoving` is the one no-op exception (nothing of that request ran).

---

## 14. Invariants & Edge Cases

- **Ownership-checked teardown is mandatory.** Both `ActivityRegistry.Scope.Dispose` and `MovementService`'s in-flight `finally` remove their entry _only if it is still theirs_ (`current == _entry` / `current.Cts == cts`). A superseding activity must never have its slot evicted by the superseded one's teardown.
    
- **`CancelInFlight` does not dispose the CTS.** It cancels and removes the in-flight entry; the awaiting `RequestMove` disposes its own CTS in its `finally`. Disposing in both places would double-dispose.
    
- **Eligibility gates run before cancel-and-replan.** A rejected request must never tear down a healthy in-flight move. Order is: gates → dedup → `CancelInFlight` → register new.
    
- **Dialogue's `finally` is load-bearing.** Cancel, external token, or pre-empt must all unsubscribe `Finished` _and_ call `Stop()`, or the next `StartOn` runs against a flow player with stale subscriptions/branches.
    
- **Shared `IConversation` instance.** `DialoguePresenter` and `DialogueService` must be handed the _same_ `IConversation`. The service's `cts`-driven `Stop()` has to halt the very flow the presenter is rendering; if construction gives them different instances, the lock and the UI drive two unrelated conversations.
    
- **Rule 1 is bookkeeping, not physics.** A superseded activity may keep unwinding for a few frames after its slot is taken. Assume only "slot free ⇒ no _new_ activity is registered," never "slot free ⇒ entity fully idle."
    
- **First claim wins, and order is precedence.** A handler that returns `true` ends dispatch. An open targeting session (`Order 0`) deliberately swallows every entity click — including non-candidates — so nothing leaks through to dialogue or pickup while a skill is being aimed.
    
- **Interaction claim is synchronous; activity outcome is not.** A handler's `TryHandle` returns `true` immediately, while the activity it kicked off (dialogue) resolves later and may refuse. Claiming the interaction does not guarantee the activity started.
    
- **Pointer-dispatched context has no interactor.** The pointer dispatches `InteractionContext.Default`, whose `Interactor` is empty. Handlers that need the acting entity (dialogue's initiator) read it from the context; a non-pointer caller that needs a real interactor must supply one.
    

---

## 15. Cost & Allocation

This is coordination code, not a hot path; it runs on user/AI action, not per frame (the one exception is `PointerInteractionService.Tick`, which does a UI check, at most one ray, and the hit-source queries each frame). There is no GPU work and no per-frame allocation in the activity path itself. The allocations that occur are per-activity:

|Operation|Allocation|
|---|---|
|Each move/skill/dialogue request|one `CancellationTokenSource` (linked if an external token is cancelable)|
|Registry `Begin`|one `Entry` + one `Scope`|
|Dialogue|one `UniTaskCompletionSource` for `Finished`, two `Begin` scopes|
|Each recorded action|one `IActionPayload` + one `ActionRecord` appended to the ledger list|

None are on a per-frame path, so pooling them is not worth the complexity. The one growth to be aware of is the ledger's `List<ActionRecord>`, which accumulates for the session's lifetime.