@domain @functional @architecture
Feature: Pure Functional JavaScript Architecture Invariants
  As a system architect and developer
  I want codebase routines to conform to pure functional paradigms
  So that data transformations are deterministic, testable without mocks, and free of side-effect collisions

  Background:
    Given the pure functional architecture rule constraints are actively enforced
    And input domain payloads are treated as immutable records

  Rule: Deterministic Pure Transformations must return identical outputs for identical inputs without mutating external state

    @FUNC-01
    Scenario: Deterministic HTML string sanitization through pure transformation
      Given an untrusted raw string containing characters "&", "<", ">", and quotes
      When the `html_sanitization_pipe` processes the raw input string
      Then all unsafe characters are converted to their corresponding HTML entity equivalents
      And the original input string remains completely unmodified

    @FUNC-02
    Scenario Outline: HTML entity escaping across diverse malicious payload variations
      Given a test string with raw characters <input_characters>
      When the `html_sanitization_pipe` transforms the test string
      Then the escaped output contains <sanitized_output>
      And the execution creates zero module-level side effects

      Examples:
        | input_characters          | sanitized_output             |
        | "<script>alert(1)</script>" | "&lt;script&gt;alert(1)&lt;/script&gt;" |
        | "image_alt=\"test & win\"" | "image_alt=&quot;test &amp; win&quot;"   |
        | "plain safe text"         | "plain safe text"            |

  Rule: Domain logic must use plain objects and standalone functions rather than stateful classes and mutable "this"

    @FUNC-03
    Scenario: Functional domain transformation replaces stateful class instances
      Given an image metadata payload and target facet taxonomy questions
      When a pure facet extractor maps the metadata across the taxonomy definitions
      Then a fresh categorized record is produced with explicit attributes
      And no domain class constructor or mutable "this" binding is instantiated

    @FUNC-04
    Scenario: Immutable collection filtering preserves original records
      Given a collection of analyzed image records
      When an active category filter is applied to the collection
      Then a newly allocated subset array containing only matching records is returned
      And the source collection retains its original length and structure

  Rule: Side-effects must be strictly isolated to the imperative shell boundary

    @FUNC-05
    Scenario: Pure mathematical calculation operates without DOM or network dependencies
      Given raw typographic glyph metrics and a container width parameter
      When the `pretext_layout_engine` computes line breaks purely through arithmetic
      Then the total height calculation returns a deterministic numerical pixel value
      And zero DOM layout reflow or browser window queries are executed

