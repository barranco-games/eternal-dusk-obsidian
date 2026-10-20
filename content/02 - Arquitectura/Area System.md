## Table of Contents

- [[Area System#1. Overview|Overview]]
- [[Area System#2. Core Concepts|Core Concepts]]
- [[Area System#3. World Grid & Chunk System|World Grid & Chunk System]]
- [[Area System#4. Height & Vision Model|Height & Vision Model]]
- [[Area System#5. Area Pipeline|Area Pipeline]]
- [[Area System#6. AreaCore & AreaDefinition|AreaCore & AreaDefinition]]
- [[Area System#7. QueryBatch Internals|QueryBatch]]
- [[Area System#8. Area Types|Area Types]]
- [[Area System#9. Rendering|Rendering]]
- [[Area System#10. Fog of War|Fog of War]]
- [[Area System#11. Vision Area|Vision Area]]
- [[Area System#12. Skill Area|Skill Area]]
- [[Area System#13. Revealers & Revealables|Revealers & Revealables]]
- [[Area System#14. Frame Lifecycle|Frame Lifecycle]]
- [[Area System#15. Performance|Performance]]
- [[Area System#16. Memory Budget|Memory Budget]]
- [[Area System#17. Effect Surfaces|Effect Surfaces]]

---

## 1. Overview

The Area System is a GPU-accelerated spatial query framework responsible for computing and rendering all grid-based areas: fog of war, unit vision, the party's sight (which conceals entities outside it), skill targeting areas, and (planned) movement range. Lingering effect surfaces (fire, smoke, caltrops) share its grid, chunks and region mesh but run their own simulation (§17).

It operates on a chunked 2.5D heightfield grid whose cell size is set per level, persists fog data per save slot and per level via memory-mapped files, and exposes a clean event-based API to the rest of the game.
### Design Goals

- **Correctness at scale** — grid sized per level (`LevelDefinition` world size ÷ cell size), no global recompute on mutation
- **Zero runtime allocation** — all hot-path allocations eliminated
- **Predictable frame cost** — query budget enforced per batch
- **Declarative configuration** — area behaviour expressed as data, not subclasses

---

## 2. Core Concepts

### Grid Constants

```
Cell size:        per level — LevelDefinition._cellSize → GridMetrics (default 0.1, GridConstants.DefaultCellSize)
Chunk size:       128 × 128 cells  (ChunkSize; ChunkCellCount = 16384) — fixed
Chunk world size: 128 × cell size  (12.8 Unity units at 0.1)
World origin:     per level  (LevelDefinition.WorldOrigin)
Grid:             per level  (LevelDefinition.ChunkCountX/Y = world size ÷ chunk world size, rounded up)
Active region:    7 × 7 chunks (ActiveChunkRadius = 3)
Max sight range:  10 Unity units (DerivedStatsData default SightRange), 100 cells at 0.1
Max fog range:    15 Unity units (AreaService.GlobalMaxRangeUnits), 150 cells at 0.1
Skill max range:  10 Unity units (AreaService.SkillMaxRangeUnits), 100 cells at 0.1
```

Ranges are authored in Unity units and converted with `GridMetrics.InvCellSize`, so a finer grid means longer reaches in cells, larger query slots and larger shadowcast neighbourhoods.

### Coordinate System

- Cell coords are 0-based relative to world origin (subtracted in `FloorToCell`)
- Chunk coords derived via `GridMath.FloorDiv` — handles negative values correctly
- Chunk coords index `WorldGrid`'s `GridChunk[ChunksX, ChunksY]` directly. The world origin is the grid's bottom-left corner, and `IsValidChunk` / `IsValidCell` bound the coords
- `CellToLocal` uses `GridMath.PositiveMod`, so a cell coord outside the grid still resolves to a valid local index
- The fog working buffer is sized to the level's chunk grid, so world chunk coords index it directly (`FogWorkingBuffer.ChunkOffset`)

### Camera Focus Point

Active chunk region centers on the camera focus point. `ChunkManager` recentres it only once the camera's chunk is more than `RecentreDistance` (1) chunks from the current centre on either axis, and fires `OnCameraChunkChanged` with the new centre. Panning back and forth across one border therefore does not re-stream the region.

---

## 3. World Grid & Chunk System

### Cell Data Encoding

Cells are `ushort`:

|Bits|Field|Encoding|
|---|---|---|
|0–14|Floor height|Fixed point, 1 unit = 100 counts (ceiling 327.67)|
|15|Walkable flag|1 = walkable|

`VoidCell = 0x0000` (`TerrainCell.Void`). The encoding lives in `Core/Areas/TerrainCell`, so jobs decode copied chunks the same way. GPU buffers pack two cells per `uint` (even index in the low half). The shader's floor height in cells is `(cell & 0x7FFF) * HeightToCells`, where `HeightToCells = 0.01 × InvCellSize` is set per level.

Each chunk also keeps `_floorCells`, a second bake with walls and furniture left out. The vision sheet and the skill area lie on it (`followFloor` / `floorOnly`).

### GridChunk Pooling

- `WorldGrid.PrewarmPool(GridConstants.MaxPrewarmedChunks)` fills the pool at level load: the 7×7 region plus one ring (81 chunks, ~112 KB each), capped at the level's chunk count
- Chunks the region leaves are parked (`ParkChunk`). When the pool is empty, `GetChunk` recycles the longest-parked chunk (`Reset` + `ClearBakedData`) before allocating a new one
- `Initialize(chunkCoord)` — clears static cells only on coord mismatch
- `Reset()` — clears dynamic overlay and `_blockedCells`, preserves baked data for coord-matched reuse
- `HasBakedData` + `_bakedCoord` — track validity across pool reuse

### GridChunk.GetMergeBuffer — zero-copy fast path

`SetDynamicBlocked` maintains a `List<int> _blockedCells` of blocked indices.

- When `_blockedCells.Count == 0`, `GetMergeBuffer()` returns `_staticCells` **directly** — no copy, no per-cell merge (both `ChunkManager` call sites are read-only).
- Otherwise it `Array.Copy`s static into the merge buffer, clears the walkable bit only on the blocked indices, and caches the result until a cell write marks it stale (`_mergeStale`).

This replaced the previous unconditional full-buffer merge.

### Obstacle Bake — Synchronous Drain Model

Bakes are scheduled on the job system and drained on the main thread — no `UniTaskVoid` polling, no async state machine, no per-chunk `CancellationToken`.

`ChunkManager.Update(focusPosition)`:

1. `FlushDirtyChunks` — re-uploads runtime geometry changes, fires `OnChunkDirty`
2. `DrainPendingBakes` — scans completed bakes and finalizes each by its kind
3. When the camera strays past `RecentreDistance`: `UpdateActiveRegion` (deactivates and parks out-of-range chunks, then rebuilds the desired set ring by ring outward from the camera) + `OnCameraChunkChanged`
4. `ActivatePendingChunks`
5. `StartQueuedBakes` — starts queued bakes while fewer than `MaxConcurrentChunkBakes` (8) are in flight

At most `MaxActivationsPerFrame` (4) chunks become resident per `Update`, nearest the camera first. A baked chunk over the budget waits for the next frame.

`ActivatePendingChunks`:

- Ready chunks (already baked, non-void) → `ActivateReady` while the frame's activation budget lasts
- Unbaked chunks → `ScheduleBake(Activation)`: the coord joins `_bakingChunks` (`HashSet`) and the job starts into `_pendingBakes` (`List<PendingBake>`), or waits in `_bakeQueue` when 8 bakes are already in flight

`PendingBake` is a `readonly struct { Int2Data Coord; IBakeJob Job; BakeKind Kind; }`. `BakeKind` is one of:
- `Activation` — ends in a GPU upload.
- `Rebake` — a resident chunk whose geometry changed, from `RequestRebake` / `RequestRebakeAll`.
- `Background` — from `RequestBake`: a heightfield-only bake of an off-region chunk, which a query centred outside the region reads off the CPU. Fires `OnChunkBaked`.

`DrainPendingBakes` iterates `_pendingBakes`, and for each `job.IsComplete`:

- Removes from `_pendingBakes` / `_bakingChunks`
- `Background` → copy into the chunk, return the job, fire `OnChunkBaked`
- `Rebake` → copy in, re-upload the existing buffer, fire `OnChunkDirty` (the result is dropped if the chunk left the region meanwhile)
- `Activation`: if the chunk is no longer desired (or disposed) → reset + return the job to the pool, skip
- Else `chunk.CopyBakedDataFrom(job)`, return the job, and `ActivateReady` if the activation budget allows

`ActivateReady` uploads the merge buffer to a GPU obstacle buffer, marks the chunk clean, and fires `OnChunkActivated`.

`Update` stays synchronous — it schedules and drains, never blocks.

### Bake Job & Buffer Pooling

**`UnityBakeJobFactory`** — pre-warmed with `MaxConcurrentChunkBakes` (8) jobs. Each `UnityBakeJob` allocates its `Allocator.Persistent` `NativeArray`s once at construction: two raycast sets (full and floor-only), about 3 MB of native memory per job. `Reset()` prepares for reuse.

**`UnityObstacleBufferFactory`** — pre-warmed with `ActiveChunkCount` (49) buffers. Each holds a 32 KB `ComputeBuffer` (two cells per `uint`), reused via `Reinitialize(coord)` and never disposed between uses.

Both factories implement `IDisposable` and dispose all pooled instances at teardown.

---

## 4. Height & Vision Model

### Sightline Test (2.5D ray march, terrain only)

`Shadowcast.compute` runs one thread per ray: `8 × radius` rays, one to each cell on the perimeter of the query's bounding square, and one z layer per query. Each ray marches outward carrying the steepest slope seen so far. It tests terrain height only. There is no separate obstacle layer: walls occlude because the bake gives them floor height.

```hlsl
revealerEye = revealerFloor + EyeOffset
visible     = (floorH + EyeOffset - revealerEye) / dist >= maxSlope   // a cell is seen at eye height above it
maxSlope    = max(maxSlope, (floorH - revealerEye) / dist)
// void (no bake, or outside the query's neighbourhood block) blocks the rest of the ray
```

Cone and line queries apply `InCone` / `InLine` on top of the sightline test. `EyeOffset` is `TerrainSightline.EyeHeight` (1.8 Unity units) converted to cells. `TerrainSightline` (`ISightline`) runs the same test on the CPU for one pair of points, except that unbaked ground never blocks. `Sight.Reaches` shares it between casts, the AI's rehearsal and enemy awareness.

### Output Mask Addressing

```hlsl
// Shadowcast write — row-major (local to the query's own diameter)
uint bitIndex = localY * diameter + localX;     // diameter = 2*radius + 1

// Explored / vision state — column-major
int bitIndex = chunkLocalX * ChunkSize + chunkLocalY;
```

`AreaVisibilityTracker` and the local-area blit both decode the shadowcast mask **row-major at the query diameter**.

### Multi-Revealer Mask

There is no OR merge. `CompactSlots` (`ShaderUtils.compute`, via `MaskCompactor`) copies each of an area's query slots, in order, into that area's own compact buffer, so query `q` occupies the words from `q × SlotSize` on. Every decoder (`AreaVisibilityTracker`, `FogOfWarResolver`, and `ProjectVision` via `QuerySlotBase`) reads query `q` at that offset with its own center and radius. Areas in one batch that ask for the same query shape share one dispatched slot (`TryFindDispatchedSlot`).

### Cross-Chunk Neighbourhood

`CrossChunkQueryBuilder` — one instance per `ShadowcastProcessor` (not shared between batches). Each query gets a `NeighbourSide × NeighbourSide` block of chunks, where `NeighbourSide = ceil((2·maxRange+1) / 128) + 1` for the batch's reach in cells, so a reach longer than a chunk is not clipped at chunk edges. Chunk cells come from a pool of up to 96 chunks (`MaxPoolChunks`), mirrored on the CPU. The pool includes off-region chunks baked in the background.

---

## 5. Area Pipeline

### AreaService

Central coordinator — owns all area-system wiring for a scene. Initialized by `AreaInstaller`.

**Setup methods (called in order):**

- `SetupGlobalBatch` — creates the global `QueryBatch` + `ShadowcastProcessor`
- `SetupLocalBatch` — creates the local `QueryBatch` + `ShadowcastProcessor`
- `SetupFogOfWar` — runs only when the level leaves fog on (`LevelDefinition.FogEnabled`). Creates the fog renderer (own `AreaMeshBuilder`, `ownsStaticData: true`, `subscribeMeshEvents: true`), resolver, streamer, a working buffer sized to the level's chunk grid, and the savable
- `SetupVisionArea` — vision renderer (own `AreaMeshBuilder`, `ownsStaticData: true`, `subscribeMeshEvents: true`, `followFloor: true`), resolver, party revealer source, plus an `OutsiderRevealerSource` that lets Colt light the vision area before he joins (demo only)
- `SetupPartySight` — a third global-batch area. It sweeps the party's sight for the CPU and hands each readback to `PartySightConcealer`, which conceals entities outside that sight. Registered with `RevealableRegistrar`
- `SetupSkillArea` — creates `SkillAreaService` (world grid, local batch, converter, entity source, chunk manager, **`RevealableRegistrar`**, blit shader, skill material, world origin, `SkillMaxRangeUnits`)
- `SetupSurfaces` — `SurfaceRegionRenderer`, skipped when no surface compute shader is assigned (§17)
- `SetupMaterialWarmup` — draws the skill and surface materials once over the vision mesh, so their first real draw does not stall

`Initialize` also registers a `SurfaceSavable`.

**Fog and vision each own a separate `AreaMeshBuilder`.** They were previously a single shared builder; sharing caused a one-frame "old texture on new mesh" flicker on region shift because the two renderers resolve on independent GPU schedules and would move the shared mesh out from under each other. Separate meshes removed the flicker. The surface renderer owns a third mesh (§16 gives what each costs).

**`IAreaService`** (Systems) exposes `ISkillAreaService SkillAreaService`.

### AreaPipeline

```
ProcessFrame()
  → cameraCell = converter.FloorToCell(cameraPosition)
  → ChunkManager.Update(cameraPosition)
  → foreach batch: batch.ProcessFrame(cameraCell)
  → (editor) AreaDebugBridge.CaptureFrame
```

### QueryBatch instances

- **Global** — fog + vision + party sight, `SlotSize = ComputeSlotSize(GlobalMaxRangeCells)` (15 Unity units in cells: 150 at 0.1), `MaxSlots = 32`
- **Local** — skill area, `SlotSize = ComputeSlotSize(SkillMaxRangeUnits in cells)` (10 Unity units: 100 at 0.1), `MaxSlots = 32`

`Register` throws for an area whose `MaxRange` needs a bigger slot than the batch holds. A query longer than its area's `MaxRange` is clamped, with a one-time warning.

`ComputeSlotSize(r) = ((2r+1)² + 31) / 32` uints.

---

## 6. AreaCore & AreaDefinition

### AreaCore Dirty States

There is one dirty flag and no `Continuous` state. `QueryBatch` schedules an area only while it is dirty.

```
MarkDirtyOnce()  → IsDirty = true, MarkCount++
dispatch         → the readback callback remembers MarkCount and Generation
resolve          → ClearDirtyUnlessMarkedSince(dispatchedMarkCount)
Invalidate()     → Generation++  (a result dispatched under an older generation is dropped)
```

A mark that arrives while a sweep is in flight keeps the area dirty for another pass. Adding or removing a revealer or revealable marks the core dirty. Every area, vision included, is re-marked by its sources: a revealer changing cell (or turning, for cone and line aims), a sight-range change, and chunk activate, dirty and bake events.

### AreaDefinition

Constructor args: `name, core, queryProvider, resolver, algorithm, maxRange, persistence = None, visibilityTracker = null`. There is no renderer or scheduling argument: the resolver draws.

- `visibilityTracker` non-null ⇒ `TrackVisibility` on. Fog, vision and party sight pass none; the skill area passes a real one.
- `persistence` is `PersistencePolicy.None` or `TileBased` (fog).
- Caches `AlgorithmName`/`PersistenceName` strings at construction to avoid `enum.ToString()` allocation in editor debug capture.

---

## 7. QueryBatch Internals

**ProcessFrame sequence:**

1. `_dispatchedThisFrame.Clear()`
2. `FlushPendingUnregisters` — deferred unregister applied at frame start
3. `FullClear` on first frame
4. `ClearUsedSlots` (always runs: readbacks source each area's compact buffer, not the shared slots)
5. `SlotAllocator.Reset`
6. `BuildSchedule` (dirty areas without a pending readback) → `CollectQueries` → `DispatchQueries` → `CompactAndRequestReadbacks`
7. On readback complete → `ResolveArea`

`CollectQueries` reuses a slot already dispatched this frame for the same algorithm and query shape. When slots run out partway through an area, it rolls the whole area back to wait for a frame where it fits, because a partial result would clear the dirty mark for the revealers it dropped.

### CollectQueries — anchor write-back

`AreaRuntimeState` is a **struct**. `CollectQueries` reads it, sets `state.AnchorCell` from the first query's center, and **must write it back** (`_runtime[area] = state;`) — otherwise the anchor update is lost on the copy and `ComputeScore`'s distance term reads a stale `(0,0)`, flattening locality scoring.

### CompactAndRequestReadbacks guards

Each area group is skipped unless it is still live and consistent: `_runtime.ContainsKey` **and** `_compactBuffers.ContainsKey`, and not in `_dispatchedThisFrame` (`BuildSchedule` has already left out areas in `_pendingReadbacks`). The `ContainsKey` pair prevents a crash when an area (e.g. the skill area) is unregistered mid-flight.

GPU-resolved areas (vision, via `IGPUAreaResolver`) consume the compact buffer on the GPU, with no readback and no CPU scatter, and are post-resolved in the same frame.

### ResolveArea — empty-resolve guard (one-shot correctness)

```
if area unregistered: return
_pendingReadbacks.Remove(area)            // always, so a fresh dispatch can follow
if result.Queries.Count == 0 or cb.Generation != core.Generation: return   // do NOT consume dirty
resolver.OnResolved(...)                  // the resolver renders
if TrackVisibility: visibilityTracker.Update(...)
PostResolve(area, cb.MarkCount)           // ClearDirtyUnlessMarkedSince — only on a real resolve
```

A null readback (`DropReadback`) also leaves the area dirty.

An empty resolve renders nothing, so it must not consume the dirty flag — otherwise a one-shot (`DirtyOnce`) area can lose its single update to an empty pass and never draw. Leaving it dirty lets it re-dispatch and resolve for real. `PostResolve` (which calls `Core.ClearDirtyUnlessMarkedSince`) runs only for non-empty, current-generation resolves.

### Deferred unregister

`Unregister` adds to `_pendingUnregister` and removes the area from `_pendingReadbacks`/`_dispatchedThisFrame`. `FlushPendingUnregisters` (start of `ProcessFrame`) removes runtime + compact buffer. Avoids mutating collections mid-iteration and racing in-flight readbacks.

**`_dispatchedThisFrame`** — caps an area at one dispatch per `ProcessFrame`, even if a readback completes within the same Unity frame.

**`AreaSystemUpdater.Tick`** — `_timer = 0f` (not `-= RefreshRate`) prevents debt accumulation; the whole area-system update (renderer ticks, camera position, `ProcessFrame`) runs at most once per Unity frame, gated to 30 Hz. Only the skill area's fade and the surface particles' emit run every frame, ungated.

---

## 8. Area Types

|Area|Batch|Kernel|Persistence|Dirty|Renderer|Status|
|---|---|---|---|---|---|---|
|Fog of War|Global|PersistentBlit|TileBased (FogWorkingBuffer)|DirtyOnce|MultiChunkRenderer|active (per level, `FogEnabled`)|
|Vision Area|Global|ProjectVision (GPU)|None|DirtyOnce|MultiChunkRenderer|active|
|Party Sight|Global|— (CPU readback)|None|DirtyOnce|none — `PartySightConcealer` conceals entities outside it|active|
|Skill Area|Local|BlitLocal|None|DirtyOnce|AreaRenderer|active|
|Elemental Area|—|—|—|—|—|superseded by effect surfaces (§17), which are not a `QueryBatch` area|
|Movement Area|Local|BlitLocal|None|DirtyOnce|AreaRenderer|planned|

---

## 9. Rendering

### Compute Shader Kernels (`Blit.compute`)

- **`PersistentBlit`** — fog, monotonic reveal, column-major (`id.x*ChunkSize + id.y`), offset write. `alpha = min(current.a, 1 - revealed)`.
- **`Blit`** — direct overwrite, column-major, offset write. `alpha = 1 - visible`. Vision's registered blit kernel, though vision resolves through `ProjectVision`.
- **`ProjectVision`** — vision GPU projection, one dispatch per query. Reads query `q` row-major at `QuerySlotBase = q × SlotSize`, writes region-local texels offset by `RegionOriginCell`, and skips cells whose chunk isn't in `ActiveChunkMask` (one bit per chunk of the 7×7 region, a `uint4`). Punches visible cells to alpha 0 over a region cleared by `ClearToFloor`.
- **`BlitLocal`** — skill, row-major (`id.y*ChunkSize + id.x`, with `ChunkSize` set to the query diameter), circle mask (`radius = ChunkSize/2`). **Writes with offset** (`TargetTexture[int2(OffsetX+id.x, OffsetY+id.y)]`) so a sub-range query lands centered in the fixed field. Inside the circle `alpha = visible AND floor` (the floor mask leaves walls uncovered); outside it alpha is 0.
- **`ClearToFloor`** — replaces `Clear`. Sets alpha 1 where the region has floor (from the chunk floor mask) and 0 where it has none. Used by fog and vision (unexplored = opaque, nothing drawn off the floor).
- **`ClearTransparent`** — resets texture to `(0,0,0,0)`. Used by the skill field (outside-the-disc = invisible). Required because `BlitLocal`'s offset write no longer clears cells outside the query block.
- **`SmoothAcross` / `SmoothDown`** — a separable Gaussian blur (radius 3), run by `AlphaSmoother` after every paint of fog, vision and the skill field. Alpha ends as the covered share of the floor in reach, so the cell-edge staircase softens without walls thinning it.

Other shaders: `Shadowcast.compute` (§4), `ShaderUtils.compute` (`CompactSlots`, `ClearBufferRange`), `Surfaces.compute` (§17).

### MultiChunkRenderer (fog, vision)

Generic, reusable. The constructor selects the blit kernel (`PersistentBlit` for fog; `Blit` for vision, which resolves through `ProjectVision`), `subscribeMeshEvents`, `ownsStaticData` and `followFloor` (vision lies on the floor-only bake). **Both fog and vision own their static data and subscribe to chunk events** (each has its own mesh). The region texture is `ActiveChunkDiameter × 128` = 896 texels square, RGBA8, plus the smoother's two textures of the same size.

**Async sync model** — nothing blocks; the mesh is scheduled async and applied in `Tick`. The texture repaints in the same `Tick` the mesh applies, so origin and texture never disagree:

- `Tick()` → `EnsureMeshScheduled()`. On mesh apply it flips `_meshTargetOrigin` → `_currentRegionOrigin`, marks the texture stale (texels address cells by their place in the region), shifts the floor mask, and calls `Paint()`.
- `EnsureMeshScheduled` (gated on `HasPendingJob`): region-shift takes priority (sets target origin, builds static data first time, schedules rebuild), else a `_contentDirty` rebuild at the current origin.
- `RequestBlit(blit, repaint)` caches an incremental blit delegate and a full repaint delegate. It paints immediately only if there is no region shift and no pending job. When the texture is stale, `Paint` runs a `ClearToFloor` and then the repaint; otherwise it runs the blit. Either way it then runs the smoother.
- `OnChunkActivated` / `OnChunkDirty` record the chunk's cells as dirty and, for a chunk in the target region, set `_contentDirty` and `_textureStale`. N activations coalesce into one rebuild that redoes only the dirty cells.
- Both resolvers cache their blit delegates (zero per-frame closure allocation). `ApplyPendingRegionOrigin` was removed.

**Show timing** — vision defers `Show()` until its first `OnResolvedGPU`, ensuring the mesh job has completed before `SetActive(true)`; avoids a `WaitForGPU` pipeline stall.

### AreaMeshBuilder — adaptive tiles, incremental rebuild

Vertices are one `NativeArray<MeshVertex>` where `MeshVertex { float3 Position; float3 Normal; }`; UVs are a second array.

- `BuildStaticData` declares Position + Normal in **stream 0**, UVs in **stream 1**, and 32-bit indices.
- `Apply()` uploads stream 0, stream 1 and the index buffer with `SetVertexBufferData` / `SetIndexBufferData` under `SilentUpdate = DontRecalculateBounds | DontValidateIndices | DontResetBoneBounds | DontNotifyMeshUsers`, then sets the submesh and the bounds.
- Bounds are set manually from a `ComputeBoundsJob`.

**Adaptive tiles.** The region (896 cells square for fog, vision and surfaces; 201 for the skill field) is meshed in 16-cell tiles. Each tile picks a vertex step from 2 to 16 cells against a 5 cm overshoot / 1 mm undershoot tolerance. That gives about 12.5k vertices on flat ground and at most ~254k (1.2M indices) with every tile at its finest. Mesh buffers start at 8 vertices / 24 indices per tile. When an emit outgrows them they grow with a quarter of headroom and the emit reruns; the mesh keeps drawing its old buffers until the new ones are filled.

**Jobs & dependency chain:** `ShiftRegionJob` (only when the region moved) → `SmoothHeightsJob` per changed rectangle (dilate + blur of floor heights, radius 4, to round off wall footprints) → `TileLevelJob` → `TileOffsetsJob` → `EmitTileMeshJob` → `ComputeBoundsJob`.

**Incremental rebuild.** `ScheduleVertexRebuild(..., dirtyCells)` keeps the heights both regions share (and, on a tile-aligned shift, the tile steps). It re-smooths only the strips a move uncovered plus the dirty cells, each grown by the smoothing reach; `dirtyCells == null` redoes the whole region. It is guarded by `if (HasPendingJob) return;` and takes `chunksPerRow`, `regionChunkOriginX/Y` for non-chunk-aligned regions.

### AreaRenderer (local areas)

Fixed-field renderer for the skill area:

- **Built once at `_maxRange`**, by `SkillAreaService`'s constructor at area-service setup, and kept until the scene's area service is disposed — _not_ per-session. The field is always `2*_maxRange+1` (diameter 201 at a 0.1 cell size); the texture, mesh, and mask buffer are all this fixed size. `maskBuffer = ComputeSlotSize(_maxRange)` to match the batch's fixed slot output.
- A skill's **window radius** drives only which cells the query lights, never the geometry. Short-range skills light a smaller centered disc; cone and line skills light different subsets of the same field (the shadowcast's `InCone` / `InLine`).
- `SetQueryCenter(center, radius)` stores center + radius. Only when the center moved does it flag a mesh rebuild, which `Tick` schedules (always the full field, centered on the caster). A sheet coming up stays hidden until the mesh reaches the new center (`Present`); a sheet already up follows a few cells behind.
- `Render(mask, count)` decodes at the **query diameter** and centers the block via `OffsetX/Y = (diameter - queryDiameter)/2`. It dispatches `ceil(diameter/8)` thread groups over the full field, and the kernel skips threads past the query block. This is what lands the disc on the caster. Before the blit it clears the texture if the query shrank and uploads the floor mask if stale; after it, it runs the smoother.
- `Clear()` uses `ClearTransparent` over the full field.
- Subscribes to `OnChunkActivated` to rebuild the mesh when overlapping terrain arrives. `OnChunkDirty` / `OnChunkDeactivated` only record dirty cells and wait for the center to move. Terrain sampling via `AreaCellDataExtractor.Fill(floorOnly: true)`. Opacity fades in over 0.12 s and out over 0.1 s (`SetOpacity`, driven by `SkillAreaService.Fade`).

---

## 10. Fog of War

### Persistence Architecture

**`FogWorkingBuffer`** — mmf in `temporaryCachePath`, scene lifetime, sized `chunksX × chunksY × 2 KB` for the level. The file name is per run (`FogWorking_<run>.mmf`), and files a crashed run left behind are deleted at startup once they are over a day old. All reads/writes go here. `OpenMapping`/`CloseMapping` wrap mmf creation/teardown; `Create` delegates to `OpenMapping`, `Dispose` to `CloseMapping` and deletes the file. `Zero` recreates the file. `Exists`/`Load`/`Save`/`Flush` are null-guarded against a closed accessor (the mmf is closed while a load copies the body in). The save and load copies use `FileStream` directly to avoid `MemoryMappedViewAccessor` overhead on Mono.

**`FogPersistenceStore`** — one file per slot and level, `<SavePaths.Root>/AreaTiles/<slot>/fog_<levelId>.fog`: a `FogFileHeader` (chunk counts, cell size, world origin) followed by a flat copy of the working buffer.
- Save (`StageAsync`) flushes the buffer and writes header + body to `.fog.tmp` on the thread pool. `Commit` promotes it with `File.Replace` once the main save file is on disk.
- Load (`LoadAsync`) skips a file whose header or size does not match this level. Otherwise it closes the mapping, copies the body into the mmf on the thread pool, and reopens in a `finally`; `FogSavable` then calls `ReloadActiveTiles`.
- A version-1 slot's shared `fog.fog` is discarded on load.

```
New Game  → FogSavable.Reset → FogWorkingBuffer.Zero() (recreates the file) + clear explored states
Save      → FlushAll (resident chunks → mmf) → Flush → header + body to .fog.tmp → Commit (File.Replace)
Load      → clear states, Zero → header check → CloseMapping → copy body → OpenMapping → ReloadActiveTiles
Quit      → FogWorkingBuffer.Dispose() (mmf deleted)
```

### Explored State

- One `uint[512]` per chunk (128×128 / 32), bits only ever set (permanent reveal).
- Pooled via a **size-based free list** (`Stack<uint[]> _freeStates`): `OnChunkDeactivated` pushes the array back, `GetOrCreateExploredState` pops + `Array.Clear`. Reactivation restores prior state from the mmf round-trip. This removed the per-never-seen-chunk `new uint[512]` GC spikes during exploration.
- `_changedChunks` tracks resident chunks whose exploration grew since the texture last showed them. The streamer's `OnChunkDeactivated` always saves to the working buffer before the resolver frees the array.
- A query that reaches chunks outside the streamed region projects into them too. Their state is rented, seeded from the working buffer, written back when it gains a cell, and freed (`_transientStates`), so a revealer sent away from the camera still explores the map.

### Save-on-Load ordering

Tile loads are synchronous (`LoadTile`), and every working-buffer read is null-guarded against the closed accessor while a load copies the body in. `GlobalTileStreamer.OnChunkActivated` loads nothing while `_pendingReload` is set. `ReloadActiveTiles` is the single load entry after the working buffer is set, and `FogSavable.RestoreAsync` calls it once the copy is done.

### Tile Loading

`LoadTile` reads a chunk's stored exploration into a scratch array and ORs it onto the live state, which may already hold reveals made before the chunk was resident. It then queues the chunk for the texture (`MarkChunkChanged`). There is no async spreading or cancellation. `_pendingReload` is set on `SetWorkingBuffer` and triggers `ReloadActiveTiles` on the first `OnCameraChunkChanged` after the store is set.

---

## 11. Vision Area

### Design

Current-frame visibility only — no accumulation. Resolved entirely on the GPU (`ProjectVision`): the compacted mask is projected into the region texture. Visible cells are punched to alpha 0 over a field cleared to alpha 1 wherever there is floor, cells whose chunk isn't active are skipped, and the smoother then softens the result. No readback, no CPU scatter.

### Show Timing

Vision calls `Show()` from `OnResolvedGPU`, not on region change — by then the mesh job has completed naturally, avoiding the `WaitForGPU` stall that `SetActive(true)` triggers while a Burst mesh job is in flight.

### Scheduling & Region Shift

Scheduled only while dirty. It is re-marked when a party member (or the demo outsider) changes cell or sight range, on chunk activate / dirty / background bake, and on a region change. `_dispatchedThisFrame` caps it at one dispatch per `ProcessFrame`. On region shift the resolver hands the renderer the new origin (`SetRegionOrigin`). When the mesh for it applies, the renderer adopts the origin, marks the texture stale and replays the last projection as its repaint. There is no extra mesh rebuild beyond the standard `Tick` path.

---

## 12. Skill Area

### Design

- One caster (or N via `ManualRevealerSource`), local `QueryBatch`, not persistent.
- One-shot per aim: `MarkDirtyOnce` per `BeginTargeting`. It is re-marked only when the caster changes cell or turns more than 1° (cone and line aims follow the facing), or when the revealable set changes.
- `AreaRenderer` fixed field (see §9) — built once, reused across sessions.
- `EndTargeting` releases at once: `_core.Invalidate()` drops in-flight results, `_core.ClearDirty()` stops scheduling, the revealers are cleared and the tracker reset. The drawn area then fades out over 0.1 s, after which `Deactivate` clears the renderer (`ClearTransparent`) and hides it.

### Range integration

`BeginTargeting(EntityId casterId, RangeProfile range, Func<Vector3Data, Vector3Data, float> reach = null)`, where `reach` caps a line's length from the caster's position and facing. The window's max distance drives the **reveal radius** (which cells light), independent of the caster's sight range:

```
ResolveRadius(window):                                   // Unity units
  if window.Max >= float.MaxValue: return _maxRangeUnits // unbounded clamps to the batch ceiling (10)
  return clamp(window.Max, CellSize, _maxRangeUnits)     // cap is mandatory (slot budget)
ToCells(units) = max(1, ceil(units × InvCellSize))       // the renderer's query radius
```

The radius flows to `_revealerSource.Add(caster, radius, coneAngle, lineWidth, reach)` and, in cells, to `AreaRenderer.SetQueryCenter`. `RangeProfile { Window: RangeBounds, Shape: AreaShape, ConeAngle, LineWidth }`; `RangeBounds` is min-inclusive / max-exclusive. Cone and line shapes are wired: `ShapedQueryProvider` emits cone and line queries, and the shadowcast kernel masks them (`InCone` / `InLine`). The `Window.Min` donut is not wired.

### Target selection (visibility tracker)

The skill definition carries a real `AreaVisibilityTracker`, which counts an actor as inside when any cell of its base (`AgentBodies.Radius`) is lit. The skill core is fed the same revealables as party sight via `RevealableRegistrar.AddArea`. As the resolved area reports revealables entering/exiting, `SkillAreaService` maintains:

- `EntityIdSet InAreaEntities`
- `event Action OnAreaChanged`

`TargetingPresenter` (Engine) is reactive:

- **`SelfTargetStrategy`** creates no area — it highlights the caster directly.
- **Every other strategy** (area and ground skills included, and the AI's aim preview through `ISkillAimView`) subscribes to `OnAreaChanged`, calls `BeginTargeting`, and highlights the intersection of `InAreaEntities` and the strategy filter, diffing against the currently-subscribed set (highlight/clear deltas; selected targets stay subscribed). An immediate refresh after `BeginTargeting` picks up an already-resolved set when re-targeting the same skill.

The valid-target set holds from one resolve to the next. It changes only when the area re-queries: the caster changes cell or turns, the revealable set changes, or a new `BeginTargeting` arrives. `TargetingPresenter.End` unsubscribes and calls `EndTargeting`. The empty-resolve guard in `QueryBatch.ResolveArea` (§7) keeps an intermittent empty resolve from consuming the one-shot dirty.

---

## 13. Revealers & Revealables

### Revealer Sources

- **`PartyRevealerSource`** — party members, one `AgentRevealer` each on the member's current `SightRange`. Marks its areas dirty when a member changes cell or its sight range changes. Used by fog, vision and party sight.
- **`ManualRevealerSource`** — skill casters, explicit `Add`/`Remove`/`Clear`, with optional cone angle, line width and line reach.
- **`OutsiderRevealerSource`** — one agent outside the party (demo: Colt lights the vision area until he joins).
- **`FactionRevealerSource`** — planned, per-faction vision.

All use push-based revealers via `IEntity.OnPositionChanged`, updating only on cell change. Cone and line revealers also follow `IFacingEntity.OnFacingChanged` past a 1° turn.

### RevealableRegistrar

Owns the `EntityRevealable` per entity and feeds them to registered areas.

- `_revealables` is populated **unconditionally** on `OnEntityRegistered`, independent of whether any area has been added yet, and that includes the constructor's initial sweep over `IEntityRegistry.All`. Only the area-adding is gated on `_areas`.
- `AddArea` **back-fills** existing `_revealables** into the area's core and is additive. `SetAreas` no longer exists. Party sight and the skill area are added; fog and vision are not, since they track no revealables.
- `OnEntityUnregistered` null-guards `_areas`.

### EntityRevealable

Exposes `EntityId`, `GridPosition` (push-updated on cell change), `IsTargetable` (always true) and `HasBase` (true for actors; the skill tracker tests these by footprint). `GridPosition` is in the same cell space as query centers.

### AreaVisibilityTracker

`Update(revealables, result)` builds `VisibleRevealables` via `IsFootprintVisible` → `IsVisibleInAnyQuery`. That decodes row-major at the query diameter, reading query `q` at `q × SlotSize`, and checks `IsTargetable` + `GridPosition`, then each cell of the revealable's base when the tracker was given a footprint. `DetectTransitions` then fires enter/exit against the previous frame's set. `Reset()` forgets both sets.

**Empty-resolve guard:** the tracker no longer has its own. `QueryBatch.ResolveArea` skips the tracker on an empty (or stale-generation) resolve, which is "no new information," not "everyone left." Without that, the next idle resolve would fire exit for all revealables and clear the highlights.

Fog, vision and party sight pass no tracker; only the skill area consumes the enter/exit callbacks.

---

## 14. Frame Lifecycle

```
AreaSystemUpdater.Tick (every Unity frame)
  → skillAreaService.Fade(dt), surfaceRenderer.Emit(dt)       (every frame)
  _timer += deltaTime; if _timer < RefreshRate: return; _timer = 0f
  → pipeline.SetCameraPosition(focusPoint)
  → fogRenderer.Tick()      → EnsureMeshScheduled → TryApplyPendingMesh → Paint on apply
  → visionRenderer.Tick()   → EnsureMeshScheduled → TryApplyPendingMesh → Paint on apply
  → skillAreaService.Tick() → AreaRenderer.Tick → TryApplyPendingMesh / schedule rebuild
  → surfaceRenderer.Tick()
  → materialWarmup.Tick()
  → pipeline.ProcessFrame()

AreaPipeline.ProcessFrame (30 Hz, ≤ once per Unity frame)
  → cameraCell = FloorToCell(cameraPosition)
  → ChunkManager.Update(cameraPosition)
      FlushDirtyChunks
      DrainPendingBakes → Activation: ActivateReady → OnChunkActivated
                          Rebake: re-upload → OnChunkDirty
                          Background: OnChunkBaked
      if camera strayed past RecentreDistance:
        UpdateActiveRegion → deactivate + park out-of-range
        OnCameraChunkChanged → fog/vision/surface renderers get the new region origin
      ActivatePendingChunks → ready: ActivateReady (≤ 4 per frame); unbaked: schedule or queue a bake
      StartQueuedBakes (≤ 8 in flight)
  → globalBatch.ProcessFrame(cameraCell)
      FlushPendingUnregisters → BuildSchedule → CollectQueries → DispatchQueries → CompactAndRequestReadbacks
        Vision: GPU ProjectVision (no readback) → Show() on first resolve
      readback complete → ResolveArea (empty / stale resolves skipped, don't clear dirty)
        Fog: ProjectIntoChunks → blit changed chunks
        Party sight: PartySightConcealer conceals entities outside it
  → localBatch.ProcessFrame(cameraCell)
        Skill: ResolveArea → SkillAreaResolver → AreaRenderer.Render + AreaVisibilityTracker.Update → OnAreaChanged
```

---

## 15. Performance

### Zero Hot-Path Allocation

|Operation|Mechanism|
|---|---|
|Chunk bake jobs|Pre-warmed pool of 8 (`MaxConcurrentChunkBakes`), NativeArrays reused via `Reset()`; further bakes queue|
|Chunk buffers|Pre-warmed pool of 49 (`ActiveChunkCount`), ComputeBuffer reused via `Reinitialize()`|
|GridChunk objects|Pool filled at level load (up to 81); parked chunks recycled before allocating|
|Merge buffer|Zero-copy `_staticCells` return when no dynamic blocks; the merged copy is cached until a cell write|
|Explored state|Size-based free-list pool (`Stack<uint[]>`)|
|Vision projection|GPU only (`ProjectVision`), no CPU mask|
|Mesh upload|`SetVertexBufferData` (interleaved stream 0 + UV stream 1) and `SetIndexBufferData` with silent update flags; buffers grow with headroom, not per rebuild|
|GPU readback|Pooled request state per size (`NativeArray<uint>` + `uint[]`)|
|Readback callback|Pooled `ReadbackCallback` with pre-allocated `List<ScheduledQuery>`|
|Blit delegates|Cached per resolver — no per-frame closures|
|Working buffer write|mmf write = memory operation|
|Save|Header + body staged to a temp file on the thread pool|
|Debug capture|Gated by `IsWindowOpen`|
|Enum strings|Cached on `AreaDefinition` at construction|

### Async Spreading

- Chunk bakes: scheduled on the job system, at most 8 in flight, drained on the main thread via `DrainPendingBakes` (progressive, no blocking); at most 4 chunks become resident per frame
- Mesh rebuilds: Burst jobs scheduled in `Tick`, applied on a later `Tick` once complete
- Surface world-phase planning: snapshotted the frame after a world phase, planned on a worker (`SurfaceWorldPhaseJobRunner`), applied at the next world phase
- Tile loads are synchronous (one 2 KB read per chunk)

### Scheduling

`ComputeScore` weights dirty (1000), distance (up to 100, linear Manhattan falloff over `MaxScoreDistance = 512` cells), and age (10 per frame since the last resolve, cap 200). Only dirty areas are scheduled, so the dirty term is the same for all of them. The `AnchorCell` write-back (§7) is required for the distance term to be live.

### Estimated Frame Cost

These are reasoned estimates, **not profiled numbers** — actual cost depends on hardware, party size (revealer count), camera speed, and target frame rate. Assume a 60 fps target (16.7 ms budget), a mid-range GPU, and ~4–8 revealers. The whole update is gated to 30 Hz, so it runs on roughly every other rendered frame; the amortized per-frame cost is about half the per-tick figures below.

|Scenario|Main-thread CPU|Notes|
|---|---|---|
|Steady state (camera still, no targeting)|~0.1–0.3 ms (~1–2%)|Schedule/query building over ≤32 areas, ≤128 queries; a few compute dispatches. Most real work is GPU shadowcast/merge/blit, typically a fraction of a millisecond.|
|Active exploration (camera panning across chunk boundaries)|brief spikes to ~1–2 ms (~6–12%)|Dominated by the mesh rebuilds on region shift (only the strips the move uncovered are re-smoothed) plus chunk bakes and GPU obstacle uploads — not the query pipeline.|
|Skill targeting|well under the steady-state figure|One extra one-shot local query + a visibility-tracker pass over revealables.|

In the common case the system should sit comfortably under ~2–3% of a 60 fps frame, with brief single-digit-percent spikes while terrain streams in. The dominant cost is **mesh rebuild and upload on region shift**, which the incremental rebuild, the adaptive tiles and the 30 Hz gate are there to contain. Scaling factors to watch: revealer count (more queries/dispatches), max range (larger shadowcast regions, quadratic in radius), and camera speed (region-shift frequency). These figures should be replaced with profiler captures before treating them as a budget.

---

## 16. Memory Budget

|Resource|Size|Count|Total|
|---|---|---|---|
|Chunk obstacle buffer (GPU)|32 KB (2 cells per `uint`)|49 active|~1.6 MB|
|GridChunk pool (CPU)|~112 KB each (static, floor, merge `ushort[]` + dynamic `bool[]`)|up to 81|~9 MB|
|Bake jobs (native)|~3 MB each|8|~24 MB|
|Fog render textures|896×896 RGBA8 ×3 (target + smoother scratch and output)|1 set|~9.6 MB|
|Vision render textures|896×896 RGBA8 ×3|1 set|~9.6 MB|
|Skill render textures|201×201 RGBA8 ×3|1 set|~0.5 MB|
|Surface render textures|896×896 RGBA8 ×2 (cells + smoothed)|1 set|~6.4 MB|
|Query output masks (global)|SlotSize(150) = 2,832 words × 32 slots|1 + 3 compact (fog, vision, sight)|~1.5 MB|
|Query output masks (local)|SlotSize(100) = 1,263 words × 32 slots|1 + 1 compact|~0.3 MB|
|Cross-chunk neighbourhood|96 chunks × 32 KB, GPU + CPU mirror|2 (one per batch)|~6 MB GPU + ~6 MB CPU|
|Explored state per chunk|2 KB|49 resident|~100 KB|
|AreaMeshBuilder (fog, vision, surfaces)|~4.8 MB fixed (heights, cell data) + mesh buffers ~1.1 MB at start, up to ~13 MB|3|~18 MB at start, ~53 MB worst|
|AreaMeshBuilder (skill)|~0.5 MB|1|~0.5 MB|
|FogWorkingBuffer (mmf)|chunksX × chunksY × 2 KB|1|per level|
|**Total**|||**~93 MB at start**, plus the mmf|

Split is roughly **~35 MB GPU** (obstacle buffers, render textures, query masks, neighbourhood blocks) and **~58 MB CPU** at start: bake jobs ~24 MB, mesh builders ~18 MB (growing to ~53 MB on dense terrain), GridChunk pool ~9 MB, neighbourhood mirrors ~6 MB. The level's mmf comes on top. These figures are worked out from allocation sizes at a 0.1 cell size, not measured. A finer cell size grows the query masks with the square of the reach in cells (at 0.05 the global slot is 11,288 words, ~1.4 MB per buffer) and grows the neighbourhood block side. Chunk, texture and mesh sizes are per chunk and do not change. Separate fog and vision meshes are the deliberate cost of removing the region-shift flicker. The skill builder is persistent (build-once), not transient. The builders' CPU-side NativeArrays are staging copies; the GPU-resident `Mesh` vertex/index buffers match their capacities and are additional.

---

## 17. Effect Surfaces

Lingering ground and cloud effects — fire, smoke, caltrops (`SurfaceType`). Skills lay them through `ISurfaceService` (`SpawnSurfaceEffect`), and they are authored in a `SurfaceCatalog`: each `SurfaceData` sets the layer, default turns and radius, spread, and the `IEffect`s run on whoever walks in. They share the area grid's cells, chunks and region mesh but are not a `QueryBatch` area. The simulation is CPU-side in `SurfaceService` (Systems), and rendering is in `SurfaceRegionRenderer` (Engine).

### Storage — blob ids

- A cell stores a `ushort` blob id per layer: `SurfaceLayer.Ground` or `Cloud`. `LayerCapacity` is 3, and the third slot has no name yet. `SurfaceGrid` is sparse: a `SurfaceChunk` (128×128) and its layer arrays exist only while something is painted, and both are pooled. There is no streaming or eviction.
- Type, remaining turns, caster and cell count live once per patch in an `EffectBlob`. `EffectBlobTable` merges patches by union-find, so a merge rewrites a parent, never cells, and a blob cannot split.
- Merged ids are not reclaimed until `Clear()`, which bounds a level session to `ushort.MaxValue` spawns plus merges. Released ids are reused at once, so `SurfaceService` raises `OnBlobRemoved` / `OnBlobConverted`, and any consumer that caches an id must forget it on both.

### Spawning — flood fill

`SurfaceSpawner` converts metres and turns to cells, filling unspecified values from the catalog. `SurfaceFloodFill` spills breadth-first from the impact cell, stopped by the radius, by unwalkable ground and by steps over 0.3 m (`DefaultMaxStepHeight`). A cell is marked visited only when accepted, so coverage does not depend on the order the fill reaches cells.

### The turn pass

`SurfaceTurnDriver` runs one pass per round: on the world phase in combat (`CombatGovernor.OnNonAgentTurn`) and on `TurnCounter.OnAdvanced` outside combat. Each pass runs: contact scan → merge same-type contacts → apply reactions → tick and expire → remove ended patches in one grid sweep. The world phase then also grows the kinds authored to spread (`SurfaceGrowthRule`, reach capped at 128 cells), so fires creep only in combat.

- Merging before ticking lets a short patch absorbed into a longer one inherit the longer life.
- With the grid `Version` unchanged, the scan, merges and reactions are skipped.
- In combat, the phase's reading of the grid is snapshotted the frame after a world phase and planned on a worker (`SurfaceWorldPhaseJobRunner`). The next phase applies the plan only if the grid version still matches; otherwise it recomputes synchronously.
- After the pass, `SurfaceOccupancyService` re-reads every actor's footing (any cell under its base) and runs a patch's effects on whoever entered it. A patch laid mid-round is swept on the next frame, capped at `MaxSweepPasses` (4) for patches that lay others.

### Reactions

`ReactionTable` holds one rule per unordered type pair. Each side `Keep`s, `Convert`s to another type (keeping its cells and turns), or is `Extinguish`ed. Reactions transform whole blobs, act within one layer only, and do not cascade within a turn. `SurfaceCatalog.BuildReactions` builds the table at install and skips, with a warning, any rule that converts across layers or into an unauthored type.

### Rendering

`SurfaceRegionRenderer` keeps a cell texture over the active region (896×896 RGBA8: R = type id, B = per-patch variation, A = presence), a smoothed copy the passes read, and its own `AreaMeshBuilder`. Each surface type is one material pass over the whole region mesh, enabled only while that type is present in the region; presence is a `uint` mask, so only type ids 0–31 can draw. A region shift forces a full repaint. Type 0 (`None`) is empty and never drawn. `SurfaceParticles` and `SurfaceLights` follow the painted cells.