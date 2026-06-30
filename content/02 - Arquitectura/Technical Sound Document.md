# 1\. Introduction

This document sets forth the technical specifications and artistic vision for the sound design of Eternal Dusk. The audio design is structured to support the game's atmosphere, ensuring optimal use of resources and the architectural isolation of the project.

## 1.1 Technical Objectives

* **Immersive Audio:** Spatial positioning and sound propagation consistent with the exploration environment and turn-based tactical spacing.

* **Dynamic Music**: An interactive system that reacts deterministically to sanity, critical combat phases, and narrative tension.

* **Reactive Environment:** Fluid soundscapes that dynamically change depending on regions within the Area System and visibility levels of the fog of war.

* **Low CPU Usage:** Strict management of voice channels, preemptive event pooling in FMOD, and dedicated threads to prevent frame rate spikes (GC Allocs) on the gameplay critical path.

___
# 2\. Production Pipeline

The workflow follows a strictly linear path from the original analog capture and editing to native runtime execution without creating unwanted dependencies:

**DAW (REAPER)  ⟶  Asset Export (WAV)  ⟶  Middleware (FMOD Studio)  ⟶  Engine Integration (Unity)  ⟶  Runtime Playback**

1. **DAW (REAPER):** Creation, master mix, and design of individual assets using destructive processing and analog emulations of degraded tape.  

2. **Asset Export:** Standardized export in high-fidelity linear waveform format without prior compression to prevent cumulative degradation.  

3. **Middleware (FMOD Studio):** Construction of complex events, adaptive modulation using global/local parameters, definition of attenuation curves, and structural snapshot logic.  

4. **Game Engine Integration (Unity):** Asynchronous and segmented loading of sound banks linked to the life cycle of the chunks via the Addressables system.  

5. **Runtime Playback:** Asynchronous offloading to dedicated audio processing threads that are independent of Unity's main rendering thread.

___
# 3\. Export and Compression Specifications

Resources are exported from the DAW at the highest linear resolution, leaving the lossy encoding entirely to FMOD Studio's internal encoder.

| Resource Type          | Sample Rate | Channels    | Source Format  | Final Compression (FMOD bank) |
| ---------------------- | ----------- | ----------- | -------------- | ----------------------------- |
| Short Sound (SFX)      | 48,000 Hz   | Mono        | WAV 24-bit PCM | ADPCM / PCM (By platform)     |
| Long Sound (Music/Amb) | 48,000 Hz   | Mono/Stereo | WAV 24-bit PCM | OGG Vorbis (Variable Quality) |

___
# 4\. Artistic Vision

The world of Eternal Dusk must adhere to four interconnected aesthetic pillars:

* **Decadent Western:** Desolation, aridity, dry winds, and traditional acoustic instrumentation played with a raw edge and unconventional techniques.  

* **Cosmic Horror:** Microtonal dissonances, continuous oppressive subfrequencies, and shifting abstract textures that suggest the imminent presence of cosmic anomalies.  

* **Physical Texture of a Board Game:** High-fidelity sound design that evokes the feel of handling real analog components (resin dice, creaking wood, worn tokens).

## 4.1. Sound Texture

* **Dirty and decaying:** Explicit use of harmonic distortion, emulations of degraded analog tape, and organic background noise to avoid digital sterility.  

* **Mystic:** Dense, infinite, or LFO-modulated reverberations that defy the tangible physical architecture of the explored setting.  

* **Antique Materials:** Mechanical friction from rusty metal, the creaking of dry wooden beams, and the tension of old leather, all treated with rough equalization.  

* **Small, Tactile Sounds:** The focused soundscape should prioritize micro-sounds over the background music: dice rolling, dry parchment pages turning, footsteps on loose gravel.  

* **Dry Wind:** White noise is shaped by desert gusts.  

* **Analog Imperfections:** Intentionally out-of-tune instrumentation, unstable pitch variations (wow & flutter), and organic saturation distortion.  

* **Awkward Silences:** Absence of artificial background sounds; sudden drops in ambient sound levels to emphasize the silence preceding combat encounters.

## 4.2. Aesthetic References

* **Darkest Dungeon:** Physical intensity during critical impacts and acoustic claustrophobia indoors.  

* **Hard West:** An acoustic take on the Old West using minimalist desert-inspired instrumentation and dry guitars.  

* **Inscryption:** Exceptional interactive touch-based audio design, physical user interfaces, and diegetic use of subtle mechanical sounds.

## 4.3. Audio in User Interfaces (UI)

* **Pulsations:** Physical responses based exclusively on mechanical impacts from dense, old wood or solid objects.  

* **Movements:** Transitions and panel openings that mimic the friction and rapid movements of heavy tarps, leather, or dry burlap..  

* **Grounded Resonance:** Confirmations of turns or definitive actions accompanied by deep, muffled impacts combined with the scattering of sand or dry earth.

## 4.4. Instrumentation Suggestions

* **Slide Guitar:** Sustained notes played with a metal bottleneck, erratic tremolos generated by hardware, and direct strumming on the strings.  

* **Broken Banjo:** Dry arpeggios played erratically on out-of-tune instruments or those with old, rusty strings.  

