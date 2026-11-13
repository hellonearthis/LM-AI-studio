// ============================================================================
// IMAGE ANALYSIS STUDIO - MAIN APPLICATION LOGIC
// ============================================================================

import {
    buildDataUrlFromBuffer,
    mergeCustomTagsIntoAnalysis,
    extractDisplayableMetadataFields,
    buildFastScanBatchPayload,
    computeBatchProgressStats,
    tallyBatchSaveOutcome
} from './modules/appCore.js';

// DOM Elements
const selectFileBtn = document.getElementById('selectFileBtn');
const selectFolderBtn = document.getElementById('selectFolderBtn');
const fileMsg = document.getElementById('fileMsg');
const previewImg = document.getElementById('previewImg');
const resultsContainer = document.getElementById('resultsContainer');
const metadataOutput = document.getElementById('metadataOutput');
const analysisOutput = document.getElementById('analysisOutput');
const statusArea = document.getElementById('statusArea');
const progressContainer = document.getElementById('progressContainer');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const progressPercent = document.getElementById('progressPercent');
const currentFileEl = document.getElementById('currentFile');

// Sidebar Status Elements
const sidebarStatus = document.getElementById('sidebarStatus');
const statProcessed = document.getElementById('statProcessed');
const statAdded = document.getElementById('statAdded');
const statUpdated = document.getElementById('statUpdated');
const statExisting = document.getElementById('statExisting');
const statErrors = document.getElementById('statErrors');

// State
let isProcessing = false;
let batchErrors = []; // Track errors for current batch
const API_BASE_URL = 'http://localhost:3000';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

// WHAT: Updates the status message banner in the UI with styled alert feedback.
// WHY: Informs the user of asynchronous state progressions, file selections, and server errors.
function showStatus(status_message_text, alert_status_type = 'info') {
    statusArea.textContent = status_message_text;
    statusArea.className = `status-area ${alert_status_type}`;
    statusArea.style.display = 'block';

    if (alert_status_type === 'success') {
        setTimeout(() => {
            statusArea.style.display = 'none';
        }, 5000);
    }
}

