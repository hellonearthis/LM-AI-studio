/**
 * ============================================================================
 * MODULE: uiModals.js — Isolated Imperative Shell for Modal Overlays & Previews
 * ============================================================================
 *
 * WHAT: Provides reusable modal dialog and lightbox overlays for tag editing,
 *       summary editing, confirmations, alerts, bulk renaming, integrity checks,
 *       deletion choices, and full-size image previews.
 * WHY:  Isolates DOM creation, keyboard listener lifecycle, and modal backdrop
 *       cleanup into a dedicated Imperative Shell module so search and database
 *       views stay concise and focused on their core coordination logic.
 */

import { escapeHtmlCharacters } from './cardCore.js';

/**
 * WHAT: Creates and displays a modal dialog prompting the user to input or edit a single-line tag/filename value.
 * WHY:  Replaces native browser `prompt()` dialogs with an accessible, XSS-safe dark-mode modal overlay.
 *
 * @param {string} modal_dialogue_title_text - Heading shown at the top of the modal.
 * @param {string} initial_input_field_value_text - Initial text pre-filled in the input.
 * @param {(submitted_value: string) => void} tag_submission_callback_function - Invoked with the submitted string.
 */
export function showTagInputModal(
    modal_dialogue_title_text,
    initial_input_field_value_text,
    tag_submission_callback_function
) {
    const tag_input_modal_container_element = document.createElement('div');
    tag_input_modal_container_element.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 9999;';

    const escaped_modal_dialogue_title_text = escapeHtmlCharacters(modal_dialogue_title_text);
    const escaped_initial_input_field_value_text = escapeHtmlCharacters(initial_input_field_value_text);

    tag_input_modal_container_element.innerHTML = `
        <div style="background: var(--card-bg); padding: 2rem; border-radius: 12px; border: 1px solid var(--border); max-width: 400px; width: 90%;">
            <h3 style="margin: 0 0 1rem 0; color: var(--text-primary);">${escaped_modal_dialogue_title_text}</h3>
            <input type="text" id="tagInput" value="${escaped_initial_input_field_value_text}" style="width: 100%; padding: 0.75rem; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-primary); color: var(--text-primary); margin-bottom: 1.5rem; font-size: 1rem;">
            <div style="display: flex; gap: 1rem; justify-content: flex-end;">
                <button id="cancelTagBtn" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer;">Cancel</button>
                <button id="saveTagBtn" style="background: var(--accent); border: none; color: white; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; font-weight: 500;">Save</button>
            </div>
        </div>
    `;

    document.body.appendChild(tag_input_modal_container_element);

    const text_input_field_element = tag_input_modal_container_element.querySelector('#tagInput');
    const save_changes_button_element = tag_input_modal_container_element.querySelector('#saveTagBtn');
    const cancel_changes_button_element = tag_input_modal_container_element.querySelector('#cancelTagBtn');

    const keyboard_event_handler_function = (keyboard_event_object) => {
        if (keyboard_event_object.key === 'Escape') {
            cleanup_modal_and_remove_event_listeners();
        }
    };
    document.addEventListener('keydown', keyboard_event_handler_function);

    const cleanup_modal_and_remove_event_listeners = () => {
        document.removeEventListener('keydown', keyboard_event_handler_function);
        tag_input_modal_container_element.remove();
    };

    const save_input_value_and_trigger_callback = () => {
        const retrieved_input_value_string = text_input_field_element.value;
        cleanup_modal_and_remove_event_listeners();
        tag_submission_callback_function(retrieved_input_value_string);
    };

    setTimeout(() => {
        text_input_field_element.focus();
        text_input_field_element.select();
    }, 10);

    save_changes_button_element.onclick = save_input_value_and_trigger_callback;
    cancel_changes_button_element.onclick = cleanup_modal_and_remove_event_listeners;

    text_input_field_element.addEventListener('keydown', (keyboard_event_object) => {
        if (keyboard_event_object.key === 'Enter') {
            keyboard_event_object.preventDefault();
            keyboard_event_object.stopPropagation();
            save_input_value_and_trigger_callback();
        }
    });

    tag_input_modal_container_element.onclick = (mouse_click_event_object) => {
        if (mouse_click_event_object.target === tag_input_modal_container_element) {
            cleanup_modal_and_remove_event_listeners();
        }
    };
}