* **Dry Percussion:** Direct strikes on wooden soundboxes, tambourines made of aged leather without a rim, and dragging chain links.  

* **Harmonica:** Muffled notes, forced microtonal bends, and mechanical breathing noises audible through the metal reeds.  

* **Defective Piano:** Isolated notes played on out-of-tune upright pianos, with mechanical friction noises from the pedals and worn hammers.

___
# 5\. Architecture in FMOD Studio

The internal organization of the middleware will be structured hierarchically to maintain an exact correspondence with the primitives and identifiers defined in Unity.

## 5\.1\. Event Hierarchy

* **SFX/:** It contains grouped subfolders (stomps, attacks, vocalizations) and the ‘UI’ subfolder with flat stereo events without spatialization.  

* **Ambience/:** Divided into “Backgrounds” (2D quadraphonic loops linked to chunk streaming) and “Emitters” (positional sound sources with logarithmic attenuation).  

* **Music/:** Modular interactive structures that distinguish low-intensity background music (“Exploration”) from dynamic arrangements based on alternating time signatures (“Combat”).

## **5.2. Banks Strategy**

* **Master.bank:** Global metadata, master routings, shared snapshots, and global injection parameters.  

* **UI\_Shared.bank:** A container of interface samples that are permanently loaded into persistent memory.

* **Zone\_\[Name\].bank:** Lightweight dynamic banks controlled by the Addressables streaming cycle based on the entity's position.

## **5.3. Snapshots**

* **Snapshot\_Sanity\_Crisis:**  Activated proportionally as an agent's “Sanity” resource depletes; applies an aggressive low-pass filter to the music bus and injects harmonic enhancements and unrealistic reflections into the critical effects bus.  

* **Snapshot\_Prison\_Reverb:** It subtly attenuates the low frequencies of continuous ambient noise to optimize the intelligibility of dice rolls and tactical confirmations.

## **5.4. Global Parameters**

* **Global\_Sanity\_Level:** (Continuous, 0.0 to 100.0) Automates analog distortion and the appearance of faulty instrumentation.  

* **Global\_Combat\_State:** (Discrete, 0 or 1\) Controls synchronized crossfade transitions between background music and turn-based combat loops.

## **5.5. Local Parameters**

* **Local\_Emitter\_Distance:** (Continuous) Filtering modulator based on the agent's distance from the mapped cosmic anomaly.  

* **Local\_Material\_Type:** (Labeled) Deterministic modifier for footstep and impact events to dynamically switch between Wood, Earth, Stone, or Rusted Metal.

___
# **6\. Implementation Considerations (Unity C\#)**

* **Internal Contracts:** Audio contracts are pure abstract interfaces in C\#. Concrete implementations will be based on Mono Behaviors.

* **Zero Allocations on Critical Paths:** Instantiating strings or searching for FMOD event paths on the fly (during Update or combat pipelines) is strictly prohibited. Events are resolved using injected ‘EventReference’ objects or precalculated 32-bit numerical hashes.

* **Simulation and Value Types:** Changes to the audio environment based on the state of the world are read directly from value type snapshots provided by the resource simulation system, ensuring reliable predictability for the AI.

___
# **7\. Herramientas del Editor**

To ensure deterministic resolution, the use of text strings to identify audio events at runtime is prohibited. This is why this editor is needed.

## **7.1. Audio Library Manager**

A user interface integrated into the Unity Editor is implemented, serving as the ultimate link between the middleware (FMOD Studio) and the data (ScriptableObjects).

* **Architectural Purpose:** To automate the creation, organization, and validation of \`AudioEventAsset\`-type assets by linking a pure abstract identifier (\`AudioId\`) to a native, FMOD-wrapped reference (\`EventReference\`).

* **Type Isolation (Value Types):** The window uses direct comparisons of data structures (\`FMOD.GUID\`) to detect state changes in the inspector, eliminating unnecessary memory allocations during data editing.

* **Safe In-Game Preview:** The editor exposes direct playback functions (\`PlayPreview\`/\`StopPreview\`) using FMOD’s low-level API (\`RuntimeManager.CreateInstance\`). The lifecycle of these preview instances is strictly managed through explicit calls to \`.release()\` in the disable hooks (\`OnDisable\`), preventing virtual memory leaks in the native audio thread before entering Play mode.

## **7.2. Validation Rules**

The system implements automatic and manual sanitization routines using the \`Validate()\` method to protect the tactical loop from fatal exceptions:

* **Null Reference Detection:** Asynchronous, on-demand inspection of the root container (\`AudioLibrary\`) to identify and report corrupt \`AudioEventAsset\` or orphaned FMOD references.

* **Uniqueness Guarantee:** Validation for collisions in the dictionary using hash tables (\`HashSet\<AudioId\>\`). If a sound designer attempts to duplicate an audio ID assigned to different events, the editor blocks data compilation and issues critical alerts.

* **Smart ID Suggestion:** The editor parses the middleware’s hierarchical paths (e.g., \`event:/Interface/Accept\`) using string segment extraction (\`SuggestIdName\`), attempting to predictively match the event name with its counterpart in the \`AudioId\` enum.