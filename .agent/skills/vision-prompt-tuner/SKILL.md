---
name: vision-prompt-tuner
description: Audit, test, and tune Vision-Language Model prompt templates in qwen_vl3_prompts.json and server.js. Use when creating or refining AI prompts (e.g. Detailed Analysis, Cinematic Description, Video Summary), verifying JSON output schemas, testing model responses against sample images, or preventing markdown fence and emoji formatting errors.
---

# Vision Prompt Tuner Skill

A dedicated workflow for engineering, evaluating, and auditing prompt templates used by multimodal vision models (such as Qwen2.5-VL and LLaVA) within LM AI Studio.

---

## Background & Architecture

The application sends images and prompt instructions to local Vision-Language Models hosted in LM Studio. The server enforces strict output schema expectations:
- **`summary`**: Clean textual description adhering to the requested style (simple, cinematic, ultra-detailed).
- **`scene_type`**: One of `indoor`, `outdoor`, `portrait`, `landscape`, `urban`, `nature`.
- **`objects`**: Array of up to 15 distinct labels (1–3 words each). No duplicates.
- **`tags`**: Array of up to 20 descriptive tags (style, mood, colors, setting). No overlap with objects.

If prompts allow the model to wrap output in markdown code fences (` ```json `), include emojis, or omit fields, frontend JSON parsing or tag filtering can degrade.

---

## Workflow: Creating or Refining a Prompt

### Step 1: Inspect Current Prompt Definitions
Review [qwen_vl3_prompts.json](file:///c:/Users/Desktop-Dev/Desktop/LM%20AI%20studio/qwen_vl3_prompts.json) and verify how the prompt is mapped in [server.js](file:///c:/Users/Desktop-Dev/Desktop/LM%20AI%20studio/server.js).

### Step 2: Validate Prompt Template Constraints
Run the bundled prompt validator to ensure template syntax and key structure are sound:
```bash
python .agent/skills/vision-prompt-tuner/scripts/validate_prompts.py qwen_vl3_prompts.json
```

Verify that the prompt template explicitly instructs the model:
1. **Raw JSON Only**: Never output markdown formatting or conversational preambles.
2. **Field Separation**: Explicitly distinguish `objects` (physical items) from `tags` (mood, lighting, composition).
3. **Deduplication Directive**: Include explicit instructions against redundant tags.

### Step 3: Test Against Sample Images
1. Send a sample image payload through the `/analyze` endpoint in [server.js](file:///c:/Users/Desktop-Dev/Desktop/LM%20AI%20studio/server.js).
2. Confirm the response parses with `JSON.parse()` without requiring fallback regex stripping.
3. Validate that `scene_type` matches one of the known badge types.

### Step 4: Update UI Selectors
If a new prompt mode is added, update:
- [public/index.html](file:///c:/Users/Desktop-Dev/Desktop/LM%20AI%20studio/public/index.html) (prompt dropdown selector)
- [public/database.html](file:///c:/Users/Desktop-Dev/Desktop/LM%20AI%20studio/public/database.html) (`dbPromptType` selector)