/**
 * WHAT: Creates and displays a modal dialog containing a multiline textarea for editing image summary descriptions.
 * WHY:  AI-generated summaries are multi-sentence paragraphs that require a resizable textarea and XSS-safe escaping.
 *
 * @param {string} modal_dialogue_title_text - Heading shown at the top of the modal.
 * @param {string} initial_text_area_value_text - Existing summary text to edit.
 * @param {(submitted_summary: string) => void} summary_submission_callback_function - Invoked with the updated summary.
 */
export function showSummaryInputModal(
    modal_dialogue_title_text,
    initial_text_area_value_text,
    summary_submission_callback_function
) {
    const summary_input_modal_container_element = document.createElement('div');
    summary_input_modal_container_element.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 9999;';

    const escaped_modal_dialogue_title_text = escapeHtmlCharacters(modal_dialogue_title_text);
    const escaped_initial_text_area_value_text = escapeHtmlCharacters(initial_text_area_value_text);

    summary_input_modal_container_element.innerHTML = `
        <div style="background: var(--card-bg); padding: 2rem; border-radius: 12px; border: 1px solid var(--border); max-width: 600px; width: 90%;">
            <h3 style="margin: 0 0 1rem 0; color: var(--text-primary);">${escaped_modal_dialogue_title_text}</h3>
            <textarea id="summaryInput" style="width: 100%; height: 200px; padding: 0.75rem; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-primary); color: var(--text-primary); margin-bottom: 1.5rem; font-size: 0.9rem; line-height: 1.4; font-family: inherit; resize: vertical;">${escaped_initial_text_area_value_text}</textarea>
            <div style="display: flex; gap: 1rem; justify-content: flex-end;">
                <button id="cancelSummaryBtn" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer;">Cancel</button>
                <button id="saveSummaryBtn" style="background: var(--accent); border: none; color: white; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; font-weight: 500;">Save Changes</button>
            </div>
        </div>
    `;

    document.body.appendChild(summary_input_modal_container_element);

    const summary_text_area_input_element = summary_input_modal_container_element.querySelector('#summaryInput');
    const save_summary_changes_button_element = summary_input_modal_container_element.querySelector('#saveSummaryBtn');
    const cancel_summary_changes_button_element = summary_input_modal_container_element.querySelector('#cancelSummaryBtn');

    const keyboard_event_handler_function = (keyboard_event_object) => {
        if (keyboard_event_object.key === 'Escape') {
            cleanup_modal_and_remove_event_listeners();
        }
    };
    document.addEventListener('keydown', keyboard_event_handler_function);

    const cleanup_modal_and_remove_event_listeners = () => {
        document.removeEventListener('keydown', keyboard_event_handler_function);
        summary_input_modal_container_element.remove();
    };

    const save_summary_value_and_trigger_callback = () => {
        const retrieved_summary_value_string = summary_text_area_input_element.value;
        cleanup_modal_and_remove_event_listeners();
        summary_submission_callback_function(retrieved_summary_value_string);
    };

    setTimeout(() => {
        summary_text_area_input_element.focus();
        summary_text_area_input_element.setSelectionRange(
            summary_text_area_input_element.value.length,
            summary_text_area_input_element.value.length
        );
    }, 10);

    save_summary_changes_button_element.onclick = save_summary_value_and_trigger_callback;
    cancel_summary_changes_button_element.onclick = cleanup_modal_and_remove_event_listeners;

    summary_input_modal_container_element.onclick = (mouse_click_event_object) => {
        if (mouse_click_event_object.target === summary_input_modal_container_element) {
            cleanup_modal_and_remove_event_listeners();
        }
    };
}

/**
 * WHAT: Displays the Database Integrity Check configuration modal and resolves with the selected options.
 * WHY:  Lets users choose which maintenance passes (missing files, metadata repair, thumbnail regen,
 *       orphaned embedding vector pruning, or legacy thumbnail purge) to execute.
 *
 * @param {{ includeValidateDiced?: boolean }} [integrity_modal_configuration] - Optional flags for extra database maintenance checks.
 * @returns {Promise<{
 *   removeMissing: boolean,
 *   repairMetadata: boolean,
 *   regenThumbnails: boolean,
 *   pruneOrphanedEmbeddings: boolean,
 *   validateDicedPrompts?: boolean,
 *   purgeThumbnails: boolean
 * } | null>}
 */