// WHAT: Generates a SHA-256 cryptographic hash from a binary buffer.
// WHY: Uniquely identifies image contents regardless of file path or renaming.
async function calculateFileHash(image_binary_buffer) {
    const hash_array_buffer = await crypto.subtle.digest('SHA-256', image_binary_buffer);
    const hash_byte_array = Array.from(new Uint8Array(hash_array_buffer));
    return hash_byte_array.map(single_byte_value => single_byte_value.toString(16).padStart(2, '0')).join('');
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================

// File Selection using Electron Dialog
selectFileBtn.addEventListener('click', async () => {
    try {
        if (!window.electronAPI) {
            showStatus('Electron API not available', 'error');
            return;
        }

        // Use Electron's file picker
        const filePaths = await window.electronAPI.selectImageFile();

        if (!filePaths || filePaths.length === 0) {
            return; // User cancelled
        }

        showStatus(`Selected ${filePaths.length} file(s)...`, 'info');

        // WHAT: Branching between multi-file batch mode and single-file interactive preview.
        // WHY: Single files display an immediate live preview and metadata breakdown, whereas multiple
        //      files stream through the fast-scan batch queue with aggregate progress counters.
        if (filePaths.length > 1) {
            fileMsg.textContent = `${filePaths.length} files selected`;
            const filesToProcess = await Promise.all(
                filePaths.map(async (filePath) => {
                    try {
                        const file_stats = await window.electronAPI.getFileStats(filePath);
                        return {
                            path: filePath,
                            name: filePath.split(/[\\\/]/).slice(-1)[0],
                            mtime: file_stats.mtime,
                            size: file_stats.size
                        };
                    } catch (_stat_error) {
                        return {
                            path: filePath,
                            name: filePath.split(/[\\\/]/).slice(-1)[0]
                        };
                    }
                })
            );
            await processBatch(filesToProcess);
        } else {
            // Single file - process it
            const filePath = filePaths[0];
            const fileName = filePath.split('\\').slice(-1)[0];

            fileMsg.textContent = fileName;

            // Read file using Electron API
            const fileBuffer = await window.electronAPI.readFile(filePath);
            const base64Data = buildDataUrlFromBuffer(fileName, fileBuffer);

            // Show preview
            previewImg.src = base64Data;
            resultsContainer.style.display = 'block';
            document.querySelector('.analysis-grid').style.opacity = '0.3';

            // Reset outputs
            metadataOutput.innerHTML = '';
            analysisOutput.innerHTML = '';

            // Process the file
            await processSingleFile(filePath, fileName, fileBuffer, base64Data);
        }
    } catch (error) {
        console.error('Error selecting files:', error);
        showStatus('Failed to select files: ' + error.message, 'error');
    }
});

// Folder Selection using Electron API
if (selectFolderBtn) {
    selectFolderBtn.addEventListener('click', async () => {
        try {
            if (!window.electronAPI) throw new Error('Electron API not available');

            const folderPath = await window.electronAPI.selectFolder();
            if (!folderPath) return;

            showStatus(`Scanning folder: ${folderPath}...`, 'info');
            const images = await window.electronAPI.getImagesFromFolder(folderPath);

            if (images.length === 0) {
                showStatus('No images found in selected folder.', 'error');
                return;
            }

            showStatus(`Found ${images.length} images. Starting batch process...`, 'success');
            await processBatch(images);

        } catch (error) {
            console.error('Error selecting folder:', error);
            showStatus('Error selecting folder: ' + error.message, 'error');
        }
    });
}

// ============================================================================
// PROCESSING LOGIC
// ============================================================================

// WHAT: Processes a single selected image by checking duplicates, repairing missing thumbnails,
//       running AI vision analysis, and persisting the merged tags and metadata to SQLite.
// WHY: Ensures duplicate files do not trigger redundant LLM calls while still repairing missing thumbnails.
async function processSingleFile(filePath, fileName, fileBuffer, base64Data) {
    try {
        isProcessing = true;

        // WHAT: Hashing the raw image bytes before contacting the database.
        // WHY: Allows content-based deduplication even if the image was copied or renamed.
        const fileHash = await calculateFileHash(fileBuffer);

        // Get file creation date from filesystem
        const fileStats = await window.electronAPI.getFileStats(filePath);
        const fileCreationDate = fileStats.birthtime;

        // Check if file already exists in database
        showStatus('Checking for duplicates...', 'info');

        const checkResult = await autoSaveToDatabase({
            filename: fileName,
            path: filePath,
            file_hash: fileHash,
            metadata: {},
            analysis: {},
            created_at: fileCreationDate,
            size: fileStats.size
        });

        // WHAT: Short-circuiting analysis if the image hash already exists in the database.
        // WHY: Prevents expensive duplicate vision inference while ensuring an AVIF thumbnail is present.
        if (checkResult.duplicate) {
            showStatus(`File already in database. Checking thumbnail...`, 'info');

            const thumbnailPath = `thumbnails/id_${checkResult.id}.avif`;

            try {
                const thumbCheck = await fetch(`${API_BASE_URL}/${thumbnailPath}`, { method: 'HEAD' });

                if (!thumbCheck.ok) {
                    showStatus('Thumbnail missing, generating...', 'info');
                    await fetch(`${API_BASE_URL}/create-thumbnail`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            imageData: base64Data,
                            id: checkResult.id
                        })
                    });
                    showStatus('Thumbnail generated for existing record.', 'success');
                } else {
                    showStatus(`File already in database (found at: ${checkResult.existingPath || filePath})`, 'info');
                }
            } catch (thumbnail_check_error) {
                console.warn('Thumbnail check failed, attempting to generate:', thumbnail_check_error);
                await fetch(`${API_BASE_URL}/create-thumbnail`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        imageData: base64Data,
                        id: checkResult.id
                    })
                });
            }

            sidebarStatus.style.display = 'block';
            statProcessed.textContent = '1';
            statExisting.textContent = '1';
            statAdded.textContent = '0';
            statUpdated.textContent = '0';
            statErrors.textContent = '0';

            isProcessing = false;
            return;
        }

        // File is new or updated - perform analysis
        showStatus('Analyzing image with LM Studio...', 'info');
        const analysis_response = await performAnalysis(base64Data);

        // WHAT: Merging optional user-supplied custom tags into the AI analysis result.
        // WHY: Ensures batch/user-defined organization tags are persisted alongside AI-detected tags.
        const customTagsInput = document.getElementById('customTagsInput');
        const enriched_analysis = customTagsInput
            ? mergeCustomTagsIntoAnalysis(analysis_response.analysis, customTagsInput.value)
            : analysis_response.analysis;

        // Display Results
        displayMetadata(analysis_response.metadata);
        displayAnalysis(enriched_analysis);
        document.querySelector('.analysis-grid').style.opacity = '1';

        console.log('[APP] Saving analysis results to database...');
        const finalSaveResult = await autoSaveToDatabase({
            filename: fileName,
            path: filePath,
            file_hash: fileHash,
            metadata: analysis_response.metadata,
            analysis: enriched_analysis,
            created_at: fileCreationDate,
            mtime: fileStats.mtime,
            size: fileStats.size,
            imageData: base64Data
        });
        console.log('[APP] Final Save Result:', finalSaveResult);

        sidebarStatus.style.display = 'block';
        statProcessed.textContent = '1';
        statAdded.textContent = checkResult.new ? '1' : '0';
        statUpdated.textContent = (checkResult.updated || finalSaveResult.updated) ? '1' : '0';
        statExisting.textContent = '0';
        statErrors.textContent = '0';

        const status_message_text = 'Analysis complete and saved!';
        showStatus(status_message_text, 'success');

    } catch (error) {
        console.error('Analysis error:', error);
        showStatus('Analysis failed: ' + error.message, 'error');

        sidebarStatus.style.display = 'block';
        statErrors.textContent = '1';
    } finally {
        isProcessing = false;
    }
}

