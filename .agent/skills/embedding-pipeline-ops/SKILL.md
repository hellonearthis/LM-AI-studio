---
name: embedding-pipeline-ops
description: Manage and benchmark the vector search embedding pipeline, search-embeddings.json, and hybrid Reciprocal Rank Fusion (RRF). Use when auditing embedding vector integrity, pruning orphaned embeddings, diagnosing hybrid or semantic search ranking, or evaluating retrieval quality across search-worker.js.
---

# Embedding Pipeline Operations Skill

A workflow skill for maintaining, auditing, and tuning the vector embedding pipeline and hybrid search fusion logic in LM AI Studio.

---

## Background & Architecture

The application implements a multi-model hybrid retrieval engine:
1. **LM Studio Proxy**: Text queries and image analyses are embedded via `/v1/embeddings` (using models like `nomic-embed-text`).
2. **Pre-computed Cache**: Stored in [public/search-embeddings.json](file:///c:/Users/Desktop-Dev/Desktop/LM%20AI%20studio/public/search-embeddings.json) as a key-value mapping of `ImageID -> 768d vector`.
3. **Web Worker**: [public/search-worker.js](file:///c:/Users/Desktop-Dev/Desktop/LM%20AI%20studio/public/search-worker.js) computes Cosine Similarity using precision sums, applies candidate thresholds (`minimum_cosine_similarity_threshold_score = 0.35`), and fuses keyword rankings with semantic scores using Reciprocal Rank Fusion (RRF).

---

## Operations & Workflows

### 1. Auditing Vector Integrity
Run the bundled diagnostic script to detect missing embeddings, stale records from deleted images, and dimension inconsistencies:
```bash
python .agent/skills/embedding-pipeline-ops/scripts/verify_embeddings.py public/search-data.json public/search-embeddings.json
```

### 2. Batch Embedding Generation & Pruning
When images are added or removed:
- Use the streaming maintenance endpoint in [server.js](file:///c:/Users/Desktop-Dev/Desktop/LM%20AI%20studio/server.js):
  `POST http://localhost:3000/maintenance/generate-embeddings`
- The endpoint automatically skips images that already have cached vectors and prunes ghost entries for deleted images.

### 3. Tuning Retrieval Thresholds & Fusion
In [public/search-worker.js](file:///c:/Users/Desktop-Dev/Desktop/LM%20AI%20studio/public/search-worker.js):
- **`minimum_cosine_similarity_threshold_score`**: Adjusts minimum conceptual similarity required to consider an image relevant.
- **`maximum_semantic_candidate_results_limit`**: Limits semantic candidates to prevent unbounded RRF array merges.
- **`RRF_RANK_CONSTANT`**: Standard constant (`60`) governing the rank penalty curve in reciprocal rank fusion.