export function showIntegrityCheckModal(integrity_modal_configuration = {}) {
    const should_include_validate_diced_checkbox = Boolean(integrity_modal_configuration.includeValidateDiced);

    return new Promise((resolve_promise_callback) => {
        const integrity_modal_container_element = document.createElement('div');
        integrity_modal_container_element.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); display: flex; align-items: center; justify-content: center; z-index: 10000; backdrop-filter: blur(4px);';

        // WHAT: Conditionally builds the Prompt Dicer schema validation checkbox markup.
        // WHY: Database Viewer exposes diced prompt validation while Search Hub omits it, so parameterizing avoids duplicating the entire modal shell.
        const validate_diced_checkbox_markup = should_include_validate_diced_checkbox
            ? `
                    <label style="display: flex; align-items: center; gap: 0.75rem; cursor: pointer; padding: 0.5rem; border-radius: 8px; transition: background 0.2s;">
                        <input type="checkbox" id="icValidateDiced" checked style="width: 18px; height: 18px; accent-color: #f472b6;">
                        <div>
                            <div style="color: var(--text-primary); font-weight: 500;">Validate Diced Prompts</div>
                            <div style="font-size: 0.8rem; color: var(--text-secondary);">Check Prompt Dicer SQLite records for structural schema issues.</div>
                        </div>
                    </label>
            `
            : '';

        integrity_modal_container_element.innerHTML = `
            <div style="background: var(--bg-secondary); padding: 2.5rem; border-radius: 16px; border: 1px solid var(--border); max-width: 450px; width: 90%; box-shadow: 0 20px 50px rgba(0,0,0,0.5);">
                <h3 style="margin: 0 0 1.5rem 0; color: var(--accent); font-size: 1.5rem; display: flex; align-items: center; gap: 0.75rem;">
                    <span>🛡️</span> Database Integrity Check
                </h3>
                
                <p style="color: var(--text-secondary); margin-bottom: 2rem; font-size: 0.95rem; line-height: 1.5;">
                    Select the tasks you would like to perform during the maintenance pass:
                </p>

                <div style="display: flex; flex-direction: column; gap: 1.25rem; margin-bottom: 2.5rem;">
                    <label style="display: flex; align-items: center; gap: 0.75rem; cursor: pointer; padding: 0.5rem; border-radius: 8px; transition: background 0.2s;">
                        <input type="checkbox" id="icRemoveMissing" checked style="width: 18px; height: 18px; accent-color: var(--accent);">
                        <div>
                            <div style="color: var(--text-primary); font-weight: 500;">Remove Missing Files</div>
                            <div style="font-size: 0.8rem; color: var(--text-secondary);">Delete database records for files no longer on disk.</div>
                        </div>
                    </label>

                    <label style="display: flex; align-items: center; gap: 0.75rem; cursor: pointer; padding: 0.5rem; border-radius: 8px; transition: background 0.2s;">
                        <input type="checkbox" id="icRepairMetadata" checked style="width: 18px; height: 18px; accent-color: var(--accent);">
                        <div>
                            <div style="color: var(--text-primary); font-weight: 500;">Repair Metadata</div>
                            <div style="font-size: 0.8rem; color: var(--text-secondary);">Fix missing dimensions, resolution, and file size data.</div>
                        </div>
                    </label>

                    <label style="display: flex; align-items: center; gap: 0.75rem; cursor: pointer; padding: 0.5rem; border-radius: 8px; transition: background 0.2s;">
                        <input type="checkbox" id="icRegenThumb" checked style="width: 18px; height: 18px; accent-color: var(--accent);">
                        <div>
                            <div style="color: var(--text-primary); font-weight: 500;">Regenerate Thumbnails</div>
                            <div style="font-size: 0.8rem; color: var(--text-secondary);">Rebuild missing thumbnails using the new unique ID scheme.</div>
                        </div>
                    </label>

                    <label style="display: flex; align-items: center; gap: 0.75rem; cursor: pointer; padding: 0.5rem; border-radius: 8px; transition: background 0.2s;">
                        <input type="checkbox" id="icPruneOrphanedEmbeddings" checked style="width: 18px; height: 18px; accent-color: #a78bfa;">
                        <div>
                            <div style="color: var(--text-primary); font-weight: 500;">Check & Prune Orphaned Embeddings</div>
                            <div style="font-size: 0.8rem; color: var(--text-secondary);">Scan search-embeddings.json and ovis-embeddings.json for vectors from deleted images and remove them.</div>
                        </div>
                    </label>
                    ${validate_diced_checkbox_markup}
                    <label style="display: flex; align-items: center; gap: 0.75rem; cursor: pointer; padding: 1rem; border-radius: 8px; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2);">
                        <input type="checkbox" id="icPurgeThumb" style="width: 18px; height: 18px; accent-color: #ef4444;">
                        <div>
                            <div style="color: #ef4444; font-weight: 600;">Purge Legacy Thumbnails</div>
                            <div style="font-size: 0.8rem; color: var(--text-secondary);">Wipe all old thumbnails to fix collisions. (Recommended)</div>
                        </div>
                    </label>
                </div>

                <div style="display: flex; gap: 1rem; justify-content: flex-end;">
                    <button id="icCancelBtn" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.6rem 1.25rem; border-radius: 8px; cursor: pointer; font-weight: 500;">Cancel</button>
                    <button id="icRunBtn" style="background: var(--accent); border: none; color: white; padding: 0.6rem 2rem; border-radius: 8px; cursor: pointer; font-weight: 600;">Run Check</button>
                </div>
            </div>
        `;

        document.body.appendChild(integrity_modal_container_element);

        integrity_modal_container_element.querySelector('#icCancelBtn').onclick = () => {
            integrity_modal_container_element.remove();
            resolve_promise_callback(null);
        };

        integrity_modal_container_element.querySelector('#icRunBtn').onclick = () => {
            const validate_diced_checkbox_element = integrity_modal_container_element.querySelector('#icValidateDiced');
            const selected_integrity_options = {
                removeMissing: integrity_modal_container_element.querySelector('#icRemoveMissing').checked,
                repairMetadata: integrity_modal_container_element.querySelector('#icRepairMetadata').checked,
                regenThumbnails: integrity_modal_container_element.querySelector('#icRegenThumb').checked,
                pruneOrphanedEmbeddings: integrity_modal_container_element.querySelector('#icPruneOrphanedEmbeddings').checked,
                ...(validate_diced_checkbox_element ? { validateDicedPrompts: validate_diced_checkbox_element.checked } : {}),
                purgeThumbnails: integrity_modal_container_element.querySelector('#icPurgeThumb').checked
            };
            integrity_modal_container_element.remove();
            resolve_promise_callback(selected_integrity_options);
        };
    });
}

