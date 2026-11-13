# Pass B: Pretext words vs physical anchors

Run second, with Pass A's subject list as input.

Fills these ingredient-record fields: mood and vibe tags (the pretext words), `effect_description` (the observable replacement), measurable values (85mm, 3200K, 6:1), `bound_to_subject_id`, `slot`.

Pretext words are catalogued, not treated as defects. "Lovecraftian" is a genre ingredient you will want to search by; the replacement text is what makes it swappable.

## System prompt

You are a prompt-structure analyst. Read one image or video generation prompt and separate two kinds of wording.

PRETEXT terms are abstract mood, intent, or hype words that do not tell a diffusion model what to draw: for example "epic", "mysterious", "emotional", "cinematic", "haunting", "heroic", "breathtaking", "intense", "visceral", "magical", "atmospheric", "lovecraftian".

PHYSICAL anchors are concrete, observable instructions: subject clothing and appearance, facial expressions and poses, lens focal lengths, f-stops and T-stops, camera moves, lighting angles, ratios and colour temperatures, named materials, weather or matter (rain, steam, fog), and body mechanics.

Rules:

1. List every pretext term exactly as written in the prompt. Do not list a word that is already a physical instruction.
2. For each pretext term, write one observable replacement: a short phrase describing what the camera would actually see or hear. The replacement must change what is shown, not restate the mood.
3. List every physical anchor as a short atomic phrase, including subject clothing, appearance, pose, and expression.
   - Where a phrase contains a number and unit, fill `measured_value`; otherwise set it to null.
   - If a phrase contains multiple measurements (such as "85mm lens at f/1.4"), split it into separate physical anchors ("85mm lens" and "f/1.4 aperture") so each anchor has at most one `measured_value`.
   - For ratios like "6:1 lighting ratio", record `number: 6` and `unit: "ratio_to_1"`.
4. If an item belongs to one subject from SUBJECT_LIST_JSON (such as clothing, body features, expression, pose, or action), give that subject's `subject_id`. If it applies to the whole frame, use null.
5. Assign each item a slot from the allowed list only.
6. Do not count, score, or compute ratios. Another program does that.
7. Return only JSON that matches the schema.

Allowed slots: subject_appearance, expression_or_pose, action, lens, camera_motion, framing, lighting, palette, setting, weather_or_matter, film_stock_or_medium, mood, audio, other.

## Inputs

```
MEDIA_TYPE: {{MEDIA_TYPE}}
SUBJECT_LIST_JSON: {{SUBJECT_LIST_JSON}}
PROMPT:
{{PROMPT_TEXT}}
```

## JSON schema (pass to llama-server as the json_schema constraint)

```json
{
  "type": "object",
  "required": ["pretext_terms", "physical_anchors"],
  "properties": {
    "pretext_terms": {
      "type": "array",
      "description": "WHAT: abstract mood or hype words found in the prompt. WHY: they become searchable vibe tags, each with a concrete swap.",
      "items": {
        "type": "object",
        "required": ["term_as_written", "bound_to_subject_id", "tag_slot", "observable_replacement_text", "replacement_slot"],
        "properties": {
          "term_as_written": {
            "type": "string",
            "description": "WHAT: the word or phrase exactly as in the prompt. WHY: lets the original be located."
          },
          "bound_to_subject_id": {
            "anyOf": [
              { "type": "string", "pattern": "^subject_[0-9]+$" },
              { "type": "null" }
            ],
            "description": "WHAT: which subject the term describes, or null for the whole frame. WHY: keeps mood attached to the right person."
          },
          "tag_slot": {
            "type": "string",
            "enum": ["mood", "film_stock_or_medium", "setting", "other"],
            "description": "WHAT: where the vibe tag is filed. WHY: controlled vocabulary for search."
          },
          "observable_replacement_text": {
            "type": "string",
            "description": "WHAT: what the camera would actually see or hear instead. WHY: becomes the effect_description and a swappable ingredient."
          },
          "replacement_slot": {
            "type": "string",
            "enum": ["subject_appearance", "expression_or_pose", "action", "lens", "camera_motion", "framing", "lighting", "palette", "setting", "weather_or_matter", "film_stock_or_medium", "audio", "other"],
            "description": "WHAT: slot the replacement belongs to. WHY: lets it be swapped with other ingredients of the same slot."
          }
        }
      }
    },
    "physical_anchors": {
      "type": "array",
      "description": "WHAT: concrete observable instructions. WHY: these are the ingredients that remix cleanly.",
      "items": {
        "type": "object",
        "required": ["ingredient_text", "slot", "bound_to_subject_id", "measured_value"],
        "properties": {
          "ingredient_text": {
            "type": "string",
            "description": "WHAT: short atomic phrase from the prompt. WHY: the ingredient itself."
          },
          "slot": {
            "type": "string",
            "enum": ["subject_appearance", "expression_or_pose", "action", "lens", "camera_motion", "framing", "lighting", "palette", "setting", "weather_or_matter", "film_stock_or_medium", "audio", "other"],
            "description": "WHAT: controlled slot. WHY: swaps happen within a slot."
          },
          "bound_to_subject_id": {
            "anyOf": [
              { "type": "string", "pattern": "^subject_[0-9]+$" },
              { "type": "null" }
            ],
            "description": "WHAT: owning subject or null for the whole frame. WHY: prevents swapping the wrong person's costume."
          },
          "measured_value": {
            "anyOf": [
              {
                "type": "object",
                "required": ["number", "unit"],
                "properties": {
                  "number": {
                    "type": "number",
                    "description": "WHAT: the numeric value, e.g. 3200 or 6. WHY: enables range queries."
                  },
                  "unit": {
                    "type": "string",
                    "enum": ["K", "mm", "f_stop", "T_stop", "fps", "degrees", "ratio_to_1", "seconds", "other"],
                    "description": "WHAT: standardized unit. WHY: keeps values comparable across prompts."
                  }
                }
              },
              { "type": "null" }
            ],
            "description": "WHAT: structured number and unit when the phrase has one, else null. WHY: numbers are searchable facts, not tag strengths."
          }
        }
      }
    }
  }
}
```

## Ratio calculation (code, not LLM)

The original formula is kept. It runs after the model returns, from the array lengths.

```python
def compute_physicality_ratio(
    count_of_physical_anchors: int,
    count_of_pretext_terms: int,
    pretext_penalty_weight: float = 1.5,
) -> float:
    weighted_total_of_instructions_and_pretext = (
        count_of_physical_anchors
        + (count_of_pretext_terms * pretext_penalty_weight)
    )
    safe_denominator = max(1, weighted_total_of_instructions_and_pretext)
    physicality_ratio = round(count_of_physical_anchors / safe_denominator, 2)
    return physicality_ratio
```