// WHAT: Sequentially processes a list of image files, skipping exact fast-scan matches and updating progress bars.
// WHY: Bulk pre-checking path+size+mtime avoids reading unchanged files from disk and keeps local GPU inference stable.
async function processBatch(files) {
    if (isProcessing) return;
    isProcessing = true;

    progressContainer.style.display = 'block';
    selectFileBtn.style.pointerEvents = 'none';
    resultsContainer.style.display = 'none';
    statusArea.style.display = 'none';

    try {
        let batch_counters = {
            processedCount: 0,
            errorCount: 0,
            addedCount: 0,
            updatedCount: 0,
            existingCount: 0
        };
        const totalFiles = files.length;

        batchErrors = [];
        sidebarStatus.style.display = 'block';
        statProcessed.textContent = `0/${totalFiles}`;
        statAdded.textContent = '0';
        statUpdated.textContent = '0';
        statExisting.textContent = '0';
        statErrors.textContent = '0';

        // WHAT: Sending file metadata in one batch request before reading any image bytes.
        // WHY: Lets the server identify unchanged files in milliseconds via path, size, and mtime.
        progressText.textContent = 'Checking existing files...';
        let existingRecords = {};

        try {
            const batchPayload = buildFastScanBatchPayload(files);

            const response = await fetch(`${API_BASE_URL}/check-fast-batch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ files: batchPayload })
            });

            if (response.ok) {
                const batch_check_payload = await response.json();
                existingRecords = batch_check_payload.results || {};
            }
        } catch (batch_check_error) {
            console.error('Failed to check existing files:', batch_check_error);
        }

        // 2. Process each file
        for (let file_iteration_index = 0; file_iteration_index < totalFiles; file_iteration_index++) {
            const fileData = files[file_iteration_index];
            const filePath = fileData.path;
            const filename = filePath.split(/[\\\/]/).slice(-1)[0];

            const progress_stats = computeBatchProgressStats(file_iteration_index, totalFiles, filename);
            progressBar.style.width = progress_stats.percentText;
            progressPercent.textContent = progress_stats.percentText;
            currentFileEl.textContent = progress_stats.currentFileText;
            statProcessed.textContent = progress_stats.processedText;

            if (existingRecords[filePath] === 'exact') {
                console.log(`[FAST SCAN] Skipping ${filename} (unchanged)`);
                batch_counters = {
                    ...batch_counters,
                    existingCount: batch_counters.existingCount + 1,
                    processedCount: batch_counters.processedCount + 1
                };
                statExisting.textContent = batch_counters.existingCount;
                continue;
            }

            try {
                const fileBuffer = await window.electronAPI.readFile(filePath);
                const base64Data = buildDataUrlFromBuffer(filename, fileBuffer);
                const currentHash = await calculateFileHash(fileBuffer);
                const fileStats = await window.electronAPI.getFileStats(filePath);
                const fileCreationDate = fileStats.birthtime;

                const analysisResult = await performAnalysis(base64Data);

                const customTagsInput = document.getElementById('customTagsInput');
                const enriched_analysis = customTagsInput
                    ? mergeCustomTagsIntoAnalysis(analysisResult.analysis, customTagsInput.value)
                    : analysisResult.analysis;

                const saveResult = await autoSaveToDatabase({
                    filename,
                    path: filePath,
                    file_hash: currentHash,
                    metadata: analysisResult.metadata,
                    analysis: enriched_analysis,
                    created_at: fileCreationDate,
                    mtime: fileData.mtime ?? fileStats.mtime,
                    size: fileData.size ?? fileStats.size,
                    imageData: base64Data
                });

                batch_counters = tallyBatchSaveOutcome(batch_counters, saveResult);
                statAdded.textContent = batch_counters.addedCount;
                statUpdated.textContent = batch_counters.updatedCount;
                statExisting.textContent = batch_counters.existingCount;

            } catch (error) {
                console.error(`Error processing ${filename}:`, error);
                batch_counters = { ...batch_counters, errorCount: batch_counters.errorCount + 1 };
                batchErrors = [...batchErrors, { filename, error: error.message }];
                statErrors.textContent = batch_counters.errorCount;
            }

            batch_counters = { ...batch_counters, processedCount: batch_counters.processedCount + 1 };
        }

        progressBar.style.width = '100%';
        progressPercent.textContent = '100%';
        progressText.textContent = 'Batch Processing Complete';
        currentFileEl.textContent = `Processed ${totalFiles} files. Added: ${batch_counters.addedCount}, Updated: ${batch_counters.updatedCount}, Existing: ${batch_counters.existingCount}, Errors: ${batch_counters.errorCount}`;
    } finally {
        isProcessing = false;
        selectFileBtn.style.pointerEvents = 'auto';
    }
}

// ============================================================================
// API FUNCTIONS
// ============================================================================

// WHAT: Sends a Base64 image and chosen prompt template to the backend `/analyze` endpoint.
// WHY: Isolates the network boundary for vision inference and raises descriptive errors on HTTP failure.
async function performAnalysis(base64Data) {
    const promptTypeSelect = document.getElementById('promptType');
    const promptType = promptTypeSelect ? promptTypeSelect.value : 'Ultra Detailed Description';

    const response = await fetch(`${API_BASE_URL}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            imageData: base64Data,
            promptType: promptType
        })
    });

    if (!response.ok) {
        const error_payload = await response.json();
        throw new Error(error_payload.error || 'Analysis failed');
    }

    return await response.json();
}