/**
 * WHAT: Creates, styles, and presents a customized confirmation modal dialog overlay.
 * WHY:  Replaces native `window.confirm()` with an XSS-safe, keyboard-accessible dialog.
 *
 * @param {string} dialogue_message_text - Prompt message shown to the user.
 * @param {() => void} action_on_confirmation_callback - Callback executed when confirmed.
 * @param {string} [action_confirm_button_text='Delete'] - Label for the primary confirmation button.
 * @param {string} [action_confirm_button_color_hex='#ef4444'] - Accent color for the confirmation button.
 */
export function showConfirmModal(
    dialogue_message_text,
    action_on_confirmation_callback,
    action_confirm_button_text = 'Delete',
    action_confirm_button_color_hex = '#ef4444'
) {
    const confirmation_modal_container_element = document.createElement('div');
    confirmation_modal_container_element.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;';

    const escaped_dialogue_message_text = escapeHtmlCharacters(dialogue_message_text);
    const escaped_action_confirm_button_text = escapeHtmlCharacters(action_confirm_button_text);

    confirmation_modal_container_element.innerHTML = `
        <div style="background: linear-gradient(135deg, var(--card-bg) 0%, ${action_confirm_button_color_hex === '#ef4444' ? '#450a0a' : '#064e3b'} 100%); padding: 2rem; border-radius: 12px; border: 2px solid ${action_confirm_button_color_hex}; max-width: 400px; width: 90%; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.7);">
            <p style="margin: 0 0 1.5rem 0; color: var(--text-primary); font-size: 1.1rem; line-height: 1.4;">${escaped_dialogue_message_text}</p>
            <div style="display: flex; gap: 1rem; justify-content: center;">
                <button id="cancelConfirmBtn" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; transition: background 0.2s;">Cancel</button>
                <button id="okConfirmBtn" style="background: ${action_confirm_button_color_hex}; border: none; color: white; padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; font-weight: 600; box-shadow: 0 4px 12px ${action_confirm_button_color_hex}44; transition: transform 0.1s, filter 0.2s;">${escaped_action_confirm_button_text}</button>
            </div>
        </div>
    `;

    document.body.appendChild(confirmation_modal_container_element);

    const ok_confirmation_action_button_element = confirmation_modal_container_element.querySelector('#okConfirmBtn');
    const cancel_confirmation_action_button_element = confirmation_modal_container_element.querySelector('#cancelConfirmBtn');

    setTimeout(() => {
        ok_confirmation_action_button_element.focus();
    }, 10);

    const cleanup_modal_and_remove_event_listeners = () => {
        document.removeEventListener('keydown', keyboard_event_handler_function);
        confirmation_modal_container_element.remove();
    };

    const execute_confirmed_action_callback = () => {
        cleanup_modal_and_remove_event_listeners();
        action_on_confirmation_callback();
    };

    ok_confirmation_action_button_element.onclick = execute_confirmed_action_callback;
    cancel_confirmation_action_button_element.onclick = cleanup_modal_and_remove_event_listeners;

    confirmation_modal_container_element.onclick = (mouse_click_event_object) => {
        if (mouse_click_event_object.target === confirmation_modal_container_element) {
            cleanup_modal_and_remove_event_listeners();
        }
    };

    const keyboard_event_handler_function = (keyboard_event_object) => {
        if (keyboard_event_object.key === 'Enter') {
            keyboard_event_object.preventDefault();
            execute_confirmed_action_callback();
        } else if (keyboard_event_object.key === 'Escape') {
            keyboard_event_object.preventDefault();
            cleanup_modal_and_remove_event_listeners();
        }
    };

    document.addEventListener('keydown', keyboard_event_handler_function);
}

