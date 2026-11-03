@domain @search @worker
Feature: Hybrid Search and Reciprocal Rank Fusion Architecture
  As a visual asset search user
  I want search execution to balance keyword precision with high-dimensional semantic understanding
  So that visual discoveries are comprehensive, ultra-fast, and computationally isolated from the rendering thread

  Background:
    Given the background search worker is initialized with image index records
    And `reciprocal_rank_fusion` parameters (k constant = 60) are loaded

  Rule: Worker threads isolate heavy mathematical vector calculations from UI interactions

    @SEARCH-01
    Scenario: Background search worker receives query message and dispatches isolated results
      Given an active background web worker hosting the image collection
      When a search query request payload is posted across the worker boundary
      Then the worker returns filtered candidate images within a response message
      And the browser main UI thread experiences zero frame drops or reflow locks

    @SEARCH-02
    Scenario: Cosine similarity computation between high-dimensional embedding vectors
      Given a 768-dimensional normalized query embedding vector
      When computing cosine similarity against stored `semantic_embedding_vector` entries
      Then similarity dot products are calculated purely via floating-point mathematics
      And neither vector array is mutated during dot product calculation

  Rule: Reciprocal Rank Fusion deterministically blends lexical and semantic rankings

    @SEARCH-03
    Scenario: Merging fuzzy keyword ranks and semantic vector similarity ranks
      Given a fuzzy text rank position list and a semantic vector similarity rank position list
      When the `reciprocal_rank_fusion` pure function scores candidate identifiers
      Then each candidate receives a cumulative score matching the reciprocal sum formula
      And candidate records are returned sorted strictly in descending order of fused score

    @SEARCH-04
    Scenario Outline: Search query variations trigger appropriate processing pathways
      Given a search execution with query input <query_term>
      When the search coordinator routes the query
      Then the engine executes the <execution_mode> pipeline
      And returns ranked matches without altering underlying image database state

      Examples:
        | query_term             | execution_mode    |
        | "cyberpunk neon street"| "hybrid_rrf"      |
        | "sunset"               | "fuzzy_lexical"   |
        | ""                     | "unfiltered_feed" |

