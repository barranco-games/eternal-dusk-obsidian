> **Last updated:** May 2026

---

## Table of Contents

1. [Overview](#1-overview)
2. [Clean Architecture Layers](#2-clean-architecture-layers)
3. [Core Concepts](#3-core-concepts)
4. [World Grid & Chunk System](#4-world-grid--chunk-system)
5. [Height & Vision Model](#5-height--vision-model)
6. [Area Pipeline](#6-area-pipeline)
7. [AreaCore & AreaDefinition](#7-areacore--areadefinition)
8. [QueryBatch](#8-querybatch)
9. [Area Types](#9-area-types)
10. [Rendering](#10-rendering)
11. [Fog of War](#11-fog-of-war)
12. [Vision Area](#12-vision-area)
13. [Skill Area](#13-skill-area)
14. [Revealers & Revealables](#14-revealers--revealables)
15. [Key Interfaces](#15-key-interfaces)
16. [Frame Lifecycle](#16-frame-lifecycle)
17. [Performance](#17-performance)
18. [Memory Budget](#18-memory-budget)

---

## 1. Overview

The Area System is a GPU-accelerated spatial query framework responsible for computing and rendering all grid-based areas: fog of war, elemental spread, unit vision, movement range, and skill areas of effect.

It operates on a chunked 2.5D heightfield grid, persists fog data per save slot via memory-mapped files, and exposes a clean event-based API to the rest of the game.

### Design Goals

- **Correctness at scale** — 10,240 × 10,240 cell world, no global recompute on mutation
- **Zero runtime allocation** — all hot-path allocations eliminated
- **Predictable frame cost** — query budget enforced per batch
- **Declarative configuration** — area behaviour expressed as data, not subclasses
- **Clean architecture** — strict layer boundaries enforced by separate assemblies

---

## 2. Clean Architecture Layers

```
Core → Gameplay → Systems → Engine
```

### Core
Pure C#, zero Unity references. Interfaces and value types only.

### Gameplay
Domain logic. No Unity. Contains `GridChunk`, `WorldGrid`, `AreaCore`, `AreaDefinition`, `FogOfWarResolver`, `VisionAreaResolver`, `SkillAreaResolver`, query providers, resolvers.

### Systems
Depends on Core + Gameplay. Contains `QueryBatch`, `ChunkManager`, `AreaPipeline`, GPU abstraction interfaces.

### Engine
Unity APIs only here. Contains `AreaService`, `UnityBakeJob`, `MultiChunkRenderer`, `AreaMeshBuilder`, `GlobalTileStreamer`, `FogWorkingBuffer`, `FogPersistenceStore`, `AreaInstaller`, `SkillAreaService`.

---

## 3. Core Concepts

### Grid Constants

```
Cell size:        0.1 Unity units
Chunk size:       128 × 128 cells
Chunk world size: 12.8 Unity units
Active region:    5 × 5 chunks around camera focus point
Max sight range:  100 cells (DerivedStats base value)
Max fog range:    150 cells
```

### Coordinate System

- Cell coords are 0-based relative to world origin (subtracted in `FloorToCell`)
- Chunk coords derived via `GridMath.FloorDiv` — handles negative values correctly
- `WorldGrid` uses `ChunkOriginX/Y` to offset chunk coords to array indices
- All `WorldGrid` array accesses use `LocalX`/`LocalY` helpers — critical for negative-origin worlds
- `GlobalTileStreamer` converts world chunk coords to file-local coords via `ToFileCoord`

### Camera Focus Point

Active chunk region centers on `ICameraManager.FocusPoint`. `ChunkManager` fires `OnCameraChunkChanged` on chunk boundary crossing.

---

## 4. World Grid & Chunk System

### Cell Data Encoding

| Bits | Field | Encoding |
|---|---|---|
| 0–15 | Floor height | Fixed point, 1 unit = 100 counts |
| 16 | Walkable flag | 1 = walkable |
| 17–31 | Reserved | |

`VoidCell = 0x0000_0000`

### GridChunk Pooling

- Pre-warmed with 25 instances at startup
- `Initialize(chunkCoord)` — clears static cells only on coord mismatch
- `Reset()` — clears dynamic overlay only, preserves baked data for coord-matched reuse
- `_hasBakedData` + `_bakedCoord` — track validity across pool reuse
- `GetMergeBuffer()` — merges static + dynamic, returns pre-allocated internal array

### WorldGrid Array Indexing

```csharp
ChunkOriginX = GridMath.FloorDiv((int)(worldOrigin.X * InvCellSize), ChunkSize)
LocalX(chunkX) = chunkX - ChunkOriginX
_chunks[LocalX(coord.X), LocalY(coord.Y)]
```

All accesses — `IsValidChunk`, `GetChunk`, `ReturnChunk`, `Decompose`, `GetNeighbourhood` — use `LocalX`/`LocalY`. Critical: `IsValidChunk` must subtract chunk origin before unsigned comparison, otherwise out-of-range positive coords pass validation.

### Obstacle Bake — Async Architecture

Bakes are asynchronous — `ChunkManager.ActivateChunkAsync` is a `UniTaskVoid` that:
1. Schedules the bake job
2. Polls `job.IsComplete` via `UniTask.Yield(PlayerLoopTiming.Update)` each frame — no background threads, no job system thread violations
3. Applies bake result on main thread when complete
4. Activates chunk — uploads to GPU, fires `OnChunkActivated`

`ChunkManager` owns a `CancellationTokenSource` linked to `IApplicationLifetime.ApplicationStopping` — cancelled in `Dispose` to stop all in-flight async tasks.

`_pendingBakes` dictionary replaced by `_bakingChunks` `HashSet` — tracks in-flight coords without holding job references.

`OnBatchActivated` event removed — mesh rebuilds triggered per-chunk via `OnChunkActivated`.

### Bake Job & Buffer Pooling

**`UnityBakeJobFactory`** — pre-warmed with 25 jobs. Each `UnityBakeJob` allocates three `Allocator.Persistent` `NativeArray`s once at construction. `Reset()` on `IBakeJob` interface prepares for reuse.

**`UnityObstacleBufferFactory`** — pre-warmed with 25 buffers. Each `UnityChunkBuffer` holds a `ComputeBuffer` for the chunk's cell data. `Reinitialize(coord)` for reuse — buffer never disposed between uses.

Both factories implement `IDisposable` — dispose all pooled instances at scene teardown.

### ChunkManager

- `Update` stays synchronous — fires async tasks and returns
- `FlushDirtyChunks` runs each frame for runtime geometry changes
- `GetActiveChunkCoords()` — used by `GlobalTileStreamer.ReloadActiveTiles`
- `OnCellObstacleChanged` uses `GridMath.FloorDiv` for chunk coord

---

## 5. Height & Vision Model

### Sightline Test (2.5D DDA)

```hlsl
sightlineH = lerp(revealerEyeH, targetFloorH, t / dist)
blocked = marchFloorH > sightlineH
```

Revealer eye height = floor height + 1.8 Unity units.

### Output Mask Addressing

```hlsl
// Shader write — row-major
uint bitIndex = localY * diameter + localX;

// CPU merge read (per query, no slot offset — merge target starts at 0)
int queryBitIndex = localY * diameter + localX;
int wordIndex = queryBitIndex >> 5;
int bitOffset = queryBitIndex & 31;

// Explored/vision state — column-major
int bitIndex = chunkLocalX * ChunkSize + chunkLocalY;
```

### Multi-Revealer Mask

The merge kernel ORs all query slots into one merge target starting at index 0. Each query in `result.Queries` has its own center and radius. `MergeIntoAllChunks` and `ProjectIntoChunks` iterate each query independently — the bit offset within the merged mask is always slot-relative to index 0 (no `slotStart` offset needed since merge has already combined them).

### Cross-Chunk Neighbourhood

`CrossChunkQueryBuilder` — one instance per `ShadowcastProcessor` (not shared between batches).

---

## 6. Area Pipeline

### AreaService

Central coordinator — owns all area system wiring for a scene. Uses `[Inject]` for container dependencies. Initialized by `AreaInstaller.OnContainerBuilt`.

**Setup methods (called in order):**
- `SetupGlobalBatch` — creates global `QueryBatch`, `ShadowcastProcessor`, shared `AreaMeshBuilder`
- `SetupLocalBatch` — creates local `QueryBatch` and `ShadowcastProcessor` (no skill area wiring)
- `SetupFogOfWar` — creates fog renderer (`ownsStaticData: true`), resolver, streamer, working buffer, savable
- `SetupVisionArea` — creates vision renderer (`ownsStaticData: false`), resolver, revealer source
- `SetupSkillArea` — creates `SkillAreaService` using local batch (currently disabled)

**`IAreaService`** (Systems) exposes `ISkillAreaService SkillAreaService`.

### AreaPipeline

```
ProcessFrame()
  → LocalAreaContext.TryShift(cameraCell)
  → ChunkManager.Update(focusPosition)
  → foreach batch: batch.ProcessFrame(cameraCell)
```

### QueryBatch

Two instances:
- **Global** — fog + vision, `SlotSize = ComputeSlotSize(150)`, `MaxSlots = 32`
- **Local** — skill areas, `SlotSize = ComputeSlotSize(MaxSightRange)`, `MaxSlots = 32`

---

## 7. AreaCore & AreaDefinition

### AreaCore Dirty States

```
Clean → DirtyOnce → Clean     (position change, one update)
Clean/DirtyOnce → Continuous   (never cleared by QueryBatch)
```

`ClearDirty` is a no-op when state is `Continuous`.

### AreaDefinition

Caches `AlgorithmName`, `PersistenceName`, `SchedulingName` as strings at construction — avoids `enum.ToString()` allocation in editor debug capture.

---

## 8. QueryBatch Internals

**ProcessFrame sequence:**
1. `_dispatchedThisFrame.Clear()` — prevents double dispatch within one ProcessFrame
2. FullClear on first frame
3. ClearUsedSlots (skipped if pending readbacks)
4. SlotAllocator.Reset
5. BuildSchedule
6. CollectQueries
7. DispatchQueries
8. MergeAndRequestReadbacks — skips areas in `_pendingReadbacks` OR `_dispatchedThisFrame`
9. On readback complete → remove from `_pendingReadbacks` → OnResolved

**`_dispatchedThisFrame`** — cleared at start of each `ProcessFrame`. Prevents the case where a readback completes within the same Unity frame it was requested, clearing `_pendingReadbacks` and allowing an immediate re-dispatch before the next `ProcessFrame`.

**`AreaSystemUpdater.Tick`** — `_timer = 0f` (not `-= RefreshRate`) prevents debt accumulation. `ProcessFrame` fires at most once per Unity frame. All renderer ticks and `SetCameraPosition` are inside the 30Hz gate.

**`AreaDebugBridge`** — `CaptureFrame` gated by `IsWindowOpen` — zero allocation when debug window closed.

---

## 9. Area Types

| Area | Batch | Kernel | Persistence | Scheduling | Dirty Mode | Renderer |
|---|---|---|---|---|---|---|
| Fog of War | Global | PersistentBlit | FogWorkingBuffer | Normal | DirtyOnce | MultiChunkRenderer |
| Vision Area | Global | Blit | None | Normal | Continuous | MultiChunkRenderer |
| Skill Area | Local | BlitLocal | None | Normal | DirtyOnce | AreaRenderer |
| Elemental Area | Global | PersistentBlit | FogWorkingBuffer | Normal | DirtyOnce | MultiChunkRenderer |
| Movement Area | Local | BlitLocal | None | Normal | DirtyOnce | IAreaRenderer |

---

## 10. Rendering

### Compute Shader Kernels

**`PersistentBlit`** — monotonic reveal, fog only:
```hlsl
float alpha = min(current.a, 1.0 - revealed);
```

**`Blit`** — direct overwrite, vision (column-major addressing):
```hlsl
uint bitIndex = id.x * ChunkSize + id.y;
float alpha = 1.0 - visible;
```

**`BlitLocal`** — direct overwrite, local areas (row-major addressing, circle mask):
```hlsl
uint bitIndex = id.y * ChunkSize + id.x;
float alpha = dist > radius ? 0.0 : visible;
```

**`Clear`** — resets entire texture to `(0,0,0,1)`.

### MultiChunkRenderer

Generic, reusable. Constructor parameters:
- `blitKernelName` — selects kernel (`"PersistentBlit"` for fog, `"Blit"` for vision)
- `subscribeMeshEvents` — fog subscribes to `OnChunkActivated`/`OnChunkDirty`, vision does not
- `ownsStaticData` — fog `true` (calls `BuildStaticData`), vision `false` (skips it, avoids double build on shared mesh)

**`SetActiveRegionOrigin`** — clears texture. Used by fog on region shift.
**`UpdateRegionOrigin`** — no clear, no mesh rebuild. Used by vision to track region origin for correct `BlitChunk` offsets.

Fog and vision share one `AreaMeshBuilder` — fog drives all mesh rebuilds via `OnChunkActivated`.

**`Show` / `Tick` design** — `Show()` sets `_shown = true` and calls `_gameObject.SetActive(true)` directly. Vision defers calling `Show()` until `OnResolved` fires — this ensures the mesh job from fog has already completed naturally before the GameObject is activated, avoiding the `WaitForGPU` stall that occurs when `SetActive(true)` is called while a mesh job is still in flight.

### AreaMeshBuilder

Parameterized for arbitrary cell dimensions — default is 5×5 chunk region (fog/vision), parameterized for skill area diameter. `ScheduleVertexRebuild` takes `chunksPerRow`, `regionChunkOriginX/Y` to correctly index cell data for non-chunk-aligned regions.

### AreaRenderer (Local Areas)

- Per-session: created on `BeginTargeting`, disposed on `EndTargeting`
- Creates its own `AreaMeshBuilder` sized to `diameter` cells
- Subscribes to `ChunkManager.OnChunkActivated` to rebuild mesh when terrain changes
- Only rebuilds if activated chunk overlaps the skill area region
- `Tick()` called by `AreaSystemUpdater` via `SkillAreaService.Tick()`
- Terrain height sampling uses `AreaCellDataExtractor.Fill` with correct chunk span

---

## 11. Fog of War

### Persistence Architecture

**`FogWorkingBuffer`** — mmf in `temporaryCachePath`. Scene lifetime. All area system reads/writes here. `CloseMapping`/`OpenMapping` for bulk operations via `FileStream` directly — avoids `MemoryMappedViewAccessor` overhead on Mono.

**`FogPersistenceStore`** — flat binary files in `persistentDataPath`. Save: `File.Copy(mmf → save file)` async. Load: `File.Copy(save file → mmf)` async, then reopen mapping.

**Flow:**
```
New Game  → FogWorkingBuffer.Zero() → clear in-memory state → play
Save      → FlushAll → File.Copy(mmf → save file)
Load      → File.Copy(save file → mmf) → reopen mapping → ReloadActiveTiles
Quit      → FogWorkingBuffer.Dispose() → mmf deleted
```

### Explored State

- One `uint[512]` per chunk (128×128 / 32)
- Pooled by chunk coord — zero allocation after first visit
- Bits only set, never cleared — permanent fog reveal
- `_dirtyChunks` — tracks chunks with newly revealed cells this frame only
- `OnChunkDeactivated` always saves to working buffer
- `CommitAllExploredStates` — for explicit flush before save

### Multi-Revealer Fog

`MergeIntoAllChunks` iterates each query in `result.Queries` independently. Bit addressing uses `wordIndex = queryBitIndex >> 5` with no slot offset — merge kernel has already combined all slots into the merge target starting at index 0.

### Tile Loading — Async

`GlobalTileStreamer.LoadTileAsync` uses `UniTask.Yield` to spread 25 tile loads across frames. Owns `CancellationTokenSource` linked to `IApplicationLifetime.ApplicationStopping`.

`ReloadActiveTiles` also fires async loads — called when store is set and camera chunk is known.

`_pendingReload` flag — set on `SetWorkingBuffer`, triggers `ReloadActiveTiles` on first `OnCameraChunkChanged` after store is set.

---

## 12. Vision Area

### Design

Current-frame visibility only — no accumulation. Each `OnResolved`:
1. Clear CPU chunk masks (`Array.Clear`)
2. Project current GPU mask into per-chunk bitmasks (`ProjectIntoChunks`)
3. Blit each chunk via `Blit` kernel
4. Call `Show()` on first resolve — deferred to avoid WaitForGPU stall

### Show Timing — Critical Design Decision

Vision calls `_renderer.Show()` from `OnResolved`, not from `OnActiveRegionChanged`. This is intentional:

- `OnActiveRegionChanged` fires when `OnCameraChunkChanged` fires — at this point the shared mesh builder may have a pending Burst job in flight from fog's rebuild
- Calling `SetActive(true)` while a mesh job is in flight causes Unity to sync the GPU pipeline, causing a 2-second `WaitForGPU` stall
- `OnResolved` fires after the GPU readback completes — by this point at least one full frame has passed and the mesh job has completed naturally
- This eliminates the stall entirely with no visible quality difference

### Scheduling

`SchedulingHint.Normal` + `MarkDirtyContinuous` — always schedules. `_dispatchedThisFrame` guard in `QueryBatch` caps dispatches at one per `ProcessFrame` call regardless of readback speed.

### Region Shift

`VisionAreaResolver.OnActiveRegionChanged` calls `UpdateRegionOrigin` — updates `_currentRegionOrigin` for correct `BlitChunk` offsets. No mesh rebuild, no texture clear.

### Chunk Tracking

`VisionAreaResolver` tracks active chunks via named delegates stored on `AreaService` — properly unsubscribed in `Dispose`.

---

## 13. Skill Area

### Design

- Transient — created on `BeginTargeting`, destroyed on `EndTargeting`
- One caster (current) or N casters (multicaster skills via `ManualRevealerSource`)
- `IAreaRenderer` — local quad, repositions and conforms to terrain height
- `SchedulingHint.Normal` + `DirtyOnce` — fires on caster position change
- Local `QueryBatch` — separate from global batch
- Not persistent

### ISkillAreaService

Lives in Systems. Exposed via `IAreaService.SkillAreaService`.

```
BeginTargeting(casterId, range) → creates renderer, resolver, definition, registers with local batch
EndTargeting() → unregisters, disposes renderer and resolver
```

---

## 14. Revealers & Revealables

### Revealer Sources

**`PartyRevealerSource`** — party members. `continuous: true` for vision, `false` for fog.

**`FactionRevealerSource`** — planned, per-faction vision.

**`ManualRevealerSource`** — skill casters. Explicit `Add`/`Remove` per entity.

All sources use `AgentRevealer` — push-based via `IEntity.OnPositionChanged`, updates only on cell change.

### Multi-Revealer Correctness

Both fog and vision support up to 32 revealers simultaneously. Each revealer gets its own slot in the output mask. The merge kernel ORs all slots into one target. Resolvers read the merged target with per-query center/radius but no slot offset.

`AreaVisibilityTracker.IsVisibleInAnyQuery` checks each query's region independently.

---

## 15. Key Interfaces

### Systems

```csharp
interface IBakeJob
{
    Int2Data ChunkCoord { get; }
    bool IsComplete { get; }
    void Schedule(Int2Data chunkCoord, Vector3Data worldOrigin);
    void CopyResultTo(uint[] destination);
    void Reset();
    void Dispose();
}

interface IObstacleBufferFactory
{
    IObstacleBuffer Create(Int2Data chunkCoord);
    void Return(IObstacleBuffer buffer);
}

interface IBakeJobFactory
{
    IBakeJob Create();
    void Return(IBakeJob job);
}

interface IAreaService
{
    ISkillAreaService SkillAreaService { get; }
}

interface ISkillAreaService
{
    void BeginTargeting(EntityId casterId, int range);
    void EndTargeting();
}

interface ISavable
{
    string Id { get; }
    int Version { get; }
    SaveEnvelope Capture(IEnvelopeSerializer serializer);
    void Restore(SaveEnvelope envelope, IEnvelopeSerializer serializer);
    void Reset();
    UniTask<SaveEnvelope> CaptureAsync(IEnvelopeSerializer serializer);
    UniTask RestoreAsync(SaveEnvelope envelope, IEnvelopeSerializer serializer);
}
```

---

## 16. Frame Lifecycle

```
AreaSystemUpdater.Tick (every Unity frame)
  _timer += deltaTime
  if _timer < RefreshRate: return
  _timer = 0f

  → pipeline.SetCameraPosition(camera.FocusPoint)
  → fogRenderer?.Tick()     → AreaMeshBuilder.TryApplyPendingMesh
  → visionRenderer?.Tick()  → AreaMeshBuilder.TryApplyPendingMesh
  → skillAreaService?.Tick() → AreaRenderer.Tick
  → pipeline.ProcessFrame()

AreaPipeline.ProcessFrame (30Hz, at most once per Unity frame)
  → LocalAreaContext.TryShift(cameraCell)
  → ChunkManager.Update(focusPosition)
      FlushDirtyChunks
      if camera changed:
        UpdateActiveRegion → deactivate out-of-range chunks
        OnCameraChunkChanged
          → GlobalTileStreamer → FogOfWarResolver.OnActiveRegionChanged
                               → SetActiveRegionOrigin → ScheduleMeshRebuild
          → VisionAreaResolver.OnActiveRegionChanged
                               → UpdateRegionOrigin (no rebuild)
        ActivatePendingChunks → ActivateChunkAsync (fires UniTaskVoid per chunk)
          Each frame: yield → check job.IsComplete → activate → OnChunkActivated
            → GlobalTileStreamer.LoadTileAsync (yields, loads mmf)
            → MultiChunkRenderer.OnChunkActivated (mesh rebuild if in region, fog only)
  → globalBatch.ProcessFrame(cameraCell)
      _dispatchedThisFrame.Clear()
      BuildSchedule → CollectQueries → DispatchQueries → MergeAndRequestReadbacks
      On readback complete → ResolveArea → OnResolved
        Fog: MergeIntoAllChunks → BlitChunk per chunk
        Vision: ProjectIntoChunks → BlitChunk per chunk → Show() on first resolve
  → localBatch.ProcessFrame(cameraCell)
```

---

## 17. Performance

### Zero Hot-Path Allocation

| Operation | Mechanism |
|---|---|
| Chunk bake jobs | Pre-warmed pool of 25, NativeArrays reused via Reset() |
| Chunk buffers | Pre-warmed pool of 25, ComputeBuffer reused via Reinitialize() |
| Chunk GridChunk objects | Pre-warmed pool of 25 |
| Explored/vision state | Pre-allocated, pooled by coord |
| Cell extraction | `UnsafeUtility.MemCpy` SIMD bulk copy |
| GPU readback | Per-request `NativeArrayHolder`, `ArrayPool<uint>` |
| Readback callback | Pooled `ReadbackCallback` with pre-allocated `List<ScheduledQuery>` |
| Working buffer write | mmf write = memory operation |
| Save | `File.Copy` async on thread pool |
| Vision chunk masks | Pooled `uint[]` by coord |
| Debug capture | Gated by `IsWindowOpen` — zero allocation when closed |
| Enum strings | Cached on `AreaDefinition` at construction |

### Async Spreading

- Chunk bakes: `UniTask.Yield` per frame poll — 25 chunks activate progressively
- Tile loads: `UniTask.Yield` per load — 25 tile loads spread across frames
- Both use `CancellationToken` linked to `IApplicationLifetime.ApplicationStopping`

---

## 18. Memory Budget

| Resource | Size | Count | Total |
|---|---|---|---|
| Chunk obstacle buffer (GPU) | 256 KB | 25 active | 6.25 MB |
| GridChunk pool (CPU) | 144 KB each | 25 pre-warmed | 3.6 MB |
| Fog render texture | 640×640 RGBA | 1 | 1.6 MB |
| Vision render texture | 640×640 RGBA | 1 | 1.6 MB |
| Skill area render texture | ~200×200 RGBA | 1 transient | ~0.16 MB |
| Query output masks (global) | SlotSize × 32 | 1 | ~3 MB |
| Query output masks (local) | LocalSlotSize × 32 | 1 | ~0.3 MB |
| Cross-chunk neighbourhood | 9 × 256 KB | 2 (one per batch) | 4.5 MB |
| Explored state per chunk | 2 KB | 25 active | 50 KB |
| Vision chunk masks | 2 KB | 25 active | 50 KB |
| AreaMeshBuilder vertices (shared) | ~5 MB | 1 | 5 MB |
| AreaMeshBuilder vertices (skill) | ~0.3 MB | 1 transient | 0.3 MB |
| FogWorkingBuffer (mmf) | ChunkCountX × ChunkCountY × 512B | 1 | ~3.1 MB (80×80) |
