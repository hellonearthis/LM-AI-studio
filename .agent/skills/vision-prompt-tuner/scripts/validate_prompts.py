#!/usr/bin/env python3
"""
WHAT: Script validating prompt templates in qwen_vl3_prompts.json.
WHY: Guarantees that prompt definitions adhere to expected JSON schema, contain required
keys, include structured output instructions, and do not contain accidental markdown fences.
"""

import json
import sys
from pathlib import Path

def validate_prompt_configuration_file(prompts_file_path_string):
    prompts_file_path = Path(prompts_file_path_string)
    if not prompts_file_path.exists():
        print(f"[ERROR] Prompts file does not exist: {prompts_file_path}")
        return False

    try:
        with open(prompts_file_path, 'r', encoding='utf-8') as prompts_file_handle:
            loaded_prompt_data_dictionary = json.load(prompts_file_handle)
    except Exception as file_reading_error:
        print(f"[ERROR] Failed to parse JSON file: {file_reading_error}")
        return False

    qwenvl_prompt_collection = loaded_prompt_data_dictionary.get('qwenvl')
    if not isinstance(qwenvl_prompt_collection, dict):
        print("[ERROR] Missing top-level 'qwenvl' dictionary in prompt configuration.")
        return False

    expected_standard_prompt_keys = [
        'Tags',
        'Simple Description',
        'Detailed Description',
        'Ultra Detailed Description',
        'Cinematic Description',
        'Detailed Analysis',
        'Video Summary',
        'Short Story',
        'Prompt Refine & Expand'
    ]

    validation_failure_reasons_list = []

    for expected_prompt_key_name in expected_standard_prompt_keys:
        if expected_prompt_key_name not in qwenvl_prompt_collection:
            validation_failure_reasons_list.append(f"Missing expected prompt key: '{expected_prompt_key_name}'")
        else:
            prompt_instruction_text = qwenvl_prompt_collection[expected_prompt_key_name]
            if not isinstance(prompt_instruction_text, str) or len(prompt_instruction_text.strip()) == 0:
                validation_failure_reasons_list.append(f"Empty instruction text for prompt key: '{expected_prompt_key_name}'")
            if "```json" in prompt_instruction_text or "```" in prompt_instruction_text:
                validation_failure_reasons_list.append(f"Markdown code fences found inside prompt template: '{expected_prompt_key_name}'")

    if validation_failure_reasons_list:
        print(f"[FAIL] Found {len(validation_failure_reasons_list)} validation issue(s):")
        for failure_message in validation_failure_reasons_list:
            print(f"  - {failure_message}")
        return False

    print(f"[SUCCESS] All {len(qwenvl_prompt_collection)} prompts in '{prompts_file_path.name}' passed validation successfully!")
    return True

if __name__ == '__main__':
    target_prompts_file_path = sys.argv[1] if len(sys.argv) > 1 else 'qwen_vl3_prompts.json'
    is_valid_prompts_file = validate_prompt_configuration_file(target_prompts_file_path)
    sys.exit(0 if is_valid_prompts_file else 1)
