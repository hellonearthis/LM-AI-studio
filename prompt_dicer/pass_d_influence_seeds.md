# Pass D: Ingredient influence and consequence extraction (seed generator)

Run third, after Python has merged Pass A and Pass B and assigned stable `ingredient_id`s (`ing_1`, `ing_2`, ...).

Once Laya/CLM is fine-tuned on your reviewed labels, Laya can take over pair-verification across all N*(N-1) ordered pairs, and this LLM pass only needs to run when drafting new consequence descriptions or bootstrapping training data.

Fills these record fields: `influences` (directed edges between ingredients, portable slot consequences, and clash tags).

## System prompt

You are a physical continuity and prompt-interaction analyst. You are given a prompt's SUBJECT_LIST and its extracted INGREDIENT_LIST (each with a stable `ingredient_id`, `slot`, and `bound_to_subject_id`).

Your job is to find pairs of ingredients where one ingredient (the SOURCE) physically alters, optically changes, or shifts the mood/reading of another ingredient (the TARGET) within the scene.

Examples of valid influences:
- Weather/matter on appearance: "heavy rain" makes "trenchcoat" wet, darkened, and specular.
- Weather/matter on lighting: "heavy rain" or "thick fog" makes "3200K streetlamp" streaky or diffused.
- Lighting on appearance/palette: "3200K sodium streetlamp" casts an amber monochrome wash over "pale skin" or "white shirt".
- Expression/action on mood: "weeping" or "aiming a flashlight" shifts how the target subject or frame mood reads.

Rules:

1. Use only `ingredient_id`s that exist in INGREDIENT_LIST. Never invent IDs.
2. Only list genuine physical, optical, acoustic, or mood interactions. Do not link two ingredients just because they are in the same prompt or belong to the same subject.
3. For each influence, specify:
   - `source_ingredient_id`: the ingredient causing the change.
   - `target_ingredient_id`: the specific ingredient in this prompt being affected.
   - `portable_target_slot`: which slot this source ingredient naturally affects when remixed into a new prompt (for example, "heavy rain" affects `subject_appearance` and `lighting`, so if the trenchcoat is swapped for a silk dress, the rain still wets the dress).
   - `target_subject_scope`: whether the influence affects `"same_subject_only"`, `"target_subject_only"`, or `"whole_frame"`.
   - `consequence_description`: a short, concrete phrase describing what the camera sees or hears as a result of the interaction.
   - `applied_state_tag`: a short key-value state applied to the target (for example, `{"surface_moisture": "soaked"}` or `{"beam_visibility": "volumetric_streaks"}`).
   - `clashes_with_state`: the opposite state value on that same key that would cause a continuity clash if swapped in (for example, `"bone_dry_powder"` or `"clear_vacuum"`).
4. Return only JSON that matches the schema.

## Inputs

MEDIA_TYPE: {{MEDIA_TYPE}}
SUBJECT_LIST_JSON: {{SUBJECT_LIST_JSON}}
INGREDIENT_LIST_JSON: {{INGREDIENT_LIST_JSON}}
PROMPT:
{{PROMPT_TEXT}}

## JSON schema (pass to llama-server as the json_schema constraint)

```json
{
  "type": "object",
  "required": ["influences"],
  "properties": {
    "influences": {
      "type": "array",
      "description": "WHAT: directed interactions where one ingredient alters another. WHY: carries consequences across swaps and seeds Laya training pairs.",
      "items": {
        "type": "object",
        "required": [
          "source_ingredient_id",
          "target_ingredient_id",
          "interaction_type",
          "portable_target_slot",
          "target_subject_scope",
          "consequence_description",
          "state_key",
          "applied_state_value",
          "clashes_with_value"
        ],
        "properties": {
          "source_ingredient_id": {
            "type": "string",
            "pattern": "^ing_[0-9]+$",
            "description": "WHAT: the ingredient causing the effect. WHY: influence travels with this ingredient when remixed."
          },
          "target_ingredient_id": {
            "type": "string",
            "pattern": "^ing_[0-9]+$",
            "description": "WHAT: the ingredient affected in this prompt. WHY: forms the positive (source, target) pair for Laya training."
          },
          "interaction_type": {
            "type": "string",
            "enum": [
              "surface_physical",
              "optical_lighting",
              "motion_mechanics",
              "mood_shift",
              "acoustic"
            ],
            "description": "WHAT: category of interaction. WHY: lets Laya classify not just YES/NO, but the mechanism."
          },
          "portable_target_slot": {
            "type": "string",
            "enum": [
              "subject_appearance",
              "expression_or_pose",
              "action",
              "lens",
              "camera_motion",
              "framing",
              "lighting",
              "palette",
              "setting",
              "weather_or_matter",
              "film_stock_or_medium",
              "mood",
              "audio",
              "other"
            ],
            "description": "WHAT: the slot type this effect applies to when remixed. WHY: if target_ingredient_id is swapped out for a new ingredient in the same slot, the effect transfers."
          },
          "target_subject_scope": {
            "type": "string",
            "enum": ["whole_frame", "same_subject_only", "agent_to_patient"],
            "description": "WHAT: boundary of the effect. WHY: stops a tear on Subject 1 from altering Subject 2's face, while allowing rain to wet everyone."
          },
          "consequence_description": {
            "type": "string",
            "description": "WHAT: observable result in 4 to 10 words. WHY: can be injected into a remixed prompt so the diffusion model renders the interaction."
          },
          "state_key": {
            "type": "string",
            "description": "WHAT: physical dimension affected, e.g. 'surface_moisture', 'light_scatter', 'color_cast', 'fabric_drape'. WHY: shared key for clash checks."
          },
          "applied_state_value": {
            "type": "string",
            "description": "WHAT: the state imposed by the source ingredient, e.g. 'wet_specular'. WHY: tags the target state."
          },
          "clashes_with_value": {
            "type": "string",
            "description": "WHAT: incompatible state on the same state_key, e.g. 'dry_matte_dust'. WHY: flags contradictions during remixing."
          }
        }
      }
    }
  }
}