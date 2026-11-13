@domain @prompt_dicer @catalog @remix @pure_functional
Feature: Prompt Dicer Pipeline & Ingredient Catalog System
  As a prompt architect and visual director
  I want generation prompts structured into atomic ingredients, bound to subjects, categorized by slots, and mapped with influence consequences
  So that ingredients can be remixed cleanly across scenes while detecting physical continuity clashes and exporting active learning training data

  Background:
    Given the Prompt Dicer ingestion service and SQLite catalog repository are active
    And the system adheres to Pure Functional Architecture and the Tutorial Protocol

  Rule: Pass A through Pass C must deterministically bind entities, separate pretext vibe words, and mint sequential IDs

    @DICER-01
    Scenario: Deterministic subject binding and measurement extraction into Master Record
      Given an image or video prompt containing subjects, camera lenses, and lighting
      When the prompt is processed through the Pass A and Pass B analyzers
      Then distinct characters receive stable subject identifiers with theta roles
      And concrete instructions are extracted as physical anchors with numeric measurements and units
      And abstract vibe words are cataloged as pretext terms paired with observable camera replacements
      And Pass C mints sequential ingredient IDs without fuzzy deduplication
      And the physicality ratio accurately reflects the weighted concreteness score

  Rule: Ingredient influence edges must track physical continuity states and flag conflicting swaps

    @DICER-02
    Scenario: Detecting physical continuity clashes across remix ingredients
      Given a set of remixed ingredients containing opposing state dimensions
      When the clash detection routine evaluates active influence edges
      Then conflicting values on the same state key are flagged as continuity contradictions
      And clear remediation advice is provided to isolate subject scope or remove the clash

  Rule: Storage and active learning export must persist structured records and JSONL datasets

    @DICER-03
    Scenario: Transactional persistence in images.db and export for Laya/CLM fine-tuning
      Given a diced prompt Master Record with physical anchors and directed influences
      When the record is saved to the SQLite repository
      Then the prompt, ingredients, and influences are persisted within a single atomic transaction
      And positive and negative interaction pairs can be exported as standard JSONL training lines

