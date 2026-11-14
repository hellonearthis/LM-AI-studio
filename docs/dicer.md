# Prompt Dicer Page (`dicer.html`)

The Prompt Dicer page decomposes image and video generation prompts (and AI vision descriptions) into structured, slot-typed physical ingredients so you can inspect prompt concreteness, detect continuity conflicts, and recombine proven pieces into new prompts.

---

## Header Stats & Global Actions

- **Stat Pills**:
  - **🧪 Diced Prompts**: Total prompts deconstructed and stored in the catalog.
  - **🧪 Cataloged Ingredients**: Total atomic physical anchors and slot modifiers extracted across all prompts.
  - **⚡ Avg Concreteness**: Average ratio of observable physical instructions vs. abstract mood/hype words (`0.00–1.00`, higher = more concrete).
  - **🔗 Influence Edges**: Directed Pass D cause-and-effect links (e.g., rain → wet surface, tungsten → warm color cast).
- **Global Toolbar Buttons**:
  - **👁️ Audit Visual Grounding**: Compares image captions against actual image pixels using Ovis-Omni (port `8082`).
  - **🛡️ Validate & Sync Diced Prompts**: Re-dices entries whose image descriptions changed, fills Ovis facet fallbacks, and repairs missing or desynced catalog records.

---

## 1. 🎨 Recombine & Remix

Mix and swap sliced physical ingredients across prompts, detect continuity contrasts, and assemble new generation prompts.

### Step 1 — Pull Pieces From Diced Prompts
- Search cataloged image prompts by keyword, filename, or `prm_ID` (`🔍 Search`) and pull their sliced ingredients directly onto the Remix Canvas.

### Step 2 — Selected Sliced Pieces by Slot
- **Slot Locks (`🔒` / `🔓`)**: Lock any slot to keep its ingredients fixed before running **Transplant**.
- **Constraint Transplant (`🎲 Transplant`)**: Choose how many unlocked slots to swap or fill (`1–4 slots`), then run beam-search transplantation + **Influence Closure** to fill unlocked slots with compatible, clash-free candidates and implied downstream effects:
  - **Near-Copy Family Clustering**: Groups near-duplicate catalog prompts/ingredients into families before scoring so slight prompt variations do not flood the beam pool.
  - **Staleness Rotation (48-Draft Memory)**: Tracks your recent 48 rolls per media type, penalizing recently used source prompts, families, and repeated 6-word openings so consecutive rolls explore fresh territory.
  - **Keeper Weighting (3×)**: Prompts flagged as proven keepers or reviewed (`is_reviewed`) receive a 3× selection weight bias in beam candidates.
- **Assembly Style & Dream Modes (`Style`)**: Choose how active ingredients and swapped slots are rendered:
  - `Clauses (Default)`: Classic priority-ordered comma-separated physical clauses.
  - `Natural Sentence`: Performs in-place span edits on the loaded base prompt prose with automatic `a`/`an` article and capitalization repair.
  - **Dream Modes** (`Metamorph`, `Chimera`, `Fractal`, `Portal`, `Crossover`, `Kaleidoscope`): Applies surreal compositional transformations (e.g., mid-metamorphosis hybrids, recursive scale echo, threshold portals, split-screen crossovers) on top of the active swaps.
- **👎 Reject & Re-roll**: Permanently excludes the current remix draft and newly swapped candidate texts in SQLite (`dicer_remix_rejections`) so dismissed combinations do not return, then immediately rolls a fresh Transplant.
- **⭐ Keeper (3×)**: Boosts the source prompts behind the active remix ingredients (`keeper_count`) by 3× selection weight for future rolls. Saving a remix (`💾 Save as Diced Prompt`) also automatically increments keeper weight on its contributing sources.
- **Undo / Clear All (`↩️ Undo` / `Clear All`)**: Revert the last transplant/edit or clear the active canvas.
- **Continuity Note**: Displays an advisory banner when active ingredients introduce potentially contrasting physical states on the same scope (e.g., `wet_specular` vs. `dry_matte_dust` on the same subject).

### Step 3 — Recombined Prompt Output
- **Observable Replacements Toggle**: Automatically swaps abstract vibe/hype words (e.g., `"cinematic"`) for concrete camera, lens, or lighting details.
- **Actions**:
  - **🔄 Re-assemble**: Re-runs clash detection, Influence Closure, and rebuilds the prompt text.
  - **🔎 Deep Round-Trip**: Re-dices the assembled output through `llama-server` (with heuristic fallback) to verify that no slots or anchors were lost.
  - **📋 Copy Prompt**: Copies the assembled prompt to your clipboard.
  - **💾 Save as Diced Prompt**: Saves the remixed prompt and its ingredient structure as a new catalog entry.

### Ingredient Library (Right Drawer)
- **Slot Filter**: Browse all 14 controlled semantic slots (`lighting`, `lens`, `weather_or_matter`, `subject_appearance`, `expression_or_pose`, `action`, `framing`, `setting`, `palette`, `film_stock_or_medium`, `mood`, `camera_motion`, `audio`, `other`).
- **Keyword Filter**: Narrow ingredients in real time by text.
- **🎯 Visual Cluster Match**: Prioritizes ingredients from the same EVoC visual cluster as the active pieces on your canvas.
- **👁️ + Vector Neighbors**: Ranks ingredients by Ovis 2048-dim nearest visual neighbors (`public/ovis-embeddings.json`).

