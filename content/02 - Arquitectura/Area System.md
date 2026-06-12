## Table of Contents

- [[Area System#1. Overview|Overview]]
- [[Area System#2. Core Concepts|Core Concepts]]
- [[Area System#3. World Grid & Chunk System|World Grid & Chunk System]]
- [[Area System#4. Height & Vision Model|Height & Vision Model]]
- [[Area System#5. Area Pipeline|Area Pipeline]]
- [[Area System#6. AreaCore & AreaDefinition|AreaCore & AreaDefinition]]
- [[Area System#7. QueryBatch|QueryBatch]]
- [[Area System#8. Area Types|Area Types]]
- [[Area System#9. Rendering|Rendering]]
- [[Area System#10. Fog of War|Fog of War]]
- [[Area System#11. Vision Area|Vision Area]]
- [[Area System#12. Skill Area|Skill Area]]
- [[Area System#13. Revealers & Revealables|Revealers & Revealables]]
- [[Area System#14. Frame Lifecycle|Frame Lifecycle]]
- [[Area System#15. Performance|Performance]]
- [[Area System#16. Memory Budget|Memory Budget]]

---

## 1. Overview

The Area System is a GPU-accelerated spatial query framework responsible for computing and rendering all grid-based areas: fog of war, unit vision, skill targeting areas, and (planned) elemental spread and movement range.

It operates on a chunked 2.5D heightfield grid, persists fog data per save slot via memory-mapped files, and exposes a clean event-based API to the rest of the game.
### Design Goals

- **Correctness at scale** — 10,240 × 10,240 cell world, no global recompute on mutation
- **Zero runtime allocation** — all hot-path allocations eliminated
- **Predictable frame cost** — query budget enforced per batch
- **Declarative configuration** — area behaviour expressed as data, not subclasses

---

## 2. Core Concepts

### Grid Constants

```
Cell size:        0.1 Unity units  (GridConstants.CellSize)
Chunk size:       128 × 128 cells  (ChunkSize; ChunkCellCount = 16384)
Chunk world size: 12.8 Unity units
World origin:     (-512, 0, -512)
Grid:             80 × 80 chunks
Active region:    5 × 5 chunks (ActiveRadius = 2)
Max sight range:  100 cells (DerivedStats base value)
Max fog range:    150 cells
Skill max range:  100 cells (SkillMaxRange)
```

### Coordinate System

- Cell coords are 0-based relative to world origin (subtracted in `FloorToCell`)
- Chunk coords derived via `GridMath.FloorDiv` — handles negative values correctly
- `WorldGrid` uses `ChunkOriginX/Y` to offset chunk coords to array indices
- All `WorldGrid` array accesses use `LocalX`/`LocalY` helpers — critical for negative-origin worlds
- `GlobalTileStreamer` converts world chunk coords to file-local coords via `ToFileCoord`

### Camera Focus Point

Active chunk region centers on the camera focus point. `ChunkManager` fires `OnCameraChunkChanged` on chunk boundary crossing.

---

## 3. World Grid & Chunk System

### Cell Data Encoding

|Bits|Field|Encoding|
|---|---|---|
|0–15|Floor height|Fixed point, 1 unit = 100 counts|
|16|Walkable flag|1 = walkable|
|17–31|Reserved||

`VoidCell = 0x0000_0000`. Shader floor height = `(cell & 0xFFFF) * 0.01 / 0.1`.

### GridChunk Pooling

- Pre-warmed with 25 instances at startup
- `Initialize(chunkCoord)` — clears static cells only on coord mismatch
- `Reset()` — clears dynamic overlay and `_blockedCells`, preserves baked data for coord-matched reuse
- `_hasBakedData` + `_bakedCoord` — track validity across pool reuse

### GridChunk.GetMergeBuffer — zero-copy fast path

`SetDynamicBlocked` maintains a `List<int> _blockedCells` of blocked indices.

- When `_blockedCells.Count == 0`, `GetMergeBuffer()` returns `_staticCells` **directly** — no copy, no per-cell merge (both `ChunkManager` call sites are read-only).
- Otherwise it `Array.Copy`s static into the merge buffer and clears the walkable bit only on the blocked indices.

This replaced the previous unconditional full-buffer merge.

### Obstacle Bake — Synchronous Drain Model

Bakes are scheduled on the job system and drained on the main thread — no `UniTaskVoid` polling, no async state machine, no per-chunk `CancellationToken`.

`ChunkManager.Update(focusPosition)`:

1. `FlushDirtyChunks` — re-uploads runtime geometry changes, fires `OnChunkDirty`
2. `DrainPendingBakes` — scans completed bakes, finalizes them
3. On camera chunk change: `UpdateActiveRegion` (deactivate out-of-range) + `OnCameraChunkChanged`
4. `ActivatePendingChunks`

`ActivatePendingChunks`:

- Ready chunks (already baked, non-void) → `ActivateReady` immediately
- Void chunks → schedule a bake job into `_pendingBakes` (`List<PendingBake>`) and `_bakingChunks` (`HashSet`)

`PendingBake` is a `readonly struct { Int2Data Coord; IBakeJob Job; }`.

`DrainPendingBakes` iterates `_pendingBakes`, and for each `job.IsComplete`:

- Removes from `_pendingBakes` / `_bakingChunks`
- If the chunk is no longer desired (or disposed) → reset + return the job to the pool, skip
- Else `chunk.CopyBakedDataFrom(job)`, return the job, `ActivateReady`

`ActivateReady` uploads the merge buffer to a GPU obstacle buffer, marks the chunk clean, and fires `OnChunkActivated`.

`Update` stays synchronous — it schedules and drains, never blocks.

### Bake Job & Buffer Pooling

**`UnityBakeJobFactory`** — pre-warmed with 25 jobs. Each `UnityBakeJob` allocates its `Allocator.Persistent` `NativeArray`s once at construction. `Reset()` prepares for reuse.

**`UnityObstacleBufferFactory`** — pre-warmed with 25 buffers. Each holds a `ComputeBuffer` reused via `Reinitialize(coord)` — never disposed between uses.

Both factories implement `IDisposable` and dispose all pooled instances at teardown.

---

## 4. Height & Vision Model

### Sightline Test (2.5D DDA, layered)

Shadowcast marches a DDA line per cell, testing against two layers:

- **Terrain** — floor-height occlusion (`marchFloorH > sightlineH`)
- **Obstacle** — discrete blockers (walls) that occlude regardless of height

```hlsl
sightlineH = lerp(revealerEyeH, targetFloorH, t / dist)
blocked = (marchFloorH > sightlineH) || obstacleHit
```

Revealer eye height = floor height + 1.8 Unity units.

### Output Mask Addressing

```hlsl
// Shadowcast write — row-major (local to the query's own diameter)
uint bitIndex = localY * diameter + localX;     // diameter = 2*radius + 1

// Explored / vision state — column-major
int bitIndex = chunkLocalX * ChunkSize + chunkLocalY;
```

`AreaVisibilityTracker` and the local-area blit both decode the shadowcast mask **row-major at the query diameter**.

### Multi-Revealer Mask

The merge kernel ORs all query slots into one merge target starting at index 0. Each query in `result.Queries` keeps its own center and radius; the bit offset within the merged mask is always relative to index 0 (no `slotStart` offset — merge has already combined the slots).

### Cross-Chunk Neighbourhood

`CrossChunkQueryBuilder` — one instance per `ShadowcastProcessor` (not shared between batches).

---

## 5. Area Pipeline

### AreaService

Central coordinator — owns all area-system wiring for a scene. Initialized by `AreaInstaller`.

**Setup methods (called in order):**

- `SetupGlobalBatch` — creates the global `QueryBatch` + `ShadowcastProcessor`
- `SetupLocalBatch` — creates the local `QueryBatch` + `ShadowcastProcessor`
- `SetupFogOfWar` — fog renderer (own `AreaMeshBuilder`, `ownsStaticData: true`, `subscribeMeshEvents: true`), resolver, streamer, working buffer, savable; `RevealableRegistrar.SetAreas({fogDefinition})`
- `SetupVisionArea` — vision renderer (own `AreaMeshBuilder`, `ownsStaticData: true`, `subscribeMeshEvents: true`), resolver, revealer source
- `SetupSkillArea` — creates `SkillAreaService` (local batch, converter, entity source, chunk manager, **`RevealableRegistrar`**, blit shader, skill material, world origin, `SkillMaxRange`)

**Fog and vision each own a separate `AreaMeshBuilder`.** They were previously a single shared builder; sharing caused a one-frame "old texture on new mesh" flicker on region shift because the two renderers resolve on independent GPU schedules and would move the shared mesh out from under each other. Separate meshes (~26 MB each, accepted) removed the flicker.

**`IAreaService`** (Systems) exposes `ISkillAreaService SkillAreaService`.

### AreaPipeline

```
ProcessFrame()
  → LocalAreaContext.TryShift(cameraCell)
  → ChunkManager.Update(focusPosition)
  → foreach batch: batch.ProcessFrame(cameraCell)
```

### QueryBatch instances

- **Global** — fog + vision, `SlotSize = ComputeSlotSize(150)`, `MaxSlots = 32`
- **Local** — skill area, `SlotSize = ComputeSlotSize(SkillMaxRange = 100)`, `MaxSlots = 32`

`ComputeSlotSize(r) = ((2r+1)² + 31) / 32` uints.

---

## 6. AreaCore & AreaDefinition

### AreaCore Dirty States

```
Clean → DirtyOnce → Clean      (position change, one update)
Clean/DirtyOnce → Continuous   (never cleared by QueryBatch)
```

`ClearDirty` is a no-op when state is `Continuous`. Fog and skill use `DirtyOnce`; vision uses `Continuous`.

### AreaDefinition

Constructor args: `name, core, queryProvider, resolver, algorithm, maxRange, persistence, scheduling, renderer, visibilityTracker, autoRender`.

- `visibilityTracker` non-null ⇒ `TrackVisibility` on. Fog/vision pass no-op trackers; the skill area passes a real one.
- Caches `AlgorithmName`/`PersistenceName`/`SchedulingName` strings at construction to avoid `enum.ToString()` allocation in editor debug capture.

---

## 7. QueryBatch Internals

**ProcessFrame sequence:**

1. `_dispatchedThisFrame.Clear()`
2. `FlushPendingUnregisters` — deferred unregister applied at frame start
3. `FullClear` on first frame
4. `ClearUsedSlots` (skipped if any readback pending)
5. `SlotAllocator.Reset`
6. `BuildSchedule` → `CollectQueries` → `DispatchQueries` → `MergeAndRequestReadbacks`
7. On readback complete → `ResolveArea`

### CollectQueries — anchor write-back

`AreaRuntimeState` is a **struct**. `CollectQueries` reads it, sets `state.AnchorCell` from the first query's center, and **must write it back** (`_runtime[area] = state;`) — otherwise the anchor update is lost on the copy and `ComputeScore`'s distance term reads a stale `(0,0)`, flattening locality scoring.

### MergeAndRequestReadbacks guards

Each area group is skipped unless it is still live and consistent: `_runtime.ContainsKey` **and** `_mergeTargets.ContainsKey`, and not in `_pendingReadbacks` or `_dispatchedThisFrame`. The `ContainsKey` pair prevents a crash when an area (e.g. the skill area) is unregistered mid-flight.

GPU-resolved areas (vision, via `IGPUAreaResolver`) consume the merged buffer on the GPU — no readback, no CPU scatter.

### ResolveArea — empty-resolve guard (one-shot correctness)

```
_pendingReadbacks.Remove(area)            // always, so a fresh dispatch can follow
if result.Queries.Count == 0: return      // no-op — do NOT consume dirty
resolver.OnResolved(...)
if TrackVisibility: visibilityTracker.Update(...)
if AutoRender: renderer.Render(...)
PostResolve(area)                         // clears dirty ONLY on a real resolve
```

An empty resolve renders nothing, so it must not consume the dirty flag — otherwise a one-shot (`DirtyOnce`) area can lose its single update to an empty pass and never draw. Leaving it dirty lets it re-dispatch and resolve for real. `PostResolve` (which calls `Core.ClearDirty`) runs only for non-empty resolves.

### Deferred unregister

`Unregister` adds to `_pendingUnregister` and removes the area from `_pendingReadbacks`/`_dispatchedThisFrame`. `FlushPendingUnregisters` (start of `ProcessFrame`) removes runtime + merge target. Avoids mutating collections mid-iteration and racing in-flight readbacks.

**`_dispatchedThisFrame`** — caps an area at one dispatch per `ProcessFrame`, even if a readback completes within the same Unity frame.

**`AreaSystemUpdater.Tick`** — `_timer = 0f` (not `-= RefreshRate`) prevents debt accumulation; the whole area-system update (renderer ticks, camera position, `ProcessFrame`) runs at most once per Unity frame, gated to 30 Hz.

---

## 8. Area Types

|Area|Batch|Kernel|Persistence|Dirty|Renderer|Status|
|---|---|---|---|---|---|---|
|Fog of War|Global|PersistentBlit|FogWorkingBuffer|DirtyOnce|MultiChunkRenderer|active|
|Vision Area|Global|ProjectVision (GPU)|None|Continuous|MultiChunkRenderer|active|
|Skill Area|Local|BlitLocal|None|DirtyOnce|AreaRenderer|active|
|Elemental Area|Global|PersistentBlit|FogWorkingBuffer|DirtyOnce|MultiChunkRenderer|planned|
|Movement Area|Local|BlitLocal|None|DirtyOnce|AreaRenderer|planned|

---

## 9. Rendering

### Compute Shader Kernels (single shader file)

- **`PersistentBlit`** — fog, monotonic reveal, column-major (`id.x*ChunkSize + id.y`), offset write. `alpha = min(current.a, 1 - revealed)`.
- **`Blit`** — direct overwrite, column-major, offset write. `alpha = 1 - visible`.
- **`ProjectVision`** — vision GPU projection. Reads the merged mask row-major, writes region-local texels offset by `RegionOriginCell`, skips cells whose chunk isn't in `ActiveChunkMask`. Punches visible cells to alpha 0 over an alpha-1 region.
- **`BlitLocal`** — skill, row-major (`id.y*ChunkSize + id.x`), circle mask (`radius = ChunkSize/2`). **Writes with offset** (`TargetTexture[int2(OffsetX+id.x, OffsetY+id.y)]`) so a sub-range query lands centered in the fixed field; `alpha = visible` inside the circle, 0 outside.
- **`Clear`** — resets texture to `(0,0,0,1)` (opaque). Used by fog/vision (unexplored = opaque).
- **`ClearTransparent`** — resets texture to `(0,0,0,0)`. Used by the skill field (outside-the-disc = invisible). Required because `BlitLocal`'s offset write no longer clears cells outside the query block.

### MultiChunkRenderer (fog, vision)

Generic, reusable. Constructor selects the kernel (`PersistentBlit` for fog, GPU project for vision), `subscribeMeshEvents`, and `ownsStaticData`. **Both fog and vision now own their static data and subscribe to chunk events** (each has its own mesh).

**Async sync model** — nothing blocks; the mesh is scheduled async and applied in `Tick`. The texture repaints in the same `Tick` the mesh applies, so origin and texture never disagree:

- `Tick()` → `EnsureMeshScheduled()`; on mesh apply, flips `_meshTargetOrigin` → `_currentRegionOrigin` and calls `Paint()`.
- `EnsureMeshScheduled` (gated on `HasPendingJob`): region-shift takes priority (sets target origin, builds static data first time, schedules rebuild), else a `_contentDirty` rebuild at the current origin.
- `RequestBlit(blit, clearTexture)` caches the blit delegate; paints immediately only if no region shift and no pending job.
- `OnChunkActivated` / `OnChunkDirty` just set `_contentDirty = true`, coalescing N activations into one rebuild.
- Both resolvers cache their blit delegates (zero per-frame closure allocation). `ApplyPendingRegionOrigin` was removed.

**Show timing** — vision defers `Show()` until its first `OnResolved`, ensuring the mesh job has completed before `SetActive(true)`; avoids a `WaitForGPU` pipeline stall.

### AreaMeshBuilder — interleaved single upload

Vertices are one `NativeArray<MeshVertex>` where `MeshVertex { float3 Position; float3 Normal; }` (`[StructLayout(Sequential)]`).

- `BuildStaticData` declares Position + Normal in **stream 0**, UVs in **stream 1**.
- `Apply()` does a single `SetVertexBufferData(_vertexData, 0, 0, _vertexCount, stream:0, SilentUpdate)` where `SilentUpdate = DontRecalculateBounds | DontValidateIndices | DontResetBoneBounds | DontNotifyMeshUsers`. Replaces the prior two `SetVertices` + `SetNormals` uploads (~4.9 MB each).
- Bounds are set manually from a `ComputeBoundsJob`.

**Jobs & dependency chain:**

- `BuildMeshVerticesJob` writes `.Position` (reads the struct first, so **not** `[WriteOnly]`).
- `BuildMeshNormalsJob` reads neighbour `.Position.y`, writes `.Normal`; `[NativeDisableParallelForRestriction]` on the shared array; takes `CellSize` (`normal = normalize(float3(hl-hr, 2*CellSize, hd-hu))`).
- `ComputeBoundsJob` reads `.Position`.
- Because bounds and normals share the array, `boundsJob.Schedule(normalsHandle)` (not the vertex handle), and `_pendingJob = boundsHandle` directly.

`ScheduleVertexRebuild` is guarded by `if (_jobPending) return;` and takes `chunksPerRow`, `regionChunkOriginX/Y` for non-chunk-aligned regions.

### AreaRenderer (local areas)

Fixed-field renderer for the skill area:

- **Built once at `_maxRange`** and kept for the app lifetime — _not_ per-session. The field is always `2*_maxRange+1` (diameter 201); the texture, mesh, and mask buffer are all this fixed size. `maskBuffer = ComputeSlotSize(_maxRange)` to match the batch's fixed slot output.
- A skill's **window radius** drives only which cells the query lights, never the geometry. Short-range skills light a smaller centered disc; future cone/line shapes are just different lit subsets of the same field.
- `SetQueryCenter(center, radius)` stores center + radius and rebuilds the mesh (always full field, centered on the caster).
- `Render(mask, count)` decodes at the **query diameter** and centers the block via `OffsetX/Y = (diameter - queryDiameter)/2`, dispatching `queryDiameter/8` thread groups. This is what lands the disc on the caster.
- `Clear()` uses `ClearTransparent` over the full field.
- Subscribes to `OnChunkActivated` to rebuild the mesh when overlapping terrain changes. Terrain sampling via `AreaCellDataExtractor.Fill`.

---

## 10. Fog of War

### Persistence Architecture

**`FogWorkingBuffer`** — mmf in `temporaryCachePath`, scene lifetime. All reads/writes go here. `OpenMapping`/`CloseMapping` wrap mmf creation/teardown; `Create` delegates to `OpenMapping`, `Dispose` to `CloseMapping`. `Exists`/`Load`/`Save`/`Flush` are null-guarded against a closed accessor (the mmf is closed during `File.Copy`). Bulk ops use `FileStream` directly to avoid `MemoryMappedViewAccessor` overhead on Mono.

**`FogPersistenceStore`** — flat binary files in `persistentDataPath`. Save flushes the buffer then `File.Copy(mmf → save)`. Load closes the mapping, `File.Copy(save → mmf)`, reopens, then `ReloadActiveTiles`.

```
New Game  → FogWorkingBuffer.Zero()
Save      → Flush → File.Copy(mmf → save)
Load      → CloseMapping → File.Copy(save → mmf) → OpenMapping → ReloadActiveTiles
Quit      → FogWorkingBuffer.Dispose() (mmf deleted)
```

### Explored State

- One `uint[512]` per chunk (128×128 / 32), bits only ever set (permanent reveal).
- Pooled via a **size-based free list** (`Stack<uint[]> _freeStates`): `OnChunkDeactivated` pushes the array back, `GetOrCreateExploredState` pops + `Array.Clear`. Reactivation restores prior state from the mmf round-trip. This removed the per-never-seen-chunk `new uint[512]` GC spikes during exploration.
- `_dirtyChunks` tracks chunks revealed this frame; `OnChunkDeactivated` always saves to the working buffer.

### Save-on-Load ordering

On load, chunks activate and would otherwise fire `LoadTileAsync` before the copy/mapping-reopen finished, reading a null accessor. Fixes:

- `GlobalTileStreamer.OnChunkActivated` early-returns while `_pendingReload` is set; `ReloadActiveTiles` is the single load entry after reload.
- `LoadTileAsync` resolves the explored state and yields **before** touching the mmf, so nothing reads it on the activation frame.

### Tile Loading — Async

`LoadTileAsync` spreads 25 tile loads across frames via `UniTask.Yield`, with a `CancellationToken` linked to `ApplicationStopping`. `_pendingReload` is set on `SetWorkingBuffer` and triggers `ReloadActiveTiles` on the first `OnCameraChunkChanged` after the store is set.

---

## 11. Vision Area

### Design

Current-frame visibility only — no accumulation. Resolved entirely on the GPU (`ProjectVision`): the merged mask is projected into the region texture, visible cells punched to alpha 0 over an alpha-1 field, skipping cells whose chunk isn't active. No readback, no CPU scatter.

### Show Timing

Vision calls `Show()` from `OnResolved`, not on region change — by then the mesh job has completed naturally, avoiding the `WaitForGPU` stall that `SetActive(true)` triggers while a Burst mesh job is in flight.

### Scheduling & Region Shift

`SchedulingHint.Normal` + `Continuous` — always schedules; `_dispatchedThisFrame` caps it at one dispatch per `ProcessFrame`. On region shift the resolver updates `_currentRegionOrigin` for correct projection offsets — no texture clear, no extra mesh rebuild beyond the standard `Tick` path.

---

## 12. Skill Area

### Design

- One caster (or N via `ManualRevealerSource`), local `QueryBatch`, not persistent.
- One-shot: `MarkDirtyOnce` per `BeginTargeting`; fires a single query and waits for player input.
- `AreaRenderer` fixed field (see §9) — built once, reused across sessions.
- On `Deactivate`, the core dirty is cleared (`_core.ClearDirty()`) so a deactivated skill stops being scheduled, and the renderer is cleared (`ClearTransparent`) + hidden.

### Range integration

`BeginTargeting(EntityId casterId, RangeProfile range)`. The window's max distance drives the **reveal radius** (which cells light), independent of the caster's sight range:

```
ResolveRadius(window):
  if window.Max >= float.MaxValue: return _maxRange     // unbounded clamps to batch ceiling
  cells = ceil(window.Max / CellSize)
  return clamp(cells, 1, _maxRange)                      // _maxRange cap is mandatory (slot budget)
```

The radius flows only to `_revealerSource.Add(caster, radius)`. `RangeProfile { Window: RangeBounds, Shape: AreaShape, Bands }`; `RangeBounds` is min-inclusive / max-exclusive. (Unit note: `Window.Max` is treated as world units → divided by `CellSize`. `Window.Min` donut and cone/line shapes are not yet wired — they need kernel support.)

### Target selection (visibility tracker)

The skill definition carries a real `AreaVisibilityTracker`, and the skill core is fed the same revealables as fog via `RevealableRegistrar.AddArea`. As the resolved area reports revealables entering/exiting, `SkillAreaService` maintains:

- `IReadOnlyCollection<EntityId> InAreaEntities`
- `event Action OnAreaChanged`

`TargetingPresenter` is reactive:

- **`SelfTargetStrategy`** creates no area — it highlights the caster directly.
- **Single/Multi** subscribe to `OnAreaChanged`, call `BeginTargeting`, and highlight the intersection of `InAreaEntities` and the strategy filter, diffing against the currently-subscribed set (highlight/clear deltas; selected targets stay subscribed). An immediate refresh after `BeginTargeting` picks up an already-resolved set when re-targeting the same skill.

Because the area is one-shot, the valid-target set is locked at `BeginTargeting` until the next call. The empty-resolve guard (§7) and the tracker's empty-resolve guard (§13) make this robust against intermittent empty resolves consuming the one-shot dirty.

---

## 13. Revealers & Revealables

### Revealer Sources

- **`PartyRevealerSource`** — party members (`continuous: true` for vision, `false` for fog).
- **`ManualRevealerSource`** — skill casters, explicit `Add`/`Remove`.
- **`FactionRevealerSource`** — planned, per-faction vision.

All use push-based revealers via `IEntity.OnPositionChanged`, updating only on cell change.

### RevealableRegistrar

Owns the `EntityRevealable` per entity and feeds them to registered areas.

- `_revealables` is populated **unconditionally** on `OnEntityRegistered` (independent of whether areas are set yet). Only the area-adding is gated on `_areas`. This fixes a bug where entities registered before `SetAreas` (including the constructor's initial sweep) were permanently dropped, leaving area cores with no revealables.
- `SetAreas` and `AddArea` both **back-fill** existing `_revealables` into the area's core. `AddArea` is additive — used to register the skill area after it's lazily built.
- `OnEntityUnregistered` null-guards `_areas`.

### EntityRevealable

Exposes `EntityId`, `GridPosition` (push-updated, `MoveThreshold = 0.1`), and `IsTargetable` (default true). `GridPosition` is in the same cell space as query centers.

### AreaVisibilityTracker

`Update(revealables, result)` builds `VisibleRevealables` via `IsVisibleInAnyQuery` (row-major decode at the query diameter, checks `IsTargetable` + `GridPosition`), then `DetectTransitions` fires enter/exit against the previous frame's set.

**Empty-resolve guard:** `if (result.Queries.Count == 0) return;` — a resolve with no active query (e.g. a one-shot skill query that already fired and isn't dirty) is "no new information," not "everyone left." Without this, the next idle resolve would fire exit for all revealables and clear the highlights. (`QueryBatch.ResolveArea` also skips the tracker on empty resolves; either guard suffices, both are kept.)

Fog/vision use no-op trackers; only the skill area consumes the enter/exit callbacks.

---

## 14. Frame Lifecycle

```
AreaSystemUpdater.Tick (every Unity frame)
  _timer += deltaTime; if _timer < RefreshRate: return; _timer = 0f
  → pipeline.SetCameraPosition(focusPoint)
  → fogRenderer.Tick()     → TryApplyPendingMesh → Paint on apply
  → visionRenderer.Tick()  → TryApplyPendingMesh → Paint on apply
  → skillService.Tick()    → AreaRenderer.Tick → TryApplyPendingMesh
  → pipeline.ProcessFrame()

AreaPipeline.ProcessFrame (30 Hz, ≤ once per Unity frame)
  → LocalAreaContext.TryShift(cameraCell)
  → ChunkManager.Update(focusPosition)
      FlushDirtyChunks
      DrainPendingBakes → CopyBakedDataFrom → ActivateReady → OnChunkActivated
      if camera changed:
        UpdateActiveRegion → deactivate out-of-range
        OnCameraChunkChanged → fog/vision resolvers update region origin
      ActivatePendingChunks → ready: ActivateReady; void: schedule bake into _pendingBakes
  → globalBatch.ProcessFrame(cameraCell)
      FlushPendingUnregisters → BuildSchedule → CollectQueries → DispatchQueries → MergeAndRequestReadbacks
      readback complete → ResolveArea (empty resolves skipped, don't clear dirty)
        Fog: MergeIntoAllChunks → blit per chunk
        Vision: GPU ProjectVision (no readback) → Show() on first resolve
  → localBatch.ProcessFrame(cameraCell)
        Skill: ResolveArea → SkillAreaResolver.Render + AreaVisibilityTracker.Update → OnAreaChanged
```

---

## 15. Performance

### Zero Hot-Path Allocation

|Operation|Mechanism|
|---|---|
|Chunk bake jobs|Pre-warmed pool of 25, NativeArrays reused via `Reset()`|
|Chunk buffers|Pre-warmed pool of 25, ComputeBuffer reused via `Reinitialize()`|
|GridChunk objects|Pre-warmed pool of 25|
|Merge buffer|Zero-copy `_staticCells` return when no dynamic blocks|
|Explored state|Size-based free-list pool (`Stack<uint[]>`)|
|Vision chunk masks|Pooled `uint[]` by coord|
|Mesh upload|Single interleaved `SetVertexBufferData` with silent update flags|
|GPU readback|Per-request holder, `ArrayPool<uint>`|
|Readback callback|Pooled `ReadbackCallback` with pre-allocated `List<ScheduledQuery>`|
|Blit delegates|Cached per resolver — no per-frame closures|
|Working buffer write|mmf write = memory operation|
|Save|`File.Copy` async on thread pool|
|Debug capture|Gated by `IsWindowOpen`|
|Enum strings|Cached on `AreaDefinition` at construction|

### Async Spreading

- Chunk bakes: scheduled on the job system, drained on the main thread via `DrainPendingBakes` (progressive, no blocking)
- Tile loads: `UniTask.Yield` per load, spread across frames
- Tile-load cancellation linked to `ApplicationStopping`

### Scheduling

`ComputeScore` weights dirty (1000), distance (×100, falloff over `MaxScoreDistance = 512` cells), and age (cap 200). The `AnchorCell` write-back (§7) is required for the distance term to be live.

### Estimated Frame Cost

These are reasoned estimates, **not profiled numbers** — actual cost depends on hardware, party size (revealer count), camera speed, and target frame rate. Assume a 60 fps target (16.7 ms budget), a mid-range GPU, and ~4–8 revealers. The whole update is gated to 30 Hz, so it runs on roughly every other rendered frame; the amortized per-frame cost is about half the per-tick figures below.

|Scenario|Main-thread CPU|Notes|
|---|---|---|
|Steady state (camera still, no targeting)|~0.1–0.3 ms (~1–2%)|Schedule/query building over ≤32 areas, ≤128 queries; a few compute dispatches. Most real work is GPU shadowcast/merge/blit, typically a fraction of a millisecond.|
|Active exploration (camera panning across chunk boundaries)|brief spikes to ~1–2 ms (~6–12%)|Dominated by the per-mesh ~13 MB vertex upload on region shift plus a row of chunk bakes and GPU obstacle uploads — not the query pipeline.|
|Skill targeting|well under the steady-state figure|One extra one-shot local query + a visibility-tracker pass over revealables.|

In the common case the system should sit comfortably under ~2–3% of a 60 fps frame, with brief single-digit-percent spikes while terrain streams in. The dominant cost is **mesh upload on region shift**, which is exactly what the single interleaved upload and the 30 Hz gate are there to contain. Scaling factors to watch: revealer count (more queries/dispatches), max range (larger shadowcast regions, quadratic in radius), and camera speed (region-shift frequency). These figures should be replaced with profiler captures before treating them as a budget.

---

## 16. Memory Budget

|Resource|Size|Count|Total|
|---|---|---|---|
|Chunk obstacle buffer (GPU)|256 KB|25 active|6.25 MB|
|GridChunk pool (CPU)|144 KB each|25|3.6 MB|
|Fog render texture|640×640 RGBA|1|1.6 MB|
|Vision render texture|640×640 RGBA|1|1.6 MB|
|Skill render texture|201×201 RGBA|1|~0.16 MB|
|Query output masks (global)|SlotSize(150) × 32|1|~3 MB|
|Query output masks (local)|SlotSize(100) × 32|1|~0.3 MB|
|Cross-chunk neighbourhood|9 × 256 KB|2 (one per batch)|4.5 MB|
|Explored state per chunk|2 KB|25 active|50 KB|
|Vision chunk masks|2 KB|25 active|50 KB|
|AreaMeshBuilder (fog)|~26 MB|1|~26 MB|
|AreaMeshBuilder (vision)|~26 MB|1|~26 MB|
|AreaMeshBuilder (skill)|~2.8 MB|1|~2.8 MB|
|FogWorkingBuffer (mmf)|80×80 × 512 B|1|~3.1 MB|
|**Total**|||**~79 MB**|

Split is roughly **~17 MB GPU** (obstacle buffers, render textures, query masks, cross-chunk neighbourhood) and **~62 MB CPU** (mesh builders dominate at ~55 MB, plus the GridChunk pool and the mmf). The two full-size mesh builders (fog + vision, ~26 MB each) are the deliberate cost of separate meshes — accepted to remove the region-shift flicker. The skill builder is now persistent (build-once), not transient. Note the builders' CPU-side NativeArrays are staging copies; the GPU-resident `Mesh` vertex/index buffers (~23 MB each) are additional and not itemised here.