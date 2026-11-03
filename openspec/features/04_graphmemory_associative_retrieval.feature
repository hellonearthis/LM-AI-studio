@domain @graphmemory @retrieval @associative
Feature: GraphMemory Embedded Knowledge Graph & Associative Retrieval
  As a visual asset curator and researcher
  I want a multi-hop knowledge graph connecting images, EVoC cluster topics, descriptive tags, and aesthetic facets
  So that I can discover associatively related assets, inspect concept subgraphs, and find bridging themes across clusters

  Background:
    Given the DuckDB GraphMemory database "graph_memory.duckdb" is compiled and accessible
    And nodes represent typed Image, Topic, Tag, and Facet entities with deterministic UUIDv5 identifiers

  Rule: Multi-Hop Associative Search discovers neighbor images through shared concept resonance

    @GRAPH-01
    Scenario: Multi-hop associative retrieval ranks neighboring images by shared concept weight
      Given a target image identifier present in the knowledge graph
      When the `associative_retrieval_engine` executes a multi-hop traversal across shared tags, facets, and topics
      Then a ranked collection of associative neighbor images is returned
      And each neighbor record includes an associative resonance score, shared concept count, and list of shared concepts
      And neighbor images are ordered descending by resonance score

    @GRAPH-02
    Scenario: Neighborhood subgraph extraction extracts ego-network for interactive visualization
      Given a target image identifier
      When the `associative_retrieval_engine` extracts the entity neighborhood subgraph
      Then the output contains both "nodes" and "edges" collections
      And the target image is flagged with is_center equal to true
      And directly connected concept nodes include Tag, Facet, and Topic entities

  Rule: Cluster Bridge Discovery identifies semantic intersections connecting distant clusters

    @GRAPH-03
    Scenario: Bridging concepts discover shared themes between two visual clusters
      Given two distinct EVoC cluster numbers
      When the `associative_retrieval_engine` queries for bridging concepts connecting both clusters
      Then a list of shared tags and facets occurring in both clusters is returned
      And each bridging concept includes occurrence counts in both respective clusters