---

## 2. ⚡ Process & Batch Dice

Deconstruct new custom prompts or batch-process unprocessed images from `images.db`.

### Dice Custom Image or Video Prompt
- Paste any prompt, choose **Image Prompt** or **Video Prompt (Tracks Speech State)**, and click **🧩 Dice This Prompt** to run the 4-pass pipeline:
  - **Pass A**: Isolates subjects (`subject_1`, `subject_2`) and theta roles (`AGENT`, `PATIENT`, `SPECTATOR`).
  - **Pass B**: Separates concrete physical anchors from abstract pretext words and generates observable replacements.
  - **Pass C**: Mints sequential ingredient IDs and calculates the concreteness (`physicality_ratio`) score.
  - **Pass D**: Extracts directed physical influence and consequence edges.

### Library Candidate Prompts (`images.db`)
- Automatically scans `images.db` for unprocessed prompts embedded in **ComfyUI workflow nodes**, **Automatic1111 parameter strings**, and **vision summaries**.
- Click **🚀 Batch Dice All Candidates** to process all pending candidates with a live progress bar.

---

## 3. 🗃️ Catalog & Inspector

Browse all cataloged prompts, inspect their Pass A–D Master Records, and export datasets.

- **Search & Pagination**: Filter all cataloged prompts by keyword, image filename, or `prm_ID` (`🔍 Search` / `Clear`), choose page size (`50`, `100`, or `200 / page`), and navigate with **← Prev** / **Next →**.
- **Catalog Table**: Displays **Image** thumbnail, **Raw Prompt Text**, **Concreteness** percentage, **Ingredients** (`physical / vibe` counts), and **Action** buttons:
  - **+ Remix**: Loads the prompt's ingredients directly into the **Recombine & Remix** workbench.
  - **Inspect**: Opens the **Prompt Master Record Inspector** modal showing Pass A–D breakdown, subject bindings, and influence edges.
- **📥 Export Training Dataset (JSONL)**: Downloads all cataloged Master Records in JSONL format for fine-tuning.

---

## 4. 🎯 Review & Calibrate

Verify borderline extractions and calibrate Ovis and Laya confidence thresholds.

### Single-Question Review Queue
- **Task Type Filter**: Review all 5 task types (`Mixed Stratified Queue`) or focus on one:
  - `Grounding (Caption)`
  - `Grounding (Ingredient)`
  - `Edge Check (Pass D)`
  - `Slot Check`
  - `Missing Edge Recall Probe`
- **Ordering**: Switch between **Stratified Random (First Pass)** and **Uncertainty First (Post-Tune ~50%)**.
- **Enrich Ovis Scores**: Computes missing 2048-dim Ovis visual grounding scores when Ovis-Omni (`:8082`) is online.
- **Reviewed Dataset Exports**: Export **📥 Reviewed Train** or **📥 Reviewed Holdout** JSONL splits containing only human-verified items.

### Grounding Cutoffs, Laya Calibration & Pass D Edge Recall
- Displays calibration charts, grounding score histograms, and Pass D edge recall metrics. Click **↻ Refresh Charts** to recompute analytics from the latest reviews.

---

## Quickstart Tutorials

### Tutorial 1: Remixing Two Prompts Without Breaking Continuity
1. Open **🎨 Recombine & Remix** and use **1. Pull Pieces From Diced Prompts** to search for a base image/prompt, then load its slices onto the canvas.
2. In **2. Selected Sliced Pieces by Slot**, click the lock icon (`🔒`) on the slots you want to preserve (by default `subject_appearance`, `expression_or_pose`, `action`, and `lens` are locked).
3. Set **Swap** to `2 slots` (or `1–4 slots`), optionally pick a **Style** (`Natural Sentence` for prose span-editing or a **Dream** operator), and click **🎲 Transplant** to fill unlocked slots with clash-free, cluster-compatible ingredients plus **Influence Closure** effects. Use **👎 Reject & Re-roll** to permanently block a roll and re-spin, **⭐ Keeper (3×)** to boost winning source prompts, or **↩️ Undo** to step back.
4. Check the **Continuity Note** banner if it appears — either isolate modifiers to separate subjects or remove one of the conflicting chips (`×`).
5. Keep **Replace abstract vibe words** checked, optionally run **🔎 Deep Round-Trip**, and click **📋 Copy Prompt** or **💾 Save as Diced Prompt**.

### Tutorial 2: Reviewing & Exporting Calibrated Training Data
1. Switch to **🎯 Review & Calibrate**.
2. Leave the filter on **Mixed Stratified Queue (All 5 Types)** and ordering on **Stratified Random (First Pass)** (enable **Enrich Ovis Scores** if Ovis-Omni is running on `:8082`).
3. Work through the single-question cards and click **↻ Refresh Charts** to inspect grounding histograms and Pass D recall.
4. Use **📥 Reviewed Train** and **📥 Reviewed Holdout** to export deterministic splits of your verified records.

---

## Credits

- **Hodge** — Inspired by **Mondocraft**, contributing the near-copy family clustering, 48-draft staleness & rejection memory, in-place span editing / Dream operators, and 3× keeper weighting concepts used in **Recombine & Remix**.


