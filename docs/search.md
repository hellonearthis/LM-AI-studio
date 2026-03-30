# Search Page (`search.html`)

The Search page offers advanced capabilities to find specific images within your collection using both keyword matching and semantic understanding.

## Key Features

- **Search Query**:
  - **Keyword Search**: Find images by matching text in descriptions, tags, or objects.
  - **Logic Toggle**: Switch between "Match All (AND)" and "Match Any (OR)" logic for multiple keywords.
  - **Fuzziness Slider**: Adjust how exact the keyword matching needs to be (Exact vs. Loose).
  - **Negative Query**: Exclude specific terms from your search results.

- **Semantic Search**:
  - **Toggle**: Enable "Semantic Search" to find images based on meaning and concepts (e.g., "sad robot") rather than just keywords.
  - **Generate Data**: Create embeddings for your library using LM Studio to enable semantic search capabilities.
  - **Hybrid Engine**: Combines **Fuse.js** for fuzzy keyword matching with **Vector Embeddings** for conceptual search.

- **Filters**:
  - **Scene Type**: Filter by categories such as Indoor, Outdoor, Portrait, Landscape, Urban, or Nature.
  - **Date Range**: Restrict results to a specific timeframe.
  - **Sort Order**: Order results by Relevance, Newest, or Oldest.

- **Search Scope**:
  - Configure which data fields to include in the search (AI Summaries, Objects, Tags).

- **Statistics**:
  - Sidebar displays top tags and objects for quick filtering.

## Usage

1. **Basic Search**: Enter keywords in the main search bar and press Enter.
2. **Advanced Search**:
   - Use the logic toggle and fuzziness slider to refine keyword matching.
   - Enable Semantic Search for conceptual queries.
3. **Filtering**: Select a Scene Type or Date Range to narrow down results.
## Performance & Rendering

- **High-Performance Text Rendering**: The page uses the `@chenglou/pretext` engine to pre-calculate the height of AI summary text before it is inserted into the DOM. This eliminates layout shifts ("jumping") and expensive browser reflows during infinite scroll.
- **Infinite Scroll**: Results are rendered in batches using the `IntersectionObserver` API to maintain high performance even with thousands of matching images.
- **Floating Copy Button**: The summary text is designed to flow naturally around the interactive "Copy" button for a clean and efficient layout.