/**
 * WHAT: Creates, styles, and presents a customized alert dialog box to replace native `window.alert()`.
 * WHY:  Escapes both title and body text to block XSS and preserves multiline formatting (`white-space: pre-line`).
 *
 * @param {string} alert_dialogue_body_message_text - Message body to display.
 * @param {string} [alert_dialogue_header_title_text='Notification'] - Heading title text.
 * @param {(() => void) | null} [on_ok_action_callback_function=null] - Optional callback after dismissal.
 */
export function showAlertModal(
    alert_dialogue_body_message_text,
    alert_dialogue_header_title_text = 'Notification',
    on_ok_action_callback_function = null
) {
    const alert_modal_container_element = document.createElement('div');
    alert_modal_container_element.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;';

    const escaped_alert_dialogue_header_title_text = escapeHtmlCharacters(alert_dialogue_header_title_text);
    const escaped_alert_dialogue_body_message_text = escapeHtmlCharacters(alert_dialogue_body_message_text);

    alert_modal_container_element.innerHTML = `
        <div style="background: var(--card-bg); padding: 2rem; border-radius: 12px; border: 1px solid var(--border); max-width: 440px; width: 90%; text-align: center;">
            <h3 style="margin: 0 0 1rem 0; color: var(--text-primary);">${escaped_alert_dialogue_header_title_text}</h3>
            <p style="margin: 0 0 1.5rem 0; color: var(--text-primary); font-size: 1rem; white-space: pre-line; line-height: 1.5;">${escaped_alert_dialogue_body_message_text}</p>
            <div style="display: flex; gap: 1rem; justify-content: center;">
                <button id="okAlertBtn" style="background: var(--accent); border: none; color: white; padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; font-weight: 500;">OK</button>
            </div>
        </div>
    `;

    document.body.appendChild(alert_modal_container_element);

    const ok_alert_button_element = alert_modal_container_element.querySelector('#okAlertBtn');

    setTimeout(() => {
        ok_alert_button_element.focus();
    }, 10);

    const cleanup_modal_and_remove_event_listeners = () => {
        document.removeEventListener('keydown', keyboard_event_handler_function);
        alert_modal_container_element.remove();
        if (on_ok_action_callback_function) {
            on_ok_action_callback_function();
        }
    };

    ok_alert_button_element.onclick = cleanup_modal_and_remove_event_listeners;

    alert_modal_container_element.onclick = (mouse_click_event_object) => {
        if (mouse_click_event_object.target === alert_modal_container_element) {
            cleanup_modal_and_remove_event_listeners();
        }
    };

    const keyboard_event_handler_function = (keyboard_event_object) => {
        if (keyboard_event_object.key === 'Enter' || keyboard_event_object.key === 'Escape') {
            keyboard_event_object.preventDefault();
            cleanup_modal_and_remove_event_listeners();
        }
    };

    document.addEventListener('keydown', keyboard_event_handler_function);
}

/**
 * WHAT: Displays the interactive Bulk Rename modal with a scrollable preview of targeted files and recent rename chips.
 * WHY:  Accepts `recent_renames_list` as an explicit argument so the modal does not depend on hidden global storage reads.
 *
 * @param {ReadonlySet<string>} selected_image_ids_set - Set of selected image ID strings.
 * @param {readonly Record<string, any>[]} cached_images_metadata_array - Image metadata records for filename lookup.
 * @param {readonly string[]} [recent_renames_list=[]] - Recent base names for quick-select chips.
 * @returns {Promise<string | null>} Resolves with the entered base name or `null` if cancelled.
 */
