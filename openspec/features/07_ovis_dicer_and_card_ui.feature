@domain @ovis_omni @prompt_dicer @card_ui
Feature: Ovis-Omni Integration, Visual Grounding Audit, and Interactive Card Ergonomics
  As a visual prompt curator and library operator
  I want Ovis-Omni facet predictions, visual grounding scores, EVoC visual cluster recommendations, and accessible card controls integrated seamlessly across Prompt Dicer and Database views
  So that prompt ingredients remain complete, grounded against image pixels, visually coherent during remixing, and comfortable to select

  Background:
    Given the Lumina Studio SQLite catalog (`images.db`) contains `image_facets`, `image_clusters`, and `diced_prompts` tables
    And the UI defaults batch analysis and single-image prompts to Ultra Detailed Description

  Rule: Confidence-gated Ovis facet fallbacks enrich empty slots without distorting prompt concreteness or active learning datasets

    @OVIS-01
    Scenario: Enrich missing camera and mood slots from high-confidence Ovis facets
      Given an image has an empty `film_stock_or_medium`, `framing`, and `mood` slot in its `prompt_dicer_master_record`
      And its `image_facets` record meets calibrated confidence thresholds for `medium`, `composition`, and `mood`
      When `ovis_facet_fallback_enrichment` normalizes and appends fallback ingredients
      Then the empty slots receive canonical normalized phrases tagged with source `ovis_facet`
      And the original `raw_prompt` text and prompt-only `physicality_ratio` remain unchanged

    @OVIS-02
    Scenario Outline: Gate Ovis facet fallback insertion by slot confidence threshold and occupancy
      Given an image facet prediction `<facet_slug>` for slot `<target_slot>` with confidence <confidence_score> and slot occupancy `<is_occupied>`
      When `ovis_facet_fallback_enrichment` evaluates candidate fallback insertion
      Then the fallback insertion outcome is `<expected_outcome>`

      Examples:
        | facet_slug        | target_slot          | confidence_score | is_occupied | expected_outcome |
        | "35mm_film"       | "film_stock_or_medium" | 0.65           | "empty"     | "inserted"       |
        | "35mm_film"       | "film_stock_or_medium" | 0.30           | "empty"     | "skipped"        |
        | "closeup"         | "framing"            | 0.72           | "occupied"  | "skipped"        |
        | "tense_moody"     | "mood"               | 0.60           | "empty"     | "inserted"       |

    @OVIS-03
    Scenario: Exclude synthetic Ovis facet ingredients from text-only active learning exports
      Given a reviewed `diced_prompts` record containing directed influence edges linked to both `prompt_extraction` and `ovis_facet` ingredients
      When the active learning JSONL exporter compiles training pairs
      Then only influence pairs originating and ending in `prompt_extraction` ingredients are exported
      And synthetic `ovis_facet` edges are omitted cleanly from the JSONL output

  Rule: Visual grounding audits compare 2048-dimensional image vectors against caption vectors and degrade safely offline

    @GROUND-01
    Scenario Outline: Classify caption-to-pixel visual grounding verdict from normalized cosine similarity
      Given a 2048-dimensional Ovis image embedding and a caption text embedding yielding cosine similarity <cosine_score>
      When `visual_grounding_audit` classifies the grounding score
      Then the grounding verdict status is "<grounding_status>" with reanalysis flag "<needs_reanalysis>"

      Examples:
        | cosine_score | grounding_status | needs_reanalysis |
        | 0.36         | grounded         | false            |
        | 0.22         | borderline       | false            |
        | 0.11         | mismatched       | true             |

    @GROUND-02
    Scenario: Degrade visual grounding evaluation gracefully when Ovis-Omni server is offline
      Given the Ovis-Omni embedding service on port 8082 is unreachable
      When prompt dicing executes with visual grounding verification enabled
      Then the system returns a skipped grounding check without failing `prompt_dicer_master_record` persistence

  Rule: Remix Workbench and Database cards surface visual context while isolating interactive targets

    @REMIXUI-01
    Scenario: Prioritize EVoC visually compatible ingredients alongside thumbnail-equipped source prompt rows
      Given active Remix pieces belong to an EVoC visual cluster in `image_clusters`
      When the Ingredient Library queries `evoc_cluster_ingredient_matching` and the user searches source prompts
      Then compatible cluster ingredients rank first with match badges in the drawer
      And source prompt rows span the wide top panel with 72px image thumbnails and wrapped multi-line previews

    @CARDUI-01
    Scenario: Isolate enlarged card selection checkboxes from three-sided prism rotation and preserve Ultra Detailed Description defaults
      Given a user views the Database grid displaying `tri_face_prism_card` tiles with 32px checkboxes inside 44px labels
      When the user clicks the checkbox selection target on a card front
      Then the card selection state toggles without rotating the 3D prism to side two
      And all batch analysis dropdowns default to Ultra Detailed Description

  Rule: Constrained Slot Transplant, Influence Closure, and Round-Trip Verification protect remix coherence

    @TRANSPLANT-01
    Scenario: Preserve locked core slots and prune hard clashes during K-slot beam transplant
      Given a loaded base prompt on the Remix Workbench canvas with locked core slots and unlocked environment slots
      When `constrained_slot_transplant` evaluates EVoC-ranked candidate swaps across K unlocked slots
      Then locked slots remain unchanged and clashing candidates across direct or transitive chains are rejected
      And the top surviving beam plan optionally breaks ties via `laya_confidence_gating` when Laya is online

    @CLOSURE-01
    Scenario: Auto-pull implied downstream effects into unlocked slots and prune orphaned receivers on cause removal
      Given active remix ingredients linked by directed Pass D state edges in SQLite
      When `ingredient_influence_closure` resolves additions or removals respecting slot locks
      Then missing downstream effects are pulled automatically into unlocked slots without overwriting locked lanes
      And unlocked derived receivers whose sole supporting upstream cause was removed are pruned cleanly

    @ROUNDTRIP-01
    Scenario: Verify assembled remixed prompts via heuristic and optional LLM round-trip re-dicing
      Given an assembled remixed prompt generated from planned ingredients
      When `round_trip_prompt_verification` re-dices the output prompt text
      Then preserved slots and physical anchors yield a Verified verdict badge
      And any missing planned slots, dropped phrases, or newly triggered clashes raise a Drift warning

    @GROUND-03
    Scenario: Pinpoint visually ungrounded physical ingredients per image and guard training exports
      Given cached or live 2048-dimensional Ovis image vectors alongside extracted physical ingredients
      When `per_ingredient_visual_grounding` evaluates individual ingredient embeddings and training export filters by review and split
      Then visually absent ingredients are listed as missing per image cleanly
      And JSONL exports enforce optional reviewed-only filtering with deterministic train and holdout buckets