// WHAT: Persists an analyzed (or pre-checked) image record to the backend `/save` endpoint.
// WHY: Centralizes database persistence and duplicate detection behind one uniform fetch boundary.
async function autoSaveToDatabase(image_payload) {
    const response = await fetch(`${API_BASE_URL}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(image_payload)
    });

    if (!response.ok) {
        const error_payload = await response.json();
        throw new Error(error_payload.error || 'Database save failed');
    }

    return await response.json();
}

// ============================================================================
// MODAL FUNCTIONS
// ============================================================================

// WHAT: Opens the modal listing every file that failed during the most recent batch run.
// WHY: Gives the user actionable per-file diagnostics instead of silently swallowing batch errors.
function showErrorModal() {
    const modal = document.getElementById('errorModal');
    const errorList = document.getElementById('errorList');

    if (batchErrors.length === 0) {
        showStatus('No errors recorded in the last batch.', 'info');
        return;
    }

    errorList.innerHTML = '';
    batchErrors.forEach(batch_error_entry => {
        const item = document.createElement('div');
        item.className = 'error-list-item';
        const file_name_span = document.createElement('span');
        file_name_span.className = 'error-file-name';
        file_name_span.textContent = String(batch_error_entry.filename || '');
        const error_message_span = document.createElement('span');
        error_message_span.className = 'error-message-text';
        error_message_span.textContent = String(batch_error_entry.error || '');
        item.append(file_name_span, error_message_span);
        errorList.appendChild(item);
    });

    modal.style.display = 'flex';
}

// Event Listeners for Modal
document.querySelector('.status-errors').addEventListener('click', showErrorModal);
document.getElementById('closeErrorModal').addEventListener('click', () => {
    document.getElementById('errorModal').style.display = 'none';
});
document.getElementById('closeErrorModalBtn').addEventListener('click', () => {
    document.getElementById('errorModal').style.display = 'none';
});

// Close modal on click outside
window.addEventListener('click', (event) => {
    const modal = document.getElementById('errorModal');
    if (event.target === modal) {
        modal.style.display = 'none';
    }
});

// ============================================================================
// DISPLAY FUNCTIONS
// ============================================================================

// WHAT: Formats and injects EXIF camera metadata and optional ComfyUI prompt/workflow JSON into the UI.
// WHY: Separates technical image telemetry from semantic AI descriptions for quick photographer inspection.
function displayMetadata(metadata) {
    console.log('[APP] Displaying metadata:', metadata); // Debug log
    metadataOutput.innerHTML = '';

    const fields = extractDisplayableMetadataFields(metadata);

    fields.forEach(field => {
        const item = document.createElement('div');
        item.className = 'metadata-item';
        const label_strong = document.createElement('strong');
        label_strong.textContent = `${field.label}: `;
        const value_text = document.createTextNode(String(field.value));
        item.append(label_strong, value_text);
        metadataOutput.appendChild(item);
    });

    // Display ComfyUI Metadata (Prompt/Workflow)
    if (metadata.prompt || metadata.workflow) {
        const comfyDiv = document.createElement('div');
        comfyDiv.style.marginTop = '1rem';
        comfyDiv.style.borderTop = '1px solid var(--border)';
        comfyDiv.style.paddingTop = '0.5rem';

        const append_json_details = (summary_label, json_payload, margin_top) => {
            const details_element = document.createElement('details');
            if (margin_top) details_element.style.marginTop = margin_top;
            const summary_element = document.createElement('summary');
            summary_element.style.cssText = 'cursor:pointer; color:var(--accent);';
            summary_element.textContent = summary_label;
            const pre_element = document.createElement('pre');
            pre_element.style.cssText = 'font-size:0.7rem; overflow:auto; max-height:200px; background:rgba(0,0,0,0.2); padding:0.5rem; border-radius:4px;';
            pre_element.textContent = JSON.stringify(json_payload, null, 2);
            details_element.append(summary_element, pre_element);
            comfyDiv.appendChild(details_element);
        };

        if (metadata.prompt) {
            append_json_details('ComfyUI Prompt', metadata.prompt, null);
        }

        if (metadata.workflow) {
            append_json_details('ComfyUI Workflow', metadata.workflow, '0.5rem');
        }

        metadataOutput.appendChild(comfyDiv);
    }
}

// WHAT: Renders the structured AI vision analysis (summary, detected objects, tags, scene type, technical details).
// WHY: Displays each semantic facet with visual distinction (green pills for objects, indigo for scene type).
function displayAnalysis(description) {
    analysisOutput.innerHTML = '';

    // Summary
    if (description.summary) {
        const summaryDiv = document.createElement('div');
        summaryDiv.className = 'analysis-section';
        const heading_element = document.createElement('h3');
        heading_element.textContent = 'Summary';
        const paragraph_element = document.createElement('p');
        paragraph_element.textContent = String(description.summary);
        summaryDiv.append(heading_element, paragraph_element);
        analysisOutput.appendChild(summaryDiv);
    }

    // Objects
    if (description.objects && description.objects.length > 0) {
        const objectsDiv = document.createElement('div');
        objectsDiv.className = 'analysis-section';
        objectsDiv.innerHTML = '<h3>Detected Objects</h3><div class="tags-container"></div>';
        const objectsContainer = objectsDiv.querySelector('.tags-container');

        description.objects.forEach(detected_object_label => {
            const object_badge_element = document.createElement('span');
            object_badge_element.className = 'tag';
            object_badge_element.style.backgroundColor = 'rgba(16, 185, 129, 0.2)'; // Green tint for objects
            object_badge_element.style.color = '#34d399';
            object_badge_element.textContent = detected_object_label;
            objectsContainer.appendChild(object_badge_element);
        });
        analysisOutput.appendChild(objectsDiv);
    }

    // Tags
    if (description.tags && description.tags.length > 0) {
        const tagsDiv = document.createElement('div');
        tagsDiv.className = 'analysis-section';
        tagsDiv.innerHTML = '<h3>Tags</h3><div class="tags-container"></div>';
        const tagsContainer = tagsDiv.querySelector('.tags-container');

        description.tags.forEach(tag => {
            const tagSpan = document.createElement('span');
            tagSpan.className = 'tag';
            tagSpan.textContent = `${tag}`;
            tagsContainer.appendChild(tagSpan);
        });

        // Add scene type if available
        if (description.scene_type) {
            const sceneTag = document.createElement('span');
            sceneTag.className = 'tag';
            sceneTag.style.backgroundColor = 'rgba(129, 140, 248, 0.2)';
            sceneTag.style.color = '#818cf8';
            sceneTag.textContent = description.scene_type;
            tagsContainer.appendChild(sceneTag);
        }

        analysisOutput.appendChild(tagsDiv);
    }

    // Technical Details
    if (description.technical_details) {
        const techDiv = document.createElement('div');
        techDiv.className = 'analysis-section';
        const heading_element = document.createElement('h3');
        heading_element.textContent = 'Technical Details';
        const paragraph_element = document.createElement('p');
        paragraph_element.textContent = String(description.technical_details);
        techDiv.append(heading_element, paragraph_element);
        analysisOutput.appendChild(techDiv);
    }
}