export function showBulkRenameModal(
    selected_image_ids_set,
    cached_images_metadata_array,
    recent_renames_list = []
) {
    return new Promise((promise_resolution_handler_function) => {
        const bulk_rename_backdrop_element = document.createElement('div');
        bulk_rename_backdrop_element.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;';

        const retrieved_target_filenames_list = Array.from(selected_image_ids_set).map((each_image_id_string) => {
            const matched_image_metadata_object = (cached_images_metadata_array || []).find((each_cached_image) => {
                return String(each_cached_image.id) === String(each_image_id_string);
            });
            const filename_string_value = matched_image_metadata_object
                ? matched_image_metadata_object.filename
                : `Image #${each_image_id_string}`;
            return escapeHtmlCharacters(filename_string_value);
        });

        const compiled_preview_list_items_html_string = retrieved_target_filenames_list.slice(0, 100).map((escaped_filename_item) => `
            <li style="padding: 0.25rem 0; border-bottom: 1px solid rgba(255,255,255,0.05); color: var(--text-secondary); font-size: 0.85rem; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                📄 ${escaped_filename_item}
            </li>
        `).join('');

        const compiled_overflow_indicator_html_string = retrieved_target_filenames_list.length > 100
            ? `<li style="padding: 0.25rem 0; color: #a78bfa; font-size: 0.8rem; text-align: center;">...and ${retrieved_target_filenames_list.length - 100} more</li>`
            : '';

        const recent_renames_chips_html_string = Array.isArray(recent_renames_list) && recent_renames_list.length > 0
            ? `
                <div id="recentRenamesContainer" style="margin-bottom: 0.75rem; display: flex; flex-wrap: wrap; gap: 0.4rem; padding: 0.5rem; background: rgba(0,0,0,0.2); border-radius: 6px; border: 1px dashed rgba(167, 139, 250, 0.3);">
                    <span style="font-size: 0.7rem; color: #8b5cf6; width: 100%; margin-bottom: 0.2rem; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Recent:</span>
                    ${recent_renames_list.map((each_recent_name_string) => {
                        const escaped_recent_name_string = escapeHtmlCharacters(each_recent_name_string);
                        return `
                            <span class="recent-rename-chip"
                                  data-recent-name="${escaped_recent_name_string}"
                                  style="background: rgba(139, 92, 246, 0.15); border: 1px solid rgba(139, 92, 246, 0.3); color: #c4b5fd; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem; cursor: pointer; transition: all 0.2s;">
                                ${escaped_recent_name_string}
                            </span>
                        `;
                    }).join('')}
                </div>
            `
            : '';

        bulk_rename_backdrop_element.innerHTML = `
            <div style="background: linear-gradient(135deg, var(--card-bg) 0%, #1e1b4b 100%); padding: 2rem; border-radius: 12px; border: 2px solid #8b5cf6; max-width: 450px; width: 90%; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.7);">
                <h3 style="margin: 0 0 0.5rem 0; color: var(--text-primary); font-size: 1.25rem;">Bulk Rename Results</h3>
                <p style="margin: 0 0 1rem 0; color: #c4b5fd; font-size: 0.9rem;">Targeting ${selected_image_ids_set.size} selected image(s).</p>
                
                <div style="background: rgba(0,0,0,0.3); border: 1px solid #4c1d95; border-radius: 6px; padding: 0.5rem; margin-bottom: 1.5rem; max-height: 150px; overflow-y: auto;">
                    <ul style="list-style: none; padding: 0; margin: 0;">
                        ${compiled_preview_list_items_html_string}
                        ${compiled_overflow_indicator_html_string}
                    </ul>
                </div>

                <div style="margin-bottom: 1.5rem; text-align: left;">
                    <label style="display: block; color: #a78bfa; font-size: 0.85rem; margin-bottom: 0.5rem;">New Base Name (e.g. "coffee")</label>
                    ${recent_renames_chips_html_string}
                    <input type="text" id="renameBaseInput" placeholder="Enter base name..." style="width: 100%; padding: 0.75rem; border-radius: 6px; border: 1px solid #4c1d95; background: var(--bg-color); color: var(--text-primary); font-size: 1rem; outline: none; box-shadow: inset 0 2px 4px rgba(0,0,0,0.3);">
                    <p style="margin: 0.5rem 0 0 0; color: #8b5cf6; font-size: 0.75rem;">Fills gaps in sequence automatically: coffee_001, etc.</p>
                </div>

                <div style="display: flex; gap: 1rem; justify-content: flex-end;">
                    <button id="cancelRenameBtn" style="background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; transition: all 0.2s;">Cancel</button>
                    <button id="goRenameBtn" style="background: #8b5cf6; border: none; color: white; padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; font-weight: 500; transition: background 0.2s;">Go</button>
                </div>
            </div>
        `;

        document.body.appendChild(bulk_rename_backdrop_element);

        const text_input_field_element = bulk_rename_backdrop_element.querySelector('#renameBaseInput');
        const confirm_action_button_element = bulk_rename_backdrop_element.querySelector('#goRenameBtn');
        const cancel_action_button_element = bulk_rename_backdrop_element.querySelector('#cancelRenameBtn');

        // Wire recent rename chip clicks cleanly via dataset (avoiding inline quote escaping issues)
        bulk_rename_backdrop_element.querySelectorAll('.recent-rename-chip').forEach((chip_element) => {
            chip_element.addEventListener('click', () => {
                text_input_field_element.value = chip_element.dataset.recentName || '';
                text_input_field_element.focus();
            });
        });

        setTimeout(() => {
            text_input_field_element.focus();
        }, 50);

        const close_modal_and_resolve_promise_action = (final_entered_value_string) => {
            document.removeEventListener('keydown', keyboard_event_handler_function);
            bulk_rename_backdrop_element.remove();
            promise_resolution_handler_function(final_entered_value_string);
        };

        const validate_and_submit_changes_action = () => {
            const trimmed_input_value_string = text_input_field_element.value.trim();
            if (trimmed_input_value_string) {
                close_modal_and_resolve_promise_action(trimmed_input_value_string);
            } else {
                text_input_field_element.style.border = '1px solid #ef4444';
                setTimeout(() => {
                    text_input_field_element.style.border = '1px solid var(--border)';
                }, 1000);
            }
        };

        confirm_action_button_element.onclick = validate_and_submit_changes_action;
        cancel_action_button_element.onclick = () => {
            close_modal_and_resolve_promise_action(null);
        };

        const keyboard_event_handler_function = (keyboard_event_object) => {
            if (keyboard_event_object.key === 'Escape') {
                keyboard_event_object.preventDefault();
                close_modal_and_resolve_promise_action(null);
            } else if (keyboard_event_object.key === 'Enter') {
                keyboard_event_object.preventDefault();
                validate_and_submit_changes_action();
            }
        };

        document.addEventListener('keydown', keyboard_event_handler_function);
    });
}

