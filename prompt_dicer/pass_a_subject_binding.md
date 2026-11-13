# Pass A: Subject binding grid

Run first. Its output (the subject roster and action edges) is fed into Pass B and Pass C so every later ingredient can bind to a subject_id.

Fills these record fields: `subjects` roster, agent/instrument/target edges, `requires_reference_image`. Appearance and pose/expression are left entirely to Pass B.

## System prompt

You are a prompt-structure analyst. Read one image or video generation prompt and work out who is in it and who does what to whom. Do not judge quality, do not extract clothing or appearance ingredients, and do not rewrite the prompt. Quote the prompt's own wording wherever you can.

Rules:

1. Every distinct character or acting entity gets one subject with an internal id: subject_1, subject_2, and so on.
2. Theta roles. AGENT starts the action. PATIENT receives or is targeted by it. SPECTATOR is present but must not inherit anyone else's motion or speech.
3. Keep `verb_action` to the core verb or short edge label connecting the subject to an instrument or target. Leave detailed clothing, appearance, expressions, and multi-beat timelines for later passes.
4. Flag a clause as ambiguous when two or more subjects share a sentence with an action verb and the prompt does not make clear who is agent and who is patient. Explain which attributes or actions could swap between them.
5. If the prompt refers to a reference image by tag (for example "Image 1" or "<Picture 1>"), copy the tag and set requires_reference_image to true. Otherwise set it to false.
6. For video prompts fill speech_state. For image prompts set speech_state to null.
7. Use null when the prompt does not say. Never invent details.
8. Return only JSON that matches the schema.

## Inputs

```
MEDIA_TYPE: {{MEDIA_TYPE}}
PROMPT:
{{PROMPT_TEXT}}
```

## JSON schema (pass to llama-server as the json_schema constraint)

```json
{
  "type": "object",
  "required": ["media_type", "subjects", "ambiguous_clauses"],
  "properties": {
    "media_type": {
      "type": "string",
      "enum": ["image", "video"],
      "description": "WHAT: which kind of prompt this is. WHY: decides whether speech_state is filled."
    },
    "subjects": {
      "type": "array",
      "description": "WHAT: one entry per character or acting entity. WHY: these become the entities that ingredients bind to.",
      "items": {
        "type": "object",
        "required": [
          "subject_id", "role_label", "source_reference_tag",
          "requires_reference_image", "theta_role", "verb_action",
          "instrument", "target_subject_id", "speech_state"
        ],
        "properties": {
          "subject_id": {
            "type": "string",
            "pattern": "^subject_[0-9]+$",
            "description": "WHAT: internal id. WHY: stable key for the database; model-specific tags like <Subject 1> are generated only at export."
          },
          "role_label": {
            "type": "string",
            "description": "WHAT: short plain name such as 'weary detective' or 'bartender'. WHY: human-readable label in the review queue."
          },
          "source_reference_tag": {
            "anyOf": [{ "type": "string" }, { "type": "null" }],
            "description": "WHAT: the prompt's own tag for a reference image, copied exactly. WHY: keeps the asset binding separate from the swappable text."
          },
          "requires_reference_image": {
            "type": "boolean",
            "description": "WHAT: true if the subject's identity depends on a reference image. WHY: such a subject cannot be remixed as text alone."
          },
          "theta_role": {
            "type": "string",
            "enum": ["AGENT", "PATIENT", "SPECTATOR"],
            "description": "WHAT: the subject's thematic role in the main action. WHY: stops actions and speech leaking onto the wrong subject."
          },
          "verb_action": {
            "anyOf": [{ "type": "string" }, { "type": "null" }],
            "description": "WHAT: core action verb acting as the edge label. WHY: seeds the action edge without duplicating full beat descriptions."
          },
          "instrument": {
            "anyOf": [{ "type": "string" }, { "type": "null" }],
            "description": "WHAT: object or tool the subject uses. WHY: first link in an influence chain (hand, glass, shatter)."
          },
          "target_subject_id": {
            "anyOf": [
              { "type": "string", "pattern": "^subject_[0-9]+$" },
              { "type": "null" }
            ],
            "description": "WHAT: the subject receiving the action, if any. WHY: gives the agent-to-patient edge in the influence graph."
          },
          "speech_state": {
            "anyOf": [
              { "type": "string", "enum": ["speaking", "locked_silent"] },
              { "type": "null" }
            ],
            "description": "WHAT: whether this subject's mouth moves (video only). WHY: lets the voice be swapped without swapping the visuals."
          }
        }
      }
    },
    "ambiguous_clauses": {
      "type": "array",
      "description": "WHAT: clauses where it is unclear who does what. WHY: these are the places where attributes bleed between subjects.",
      "items": {
        "type": "object",
        "required": ["original_clause", "bleed_risk", "suggested_binding"],
        "properties": {
          "original_clause": { "type": "string", "description": "WHAT: the clause copied exactly. WHY: lets a reviewer find it." },
          "bleed_risk": { "type": "string", "description": "WHAT: which attributes or actions could swap. WHY: explains the flag." },
          "suggested_binding": { "type": "string", "description": "WHAT: the clause with subject ids added. WHY: a repair suggestion for review; the stored source prompt is never modified." }
        }
      }
    }
  }
}
```