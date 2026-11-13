Feature: Single-Question Rapid Review Queue and Calibration Analytics
  Because untuned models should not alter beam ranking before empirical validation
  and one curator labeling pass can simultaneously calibrate Ovis grounding cutoffs,
  measure Pass D edge recall, and build reviewed train/holdout splits for Laya fine-tuning,
  the Prompt Dicer exposes a keyboard-driven single-question review_event_ledger
  and an inline calibration_histogram_dashboard.

  Background:
    Given the SQLite Prompt Dicer tables include diced_ingredients, diced_influences, and review_events
    And constrained K-slot transplant defaults use_laya_tiebreaker to false until Laya is fine-tuned

  Rule: Rapid review queue stratifies unreviewed items cleanly and hides quiet repeat checks

    @REVIEW-01
    Scenario: Stratified first-pass sampling balances card types, slots, sources, and prompt lengths
      Given unreviewed items span grounding_caption, grounding_ingredient, edge_check, slot_check, and missing_edge
      And items vary across prompt_extraction versus ovis_facet sources and short, medium, and long prompts
      When the curator requests the stratified review queue with a 5 percent repeat fraction
      Then round-robin strata ordering interleaves cards evenly across every active bucket
      And any spliced repeat-check card omits visible repeat telltales on the rendered card

    @REVIEW-02
    Scenario: Post-tune uncertainty ordering prioritizes predictions nearest fifty percent confidence
      Given unreviewed cards carry Laya confidence scores between 0.10 and 0.95
      When the queue is requested with uncertainty ordering
      Then cards closest to 0.50 confidence appear at the front of the queue

  Rule: Every label appends to an immutable ledger and unlocks granular reviewed JSONL exports

    @REVIEW-03
    Scenario: Single-question keyboard labeling appends a review_event_ledger row with model snapshot
      Given an active edge_check or slot_check card is displayed in the Review tab with stored model_confidence
      When the curator submits a label via hotkey or button click
      Then an append-only row is inserted into review_events with timestamp, model_confidence, model_version, and dataset_split
      And the targeted ingredient or influence row updates its per-item is_reviewed flag to 1

    @REVIEW-04
    Scenario: Per-item is_reviewed flags allow reviewed_only exports before an entire prompt is finished
      Given only one influence edge in a multi-edge prompt has been confirmed in review_events
      When an active learning JSONL export runs with reviewed_only set to true
      Then the confirmed influence edge is exported inside its deterministic train or holdout split
      And unreviewed sibling edges in the same prompt remain excluded

  Rule: Missing-edge probes and repeat checks populate calibration histograms and Pass D recall metrics

    @REVIEW-05
    Scenario: Missing-edge recall probes persist newly discovered physical influences directly
      Given a curator inspects a missing_edge recall card for a prompt with unlinked ingredients
      When the curator submits an added_edge event specifying source, target, and state metadata
      Then the new influence row is inserted into diced_influences with is_reviewed and is_verified set to 1
      And estimated Pass D edge recall updates using confirmed versus newly discovered edge counts

    @REVIEW-06
    Scenario: Calibration dashboard aggregates score histograms, Laya bands, and untuned beam isolation
      Given review_events contains labeled grounding scores, edge/slot verdicts, and paired repeat checks
      When the calibration_histogram_dashboard summary is computed or a default transplant runs
      Then stacked Ovis score histograms, Laya accuracy bands, and intra-rater agreement rate are returned
      And constrained_slot_transplant defaults use_laya_tiebreaker to false so untuned noise cannot alter beam order