/**
 * WHAT: Displays the single-image deletion modal offering "Delete from Database Only" vs "Delete from Computer & Database".
 * WHY:  Delegates the actual deletion callback (`on_delete_from_database_callback`) to the caller so this UI helper
 *       remains decoupled from page-specific state arrays.
 *
 * @param {string | number} image_identifier - Target image ID.
 * @param {string} full_filesystem_path - Full path on disk for Electron trash operations.
 * @param {HTMLElement} card_dom_element - Card element associated with the image.
 * @param {(image_id: string | number, card_element: HTMLElement) => Promise<void>} on_delete_from_database_callback - Callback to delete from DB.
 */
export function showDeleteModal(
    image_identifier,
    full_filesystem_path,
    card_dom_element,
    on_delete_from_database_callback
) {
    const delete_modal_container_element = document.createElement('div');
    delete_modal_container_element.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 9999;';
    delete_modal_container_element.innerHTML = `
        <div style="background: var(--card-bg); padding: 2rem; border-radius: 12px; border: 1px solid var(--border); max-width: 500px; width: 90%;">
            <h2 style="margin: 0 0 1rem 0; color: var(--text-primary);">Delete Image</h2>
            <p style="margin: 0 0 1.5rem 0; color: var(--text-secondary);">How would you like to delete this image?</p>
            <div style="display: flex; flex-direction: column; gap: 1rem;">
                <button id="deleteDbBtn" style="background: transparent; border: 1px solid var(--accent); color: var(--accent); padding: 0.75rem; border-radius: 6px; cursor: pointer; font-weight: 500;">Delete from Database Only</button>
                <button id="cancelBtn" style="background: #a1f0f0ff;border:2px solid var(--border);color: #240d00ff; font-size:2rem;font-weight:700;padding:1.75rem 1.75rem;border-radius:6px;cursor:pointer;margin-top:0.5rem;">Cancel</button>
                <button id="deleteDiskBtn" style="background: #ef4444; border: none; color: white; padding: 0.75rem; border-radius: 6px; cursor: pointer; font-weight: 600;">Delete from Computer & Database</button>
            </div>
        </div>
    `;
    document.body.appendChild(delete_modal_container_element);

    delete_modal_container_element.querySelector('#cancelBtn').onclick = () => delete_modal_container_element.remove();

    delete_modal_container_element.querySelector('#deleteDbBtn').onclick = async () => {
        delete_modal_container_element.remove();
        await on_delete_from_database_callback(image_identifier, card_dom_element);
    };

    delete_modal_container_element.querySelector('#deleteDiskBtn').onclick = async () => {
        if (!window.electronAPI || !window.electronAPI.trashFile) {
            showAlertModal('Error: Electron API not available for file operations.', 'System Error');
            return;
        }

        try {
            await window.electronAPI.trashFile(full_filesystem_path);
            delete_modal_container_element.remove();
            await on_delete_from_database_callback(image_identifier, card_dom_element);
        } catch (file_trash_error) {
            console.error('Error deleting file from disk:', file_trash_error);
            showAlertModal(`Failed to delete file from computer: ${file_trash_error.message}`, 'File Error');
            delete_modal_container_element.remove();
        }
    };

    delete_modal_container_element.onclick = (mouse_click_event_object) => {
        if (mouse_click_event_object.target === delete_modal_container_element) {
            delete_modal_container_element.remove();
        }
    };
}

/**
 * WHAT: Opens a full-screen lightbox preview of an image loaded via `window.electronAPI.readFile`.
 * WHY:  Revokes object URLs and removes keydown listeners deterministically upon exit to prevent memory leaks.
 *
 * @param {string} image_filesystem_path - Absolute disk path to the image file.
 */
export async function showImagePreview(image_filesystem_path) {
    try {
        const image_file_buffer = await window.electronAPI.readFile(image_filesystem_path);
        const image_blob_object = new Blob([image_file_buffer]);
        const temporary_object_url = URL.createObjectURL(image_blob_object);

        const preview_modal_container_element = document.createElement('div');
        preview_modal_container_element.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: rgba(0,0,0,0.95);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
            cursor: pointer;
            overflow: hidden;
        `;

        const modal_lightbox_image_element = document.createElement('img');
        modal_lightbox_image_element.src = temporary_object_url;
        modal_lightbox_image_element.style.cssText = `
            max-width: 95vw;
            max-height: 95vh;
            width: auto;
            height: auto;
            object-fit: contain;
            border-radius: 8px;
            cursor: default;
            box-shadow: 0 0 50px rgba(0,0,0,0.5);
        `;

        const dismiss_preview_and_revoke_url = () => {
            preview_modal_container_element.remove();
            URL.revokeObjectURL(temporary_object_url);
            document.removeEventListener('keydown', keydown_dismiss_handler_function);
        };

        modal_lightbox_image_element.onerror = () => {
            console.error('Failed to load image:', image_filesystem_path);
            dismiss_preview_and_revoke_url();
            showAlertModal('Failed to load image', 'Preview Error');
        };

        preview_modal_container_element.appendChild(modal_lightbox_image_element);

        const exit_hint_banner_element = document.createElement('div');
        exit_hint_banner_element.textContent = 'PRESS ANY KEY or Click anywhere TO EXIT';
        exit_hint_banner_element.style.cssText = `
            position: absolute;
            top: 2rem;
            left: 50%;
            transform: translateX(-50%);
            color: rgba(255,255,255,0.5);
            font-size: 0.9rem;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            pointer-events: none;
            background: rgba(0,0,0,0.3);
            padding: 0.5rem 1rem;
            border-radius: 20px;
        `;
        preview_modal_container_element.appendChild(exit_hint_banner_element);

        document.body.appendChild(preview_modal_container_element);

        const keydown_dismiss_handler_function = () => {
            dismiss_preview_and_revoke_url();
        };

        preview_modal_container_element.addEventListener('click', dismiss_preview_and_revoke_url);
        document.addEventListener('keydown', keydown_dismiss_handler_function);
    } catch (preview_load_error) {
        console.error('[IMAGE PREVIEW] Error loading image:', preview_load_error);
        showAlertModal(
            `Image File Not Found!\n\nPath: ${image_filesystem_path}\n\nThe file may have been moved or the path may be incorrect.`,
            'File Error'
        );
    }
}

