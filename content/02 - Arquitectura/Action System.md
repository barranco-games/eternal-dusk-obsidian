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

Every activity ends in exactly one disposition. Only **non-cancelled** dispositions record to the ledger, with one exception: a cancelled walk that covered ground records where it stopped ([[Action System#6. MovementService|§6]]).

|Disposition|Records?|Meaning|
|---|---|---|
|Completed|yes|reached natural end (path done, skill resolved, dialogue end-branch)|
|HaltedByBudget|yes (movement)|ran out of movement budget mid-path|
|Cancelled|**no** (movement: yes, if it walked any distance)|superseded, externally cancelled, interrupted, or torn down|
|Refused / GateRejected|**no**|never started — gates or registry refused it|

### ActivitySource

`ActivitySource { PlayerInputExploration, PlayerInputCombat, Ai, Cinematic }`. This single enum answers _who drives the activity_ and, by derivation, _whether it can be interrupted_ ([[Action System#5. Interruptibility & Precedence|§5]]). Player input is interruptible; `Ai` and `Cinematic` are not. Two registrations set the source deliberately instead of reading it off the driver. A conversation's owner NPC registers as `Ai`, so it cannot be pulled out of the conversation ([[Action System#8. DialogueService|§8]]). A player's skill re-registers as `Cinematic` once released, so nothing cuts it short ([[Action System#7. SkillService|§7]]).

---

## 3. Ground Rules

The three rules the system enforces:

1. **An entity holds at most one activity in the registry at a time.** Starting another either supersedes-with-interrupt or is refused, per the central precedence policy ([[Action System#5. Interruptibility & Precedence|§5]]). This is a _bookkeeping_ invariant: the registry holds one slot, but a superseded activity may still be physically unwinding for a few frames after its slot is taken. "One at a time" means "the registry holds one," not "the world contains one."
    
2. **An activity has duration and may be interruptible.** Interruptibility is derived from `ActivitySource`. `Movement` covers path-following; instantaneous displacement such as knockback or scripted shoves is handled as a skill effect on the target, not as a movement activity.
    
3. **An activity records its outcome on reaching a non-cancelled terminal state.** Cancellation records nothing: a cancelled skill aim or conversation never reaches its record ([[Action System#7. SkillService|§7]], [[Action System#12. ActionLedger|§12]]). Movement is the one exception. A walk cancelled (or replanned) after covering ground records the distance walked and where it stopped ([[Action System#6. MovementService|§6]]).
    

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
|Skill|refuse a held `Dialogue`, then `TryInterrupt(caster)`|dialogue → **"not during dialogue"** failure; interruptible holder → pre-empt; non-interruptible holder → **"busy"** failure|
|Dialogue|refuse in combat, then `TryInterrupt(owner)` (when there is one), then `TryInterrupt(initiator)`|in combat, or either refuses → **Refused**|
|Status effect|`TryInterrupt(target)` if `effect.Blocks(heldKind)`|non-interruptible holder → no-op + warn|

### Registration sources

|Activity|Registered source|Interruptible?|
|---|---|---|
|Movement|`request.Source` (player or AI)|depends on caller|
|Skill — aiming|the caller's `source` (default `PlayerInputExploration`; AI turns pass `Ai`, scripted casts `Cinematic`)|player: yes; AI / scripted: no|
|Skill — released (player cast)|`ActivitySource.Cinematic`|no|
|Dialogue — initiator|`ActivitySource.PlayerInputExploration`|yes|
|Dialogue — owner (absent in an ownerless conversation, e.g. an item's)|`ActivitySource.Ai`|no|

### Resulting behaviour

- **Skill pre-empts a player-driven move** — the move's `OnInterrupt` (its `Cancel`) fires, the move tears down, the skill takes the slot. The canonical interrupt path.
- **A released skill cannot be interrupted.** Once targets are in and resources are spent, a player's cast holds its slot as `Cinematic`. Cancel input, a status effect and another skill all find it non-interruptible. Only the aim before release yields.
- **An AI mid non-interruptible move cannot also start a skill** — `TryInterrupt` returns `false` on the AI's own move, so the skill fails "busy."
- **You cannot open a dialogue with an NPC executing a non-interruptible `Ai` move** — the owner slot refuses. "Talk to a wandering NPC" therefore requires that NPC's movement to be interruptible.
- **A dialogue-blocking status on the _owner_ does not end the conversation** — the owner side is `Ai` (non-interruptible), so the interrupt no-ops and warns; the same status on the _initiator_ tears the whole conversation down via the shared token.

All of these follow directly from the source-derived interruptibility rule; tuning them is a matter of choosing the source an activity registers under.

---

## 6. MovementService

Single entry point for all movement (player input, AI, cutscene). Enforces eligibility gates, sequences `Plan → Validate → Execute`, registers the running move as an activity, and resolves the awaiting producer with a `MoveResult`. A new request that plans and passes every gate cancels the agent's in-flight move (cancel-and-replan). A rejected one leaves that move running.

### Request flow

```
RequestMove(request, externalCancellation)
  1. unknown agent               → PlanFailed (fail, don't throw)
  2. registry gate               → busy with non-Movement ? GateRejected
  3. status gate                 → Immobilized ? GateRejected
  4. a dash in flight            → GateRejected(ActivityConflict)
  5. same dest+intent in flight  → AlreadyMoving (leave running, no record)
  6. Plan                        → unusable ? PlanFailed
  7. Evaluate (MovementRuleSet)  → blocked ? GateRejected(rule reason)
  8. CancelInFlight(self)        → cancel-and-replan
  9. register InFlight + CTS     → linked to externalCancellation if cancelable
 10. Execute                     → Begin(Movement) → Executor.MoveAlongPath
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
// Record any walk that covered ground, a cancelled one included, while the agent is still registered:
var walked = report.Result != Cancelled || report.DistanceTravelled > 0f;
if (walked && _agents.ContainsKey(agentId))
    _ledger.Record(agentId, new MovePayload(state.Position, report.DistanceTravelled));
```

`Cancelled` carries the partial distance walked before the cancel. A cancelled walk that covered any ground is recorded like a finished one, and `MovePayload` holds where the agent actually stopped, not where it was sent. Only two cases record nothing: a cancel before the first step, and an agent already unregistered (its body may be gone). The `OperationCanceledException` catch is a safety net that returns `Cancelled(0)` without recording. The executor is expected to return a `Cancelled` report itself.

### Dash — skill-driven movement

`Dash(agentId, route, speedScale, source)` runs a skill's caster along a route the skill has already checked, inside the skill's own activity. It does no planning, gates, budget, `Begin` or ledger entry, and fires no movement events. It sits in the in-flight table like a walk, so unregistering the agent or disposing the service stops it. `Cancel` skips it, and both `RequestMove` and a second `Dash` are refused while it runs (`GateRejected(ActivityConflict)`). Only the agent leaving the game cuts it short. An executor that gives up partway still counts as run (`Completed` with `PlanStatus.Partial`).

---

## 7. SkillService

Validates a cast, pre-empts movement and awaits target acquisition. It then runs the skill's authored sequence (cues, caster movement, strikes) to its end and records.

### Validation chain

All return `ActionResult.Failed` without touching the registry:

```
caster exists → skill known → SkillAvailability.BlockedReason:
    status allows skills → skill executable → not disabled while dying
    → AP affordable → (if ammo) a magazine for this skill → ammo affordable
    → no gated effect would no-op (e.g. Reload on a full magazine)
→ not in a dialogue
```

`SkillAvailability` is shared with the skill bar, so a greyed button is exactly a cast the service would refuse. The refusal strings live in `SkillRefusals`.

### Pre-empt — honour the result

```csharp
if (_activity.TryGetActivity(casterId, out var current) && current == ActivityKind.Dialogue)
    return ActionResult.Failed(SkillRefusals.DuringDialogue);

if (!_activity.TryInterrupt(casterId))
    return ActionResult.Failed(SkillRefusals.Busy);
```

A held conversation refuses the cast outright, even though the initiator's slot is player-driven. A refused interrupt fails the cast cleanly. The skill never overwrites a non-interruptible activity's slot.

### Target acquisition is the awaited collaborator

```csharp
using (_activity.Begin(casterId, ActivityKind.Skill, source, cts.Cancel))
{
    _sequencer.Play(sequence.OnAim, use);
    var driver = DriverFor(skill.Data.Targeting, driverOverride);
    var targetData = await driver.Acquire(casterId, DyingSkills.Targeting(caster, skill), cts.Token);
    // clip to charge / walls → refuse (unaimed ground, AI out of reach, blocked after aim) → Spend AP + ammo
    using var committed = ByPlayer(source) ? _activity.Begin(casterId, ActivityKind.Skill, ActivitySource.Cinematic) : null;
    // OnSkillReleased → _sequencer.Run(steps) → ConsumeUse → StartCooldown → ledger.Record → OnSkillExecuted
}
```

`driver.Acquire` is the interactive boundary. The skill's targeting type picks the driver:
- area skills resolve their own targets (`IAreaTargetDriver`)
- targeted areas spread from a picked epicentre (`TargetedAreaDriver`)
- ground skills pick a point (`GroundTargetDriver`)
- everything else goes through `PlayerTargetDriver`, which resolves against `TargetingPresenter` in the interaction pipeline ([[Action System#9. Interaction Dispatch|§9]]). The player picks targets from the resolved skill area (driven by `SkillAreaService`) while the cast awaits.

A caller such as an AI turn or the scenario harness can pass `driverOverride` to supply targets itself. The aim spans frames, so availability and the player's turn are checked again once targets are in. AP and ammo are spent together or not at all. The skill activity holds the slot for the whole acquisition-plus-resolution window.

### Release and the skill sequence

Once resources are spent the cast is **released**. A player's cast re-registers its slot as `Cinematic`, superseding its own entry without `TryInterrupt`. From then on nothing can interrupt it: not cancel input, not a status effect, not another skill. `SkillSequencer` then runs the steps authored on the skill's `SkillSequence`, in order:
- cue steps go to `ISkillCuePlayer` (VFX, audio, pose)
- projectile and wait steps await the game clock
- `MoveCasterStep` dashes the caster through `MovementService.Dash` ([[Action System#6. MovementService|§6]])
- each `StrikeStep` resolves the skill's effects with one hit roll per target and raises `OnSkillHit` per target

The released steps take no cancellation token. Only the caster leaving the game mid-move stops the sequence (`CasterLeft` failure, nothing recorded). Every release ends in exactly one of `OnSkillExecuted` or `OnSkillCancelled`, even when an effect throws.

### Cancellation

Only the aim can be cancelled. If `Acquire` is cancelled, the service raises `OnSkillCancelled`, plays the sequence's `OnCancel` cues and rethrows `OperationCanceledException` out of `UseSkill`. The `Begin` scope disposes (slot freed), but `_ledger.Record` is never reached. A cancelled skill records nothing, consistent with the non-cancelled-terminal rule. A refusal after the aim takes the same cancel path and returns `ActionResult.Failed` without spending anything. Those refusals are: no ground point, an AI target out of range or sight, blocked after aim, or resources short.

### CancelSkill — scoped to actual skills

```csharp
public bool CancelSkill(EntityId casterId) =>
       _activity.TryGetActivity(casterId, out var kind)
       && kind == ActivityKind.Skill
       && _activity.TryInterrupt(casterId);
```

Because the slot is kind-agnostic, `CancelSkill` confirms the held activity _is_ a skill before interrupting — otherwise it would cancel whatever the entity happens to be doing. After release the slot is `Cinematic` and `CancelSkill` returns `false`, so it cancels an aim, never a released cast.

---

## 8. DialogueService

A conversation is a durative, multi-entity activity. The service owns the **lock and the lifetime**; `DialoguePresenter` drives the conversation flow.

### Two slots, one token

A conversation locks **both** participants: the initiator (so the player can't walk away mid-line) and the owner NPC (so its AI can't be moved away). Two `Begin` scopes, disposed together, both route their interrupt to one shared `CancellationTokenSource`. An empty `ownerId` means nobody is on the other side, as in an item's conversation; it locks only the initiator and records nothing. No conversation opens during combat:

```csharp
var owned = !ownerId.IsEmpty;
if (_gameMode.InCombat || (owned && !_activity.TryInterrupt(ownerId)) || !_activity.TryInterrupt(initiatorId))
    return DialogueResult.Refused;   // owner checked first

using var cts = CancellationTokenSource.CreateLinkedTokenSource(token);
// ... subscribe Finished (unsubscribed in finally) ...
using (_activity.Begin(initiatorId, ActivityKind.Dialogue,
    ActivitySource.PlayerInputExploration, cts.Cancel))
using (owned ? _activity.Begin(ownerId, ActivityKind.Dialogue, ActivitySource.Ai, cts.Cancel) : null)
{
    _conversation.StartOn(start, ownerId);   // the flow player walks into the first line itself
    try { await finished.Task.AttachExternalCancellation(cts.Token); }
    catch (OperationCanceledException)
	{
		_conversation.Stop();
		return DialogueResult.Cancelled;
	}
	
    if (owned)
        _ledger.Record(initiatorId, new ConversedPayload(ownerId));
    return DialogueResult.Completed;
}
```

The **owner is checked first** so a refusal doesn't leave the initiator's move already interrupted for a dialogue that never opens. Pre-empting either participant (or external cancellation) trips the shared `cts`, tearing down the whole conversation and freeing both slots together.

### Presenter drives; service awaits `Finished`

`DialoguePresenter` is the conversation driver: it subscribes to `LineReady` / `Finished`, renders lines, executes embedded commands, and wires the view's choice/advance back into `IConversation.Choose` / `Advance`. The service therefore subscribes **only** to `Finished`, awaits it, and treats cancellation as the only other exit. The two must share one `IConversation` instance ([[Action System#14. Invariants & Edge Cases|§14]]).

### Opaque start token

`StartDialogue(initiatorId, ownerId, object start, token)` takes the Articy start token as `object` and never inspects it — the action system references no Articy types (the reason `IConversation.StartOn` also takes `object`). The owner id goes on to `StartOn`, so the owner's lines land on that entity and not on a lookalike that shares its Articy speaker ([[Action System#10. Narrative Source|§10]]). The token is resolved at the interaction handler ([[Action System#9. Interaction Dispatch|§9]]) and passed straight through. The initiator id is whatever the interaction supplied as `context.Interactor`.

### Results

`DialogueResult { Completed, Cancelled, Refused, NoConversation }`. The service returns only the first three; `NoConversation` is declared but never used. An entity with no conversation never reaches the service — the resolver returns `false` and the handler never delegates.

### One coarse record

Dialogue's real mutations land _mid-session_ through the presenter's `CommandExecutor` and Articy variable writes, not as a terminal payload. The ledger gets exactly **one** `ConversedPayload(ownerId)` on `Completed` when there is an owner, and nothing on cancel.

### Scripted conversations

`PlayScripted(start, token)` plays a conversation nobody walked up to: a beat owned by an encounter (`DialoguePhase`). It has no initiator or owner, so it claims no activity and records nothing. It subscribes to `Finished` and calls `StartOn`. On cancellation it calls `Stop()` and returns `Cancelled`.

### Input while a conversation is open

`DialogueInputLock` holds player input from a conversation's first `LineReady` until `Finished`. `ConversationWalkHold` freezes a walk already under way when a conversation opens and resumes it on close. Walks the conversation itself orders, and skill dashes, keep running.

---

## 9. Interaction Dispatch

A click becomes a handled interaction in two stages: a pointer service resolves _what_ was clicked and dispatches it, then an ordered pipeline of handlers decides _what to do_ with it. Targeting, dialogue, and item pickup are all handlers in that pipeline; terrain clicks bypass it and drive movement.

### Pointer resolution and dispatch

`PointerInteractionService` ticks every frame (via the `IUpdate` chain) for hover, and handles the confirm input as an event:

- **Focus and UI first.** While the window is unfocused, hover clears and the click that restores focus is swallowed, because a backgrounded window reads the pointer as (0, 0). If the pointer is outside the window or over UI, hover is cleared and nothing dispatches. UI is screen-space and always-on-top, so this short-circuits before any ray or physics query is paid for.
- **Hit resolution.** Otherwise it builds a ray (`IRayProvider`), queries every registered `IHitSource`, and keeps the best hit per `IHitArbitrationPolicy.IsBetter`. The winning `InteractionHit` carries an optional `IInteractable`, a distance, an `InteractionLayer` (`Interactable` / `Terrain`), and a world point.
- **Hover.** The resolved interactable receives `OnHoverEnter` / `OnHoverExit` as the current target changes.
- **Confirm.** On the confirm input the hit is resolved again at the pointer's current position. An `IInteractable` that is also an `IEntity` is dispatched into the pipeline with `new InteractionContext(party leader)`, and hover clears. A `Terrain` hit instead raises `OnTerrainClicked(worldPoint)` (see below).

### Hit sources

`IHitSource.TryHit` is the pluggable producer of hits; several can be registered and arbitrated together.

```csharp
public interface IHitSource { bool TryHit(in RayData ray, Vector2Data screenPosition, out InteractionHit hit); }
```

`PhysicsHitSource` issues a single non-allocating raycast (all hits) against the combined interactable + terrain mask. It keeps the nearest hit it can resolve from the collider's layer, and drops that hit when scenery in front hides it, unless the point lies inside that scenery (as an item on a shelf does): an interactable-layer hit walks up for an `IInteractable` (falling through to the terrain check if the collider sits on both masks but exposes no interactable), a terrain-layer hit yields just a world point. The arbitration policy (`IHitArbitrationPolicy`) decides between competing sources — nearest, interactable-over-terrain, and so on.

### The handler pipeline

`InteractionPipeline` sorts its `IInteractionHandler`s by `Order` once at construction and, on `Dispatch`, runs them in order until one's `TryHandle` returns `true` — **first claim wins, the rest are skipped**.

```csharp
public bool Dispatch(IEntity target, InteractionContext context)
{
    for (var i = 0; i < _handlers.Length; i++)
        if (_handlers[i].TryHandle(target, context))
            return true;
    return false;
}
```

`InteractionContext` carries the `Interactor` (the acting entity). The pointer dispatches with the party leader as interactor, and a handler that needs the acting entity reads `context.Interactor`.

`Order` encodes precedence:

|Order|Handler|Claims when|Effect|
|---|---|---|---|
|`Targeting` (0)|`TargetingPresenter`|a targeting session is active|selects targets / swallows the click|
|`Dialogue` (100)|`DialogueInteractionHandler`|the target resolves to a conversation|walks into talk range if needed, then starts the dialogue activity|
|`Pickup` (200)|`ItemPickupService`|the target is an `IItem`|walks the party leader into reach if needed, then equips or consumes the item and records|

Because targeting sits at `Order 0`, an open targeting session intercepts entity clicks before dialogue or pickup can see them; with no session it returns `false` and the click falls through.

The pipeline is also an `IInteractionApproach`. `TryGetApproach` asks the handlers, in the same order, where the interactor would walk before acting, without starting anything, so the move preview can draw the walk a click on an NPC or item would make. Targeting is passed over, since it claims only while a skill aims.

### TargetingPresenter — the live end of skill acquisition

This handler is what [[Action System#7. SkillService|§7]]'s awaited target acquisition resolves against. `Begin(caster, strategy, session, completion)` opens a session:

- **Self-target** highlights the caster directly and waits.
- **Single / multi** drive the skill area: `SkillAreaService.BeginTargeting(caster, range)`, subscribe `OnAreaChanged`, and on every change recompute the desired candidate set as `InAreaEntities` filtered by the strategy (excluding the caster for single/multi), diffing it against the currently highlighted set to add and clear highlights.
- **Area / ground** strategies drive the same skill area. A click on any highlighted entity confirms an area aim, and a ground skill lands at the clicked entity's position when it is in range. Clicking an already-picked target settles for the targets picked so far.

While a session is open, `TryHandle` claims **every** entity click. Clicking a highlighted candidate adds it via `session.TryAdd` and marks it selected; when the session reports complete it resolves the `UniTaskCompletionSource<TargetData>` and tears down. Clicking a non-candidate entity is still claimed (returns `true`) so stray clicks don't leak through to dialogue or pickup mid-targeting. `End` releases the highlights and ends the skill-area session; `EndIfCurrent` does so only if the supplied completion is the live one, guarding against a stale cancellation tearing down a newer session.

### DialogueInteractionHandler

Resolves the target to a conversation start token and, on success, claims the interaction. If the interactor is within the target's talk range (`IConversationOwner.TalkRange`, default 2.5 m, planar), it delegates to `DialogueService` at once. Otherwise it first walks the interactor to 80% of that range with a `PlayerInputExploration` move, and talks only if the walk completes in reach:

```csharp
public bool TryHandle(IEntity target, InteractionContext context)
{
    if (_sceneLifetime.IsCancellationRequested || !_resolver.TryResolve(target, out var start))
        return false;
    if (!_entities.TryGet(context.Interactor, out var interactor)) return true;
    if (InReach(interactor, target)) Talk(interactor, target, start);
    else ApproachAndTalk(interactor, target, start).Forget();
    return true;
}
```

- The handler does **not** call `StartOn` — the service does, after acquiring both locks ([[Action System#8. DialogueService|§8]]).
- The initiator is `context.Interactor`. The handler passes a scene-lifetime token, cancelled when the scene container disposes the handler, so an open conversation closes on unload. Otherwise teardown is driven by the registry interrupt callbacks (status, pre-empt). A click elsewhere during the approach cancels the walk, and the conversation with it.
- `TryHandle` claims synchronously, while `StartDialogue` may still return `Refused` (in combat, or against a non-interruptible owner). The click is consumed even when no conversation opens.

### ItemPickupService

Claims any `IItem` for the party leader. The pickup itself is an instantaneous action with no registry slot, so it is **not** an activity, but reaching the item may take a movement activity:

- **Refusals first.** These cases raise `Refused(picker, prefab, PickUpRefusal)` and still claim the click: an unknown item definition, a turn on which the player may not act, full hands (equipment), or nobody to fire the ammo (consumables).
- **Reach.** Within 1.5 m planar and 1.5 m in height, the item is taken at once. Otherwise the leader walks to the first reachable stop out of up to four candidates near the item, and takes it on arrival. A cancelled walk drops the pickup silently; failing to arrive refuses with `OutOfReach`.
- **Take.** An equipment item is `TryEquip`ped with its `LoadedAmmo` (`-1` for a non-ammo item). A `ConsumedOnPickup` item adds its ammo supply to a ranged carrier and grants its skills. On success the service records `PickUpItemPayload(prefabId, ammo)`, plays the pickup sound and despawns the item. An item with a dialogue plays it through `DialogueService.StartDialogue` with no owner. It plays before the pickup, and a cancelled conversation abandons the pickup; an item flagged `DialogueAfterPickup` plays it 0.3 s after instead.

`Drop(agent, at, ct, item)` is the asynchronous inverse. It spawns the world item, then unequips (despawning the spawn if that fails), restores its ammo, and records `DropItemPayload` against the dropping agent.

### Terrain clicks → movement

A confirmed terrain hit does not enter the handler pipeline. `PointerInteractionService` raises `OnTerrainClicked(worldPoint)` carrying the already-resolved world point, so movement (or any other subscriber) acts on it without re-raycasting. `GroundClickMovementInput` is the subscriber that turns a ground click into a `MovementRequest` for the party leader. While an area skill awaits confirmation, `ConfirmedAreaTargetDriver` also listens and treats a terrain click as the confirm.

---

## 10. Narrative Source

The Articy boundary. The action system sees only `IConversation`; the concrete `DialogueSource` is the only thing that touches the Articy flow player.

### Contracts

```csharp
interface IConversation {
    event Action<NarrativeLine> LineReady;
    event Action Finished;
    bool IsOpen { get; }
    NarrativeLine Current { get; }   // the line on screen, or null
    void StartOn(object start, EntityId owner = default); // start is ArticyRef | IArticyObject | null
    void Advance();
    void Choose(in Choice choice);
    void Stop();
}
```

### DialogueSource

A `MonoBehaviour` wrapping `ArticyFlowPlayer`. Translates flow callbacks into `LineReady` / `Finished`:

- `OnBranchesUpdated` with empty/null branches → `Finished`. Otherwise it builds a `NarrativeLine` from the paused object (via `ArticyLineFactory`, with `CommandFactory`, `ISpeakerResolver` and the conversation's owner), fires `LineReady` and keeps a copy as `Current`. A language change re-emits the current line flagged `Rebuilt`.
- `BuildChoices` emits an empty list for ≤1 branch (linear advance) and a `Choice` per valid branch otherwise, labelling from `IObjectWithLocalizableMenuText` → `IObjectWithLocalizableText` → `">>>"`.
- `Stop()` clears branches, `Current` and `StartOn`, returning the player to a neutral state, and fires `Finished`.

### Speaker resolution

`ISpeakerResolver.TryResolve(flowObj, intended, out EntityId speakerId, out string speakerName, out string speakerTechnicalName)` maps a flow object's speaker to a domain identity, display name and technical name. `ArticySpeakerResolver` walks `IEntitySource.All`, matching an entity's `IArticyLinked.ArticyObject.Id` to the speaker. When several entities share the speaker, `intended` (the conversation's owner) wins; failing that, the one nearest the party leader does. With no entity linked it falls back to the Articy names alone.

### Emission cadence

`DialogueSource` emits one `LineReady` or `Finished` per drive call (`Advance` / `Choose`). It also emits the first line when `StartOn` is assigned, because the flow player walks into it by itself; this is why the service does not call `Advance` after `StartOn`. `DialoguePresenter` renders each `LineReady` as it arrives, without awaiting between lines; a new line ends any text reveal still running. It therefore tolerates an auto-advancing node that produces several lines in quick succession.

---

## 11. Status Effect Integration

`StatusEffectService` is both a _gate_ (queried before activities start) and an _interrupter_ (cancels in-progress activities a new effect forbids).

### As a gate

```csharp
public bool CanStart(EntityId entity, in ActivityQuery query) =>
    !_entities.TryGet(entity, out IActor a) || a.StatusEffects.CanStart(query);
```

Movement's `Immobilized` rejection flows through this. Skill's "caster cannot use skills" asks the same `StatusEffects.CanStart` directly on the caster, through `SkillAvailability` ([[Action System#7. SkillService|§7]]). An unknown entity is permissive by design.

### As an interrupter

```csharp
public bool Apply(EntityId target, StatusEffect effect)
{
    if (!_entities.TryGet(target, out IActor actor)) return false;
    if (!actor.StatusEffects.Apply(effect)) return false;

    if (_activity.TryGetActivity(target, out var kind) && effect.Blocks(kind) && !_activity.TryInterrupt(target))
        Log.Warn(() => $"{effect.Type} could not interrupt protected {kind} on '{target}'.");

    return true;
}
```

One slot per entity means one check: read the held kind, and if the effect blocks that kind, interrupt it. This covers `Dialogue` for free — a dialogue-blocking effect interrupts a held conversation with no extra branch. A `false` return (non-interruptible holder) logs a warning and cancels nothing.

---

## 12. ActionLedger

Append-only history, bounded: a ring of the newest `ActionLedger.Capacity` (64) records, which overwrites the oldest first. Each `Record` stamps the actor, the current turn (`TurnCounter.Current`), and an `IActionPayload`, then fires `OnActionRecorded(actorId)`. `Records` reads the window oldest first.

```csharp
public readonly struct ActionRecord { EntityId ActorId; TurnNumber Turn; IActionPayload Payload; }
```

### Role

The ledger drives the **player-facing action feed**. World-state reconstruction is handled by the save/load snapshot path (`IPersistableEntity.Capture` / `Restore` reads and writes live state), so the ledger does not need to capture every mutation — cancelled aims and conversations and mid-dialogue variable writes are intentionally omitted. The feed wants committed, presentable outcomes, which is exactly what gets recorded.

### Payloads

|Payload|Source|Recorded when|Carries|
|---|---|---|---|
|`MovePayload`|Movement activity|move `Completed` / `HaltedByBudget`, or `Cancelled` after walking some distance|end position (where it stopped), distance travelled|
|`UseSkillPayload`|Skill activity|a released skill runs its sequence to the end|skill id, target ids, damage dealt, health healed, damage types, missed targets, status outcomes (landed / resisted)|
|`ConversedPayload`|Dialogue activity|a dialogue with an owner `Completed`|owner id|
|`PickUpItemPayload`|`ItemPickupService` interaction|the party leader equips or consumes the item|prefab id, ammo|
|`DropItemPayload`|`ItemPickupService.Drop`|after unequip + spawn|prefab id, ammo|

For the item payloads, `ammo` is the loaded round count, or `-1` for an item that does not carry ammo.

### Ordering

Records are turn-stamped. Within a single turn, ordering is insertion order; past 64 records the oldest drop out.

---

## 13. Request Lifecycle

A movement request, end to end, with the cross-service interactions it can trigger:

```
producer → RequestMove(request)
  ├─ unknown agent → PlanFailed
  ├─ registry: held by non-Movement? → GateRejected(ActivityConflict) ⟵ skill / dialogue holds the slot
  ├─ status: CanStart(Movement)? → GateRejected(Immobilized)
  ├─ dash in flight? → GateRejected(ActivityConflict)
  ├─ same dest+intent in flight? → AlreadyMoving (no record)
  ├─ Plan ─ unusable ───────────────────────→ PlanFailed
  ├─ Evaluate (MovementRuleSet) ─ blocked ──→ GateRejected(rule reason)
  ├─ CancelInFlight(self) → cancel-and-replan (prior move → Cancelled, records its partial walk)
  └─ Execute
       using Begin(Movement, request.Source, Cancel):
         await Executor.MoveAlongPath(path, budget, token)
           ├─ Completed → record MovePayload → MoveResult.Completed
           ├─ HaltedByBudget → record MovePayload → MoveResult.HaltedByBudget
           └─ Cancelled → record MovePayload if any distance walked → MoveResult.Cancelled(partial)
```

The ground-click entry point: a terrain click resolves to `OnTerrainClicked(worldPoint)` ([[Action System#9. Interaction Dispatch|§9]]), which a subscriber turns into the `RequestMove` above — no re-raycast, the world point is already resolved.

Cross-service interrupt paths that converge on a move's `cts`:

```
SkillService.UseSkill → TryInterrupt(agent) → move's OnInterrupt = Cancel(agent) → move tears down → skill takes slot
StatusEffectService.Apply (effect blocks Movement) → TryInterrupt(agent) → move cancels
DialogueService.StartDialogue (agent is owner) → TryInterrupt(agent) → AI move cancels (if interruptible) OR Refused
```

Every terminal path routes through `Complete`, so `OnCompleted` fires exactly once per request — `AlreadyMoving` is the one no-op exception (nothing of that request ran). A skill's `Dash` fires no movement events at all.

---

## 14. Invariants & Edge Cases

- **Ownership-checked teardown is mandatory.** Both `ActivityRegistry.Scope.Dispose` and `MovementService`'s in-flight `finally` remove their entry _only if it is still theirs_ (`current == _entry` / `current.Cts == cts`). A superseding activity must never have its slot evicted by the superseded one's teardown.
    
- **`CancelInFlight` does not dispose the CTS.** It cancels and removes the in-flight entry; the awaiting `RequestMove` disposes its own CTS in its `finally`. Disposing in both places would double-dispose.
    
- **A released skill is never cancelled.** Only the aim yields. After release a player's cast holds a `Cinematic` slot, its sequence steps take no token, and its dash ignores `Cancel` and refuses competing moves. Only the caster leaving the game stops it. A cut-short skill gets no refund path; the rule is to close the cancel path instead.
    
- **Eligibility gates run before cancel-and-replan.** A rejected request must never tear down a healthy in-flight move. Order is: registry and status gates → dash / dedup → plan → rule gates → `CancelInFlight` → register new.
    
- **Dialogue's `finally` is load-bearing.** Cancel, external token, or pre-empt must all unsubscribe `Finished` _and_ call `Stop()`, or the next `StartOn` runs against a flow player with stale subscriptions/branches.
    
- **Shared `IConversation` instance.** `DialoguePresenter` and `DialogueService` must be handed the _same_ `IConversation`. The service's `cts`-driven `Stop()` has to halt the very flow the presenter is rendering; if construction gives them different instances, the lock and the UI drive two unrelated conversations.
    
- **Rule 1 is bookkeeping, not physics.** A superseded activity may keep unwinding for a few frames after its slot is taken. Assume only "slot free ⇒ no _new_ activity is registered," never "slot free ⇒ entity fully idle."
    
- **First claim wins, and order is precedence.** A handler that returns `true` ends dispatch. An open targeting session (`Order 0`) deliberately swallows every entity click — including non-candidates — so nothing leaks through to dialogue or pickup while a skill is being aimed.
    
- **Interaction claim is synchronous; activity outcome is not.** A handler's `TryHandle` returns `true` immediately, while the activity it kicked off (dialogue) resolves later and may refuse. Claiming the interaction does not guarantee the activity started.
    
- **Pointer-dispatched context carries the party leader.** The pointer dispatches `new InteractionContext(leaderId)`. Handlers that need the acting entity (dialogue's initiator) read it from the context. When the interactor resolves to no entity, the dialogue handler still claims the click and does nothing. Item pickup ignores the context and always acts for the party leader.
    

---

## 15. Cost & Allocation

This is coordination code, not a hot path; it runs on user/AI action, not per frame (the one exception is `PointerInteractionService.Tick`, which does a UI check, at most one ray, and the hit-source queries each frame). There is no GPU work and no per-frame allocation in the activity path itself. The allocations that occur are per-activity:

|Operation|Allocation|
|---|---|
|Each move/skill/dialogue request|one `CancellationTokenSource` (linked if an external token is cancelable)|
|Registry `Begin`|one `Entry` + one `Scope`|
|Dialogue|one `UniTaskCompletionSource` for `Finished`, one `Begin` scope per participant (two with an owner)|
|Each recorded action|one `IActionPayload`; the `ActionRecord` struct is written into the ledger's fixed 64-slot ring|

None are on a per-frame path, so pooling them is not worth the complexity. The ledger does not grow: it keeps the newest 64 records and overwrites the oldest.