// ============================================================================
// IMAGE ANALYSIS STUDIO - MAIN APPLICATION LOGIC
// ============================================================================

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
const API_BASE_URL = 'http://localhost:3000';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function showStatus(message, type = 'info') {
    statusArea.textContent = message;
    statusArea.className = `status-area ${type}`;
    statusArea.style.display = 'block';

    if (type === 'success') {
        setTimeout(() => {
            statusArea.style.display = 'none';
        }, 5000);
    }
}

async function calculateFileHash(fileBuffer) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', fileBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
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

        // For multiple files, batch process them
        if (filePaths.length > 1) {
            fileMsg.textContent = `${filePaths.length} files selected`;
            const filesToProcess = filePaths.map(filePath => ({
                path: filePath,
                name: filePath.split('\\').pop()
            }));
            await processBatch(filesToProcess);
        } else {
            // Single file - process it
            const filePath = filePaths[0];
            const fileName = filePath.split('\\').pop();

            fileMsg.textContent = fileName;

            // Read file using Electron API
            const fileBuffer = await window.electronAPI.readFile(filePath);
            const base64Data = `data:image/jpeg;base64,${btoa(
                new Uint8Array(fileBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
            )}`;

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

async function processSingleFile(filePath, fileName, fileBuffer, base64Data) {
    try {
        isProcessing = true;

        // Calculate file hash
        const fileHash = await calculateFileHash(fileBuffer);

        // Check if file already exists in database
        showStatus('Checking for duplicates...', 'info');

        const checkResult = await autoSaveToDatabase({
            filename: fileName,
            path: filePath,
            file_hash: fileHash,
            metadata: {},
            analysis: {},
            created_at: new Date().toISOString()
        });

        if (checkResult.duplicate) {
            showStatus(`File already in database (found at: ${checkResult.existingPath || filePath})`, 'info');

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
        const result = await performAnalysis(base64Data);

        // Display Results
        displayMetadata(result.metadata);
        displayAnalysis(result.description);
        document.querySelector('.analysis-grid').style.opacity = '1';

        // Update database with analysis results
        await autoSaveToDatabase({
            filename: fileName,
            path: filePath,
            file_hash: fileHash,
            metadata: result.metadata,
            analysis: result.description,
            created_at: new Date().toISOString()
        });

        // Generate Thumbnail
        await fetch(`${API_BASE_URL}/create-thumbnail`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                imageData: base64Data,
                filename: fileName
            })
        });

        // Show status in sidebar
        sidebarStatus.style.display = 'block';
        statProcessed.textContent = '1';
        statAdded.textContent = checkResult.new ? '1' : '0';
        statUpdated.textContent = checkResult.updated ? '1' : '0';
        statExisting.textContent = '0';
        statErrors.textContent = '0';

        const statusMsg = checkResult.updated ? 'Analysis complete - record updated!' : 'Analysis complete and saved to database!';
        showStatus(statusMsg, 'success');

    } catch (error) {
        console.error('Analysis error:', error);
        showStatus('Analysis failed: ' + error.message, 'error');

        sidebarStatus.style.display = 'block';
        statErrors.textContent = '1';
    } finally {
        isProcessing = false;
    }
}

async function processBatch(files) {
    if (isProcessing) return;
    isProcessing = true;

    // Reset UI
    progressContainer.style.display = 'block';
    selectFileBtn.style.pointerEvents = 'none';
    resultsContainer.style.display = 'none';
    statusArea.style.display = 'none';

    let processedCount = 0;
    let errorCount = 0;
    let addedCount = 0;
    let updatedCount = 0;
    let existingCount = 0;
    const totalFiles = files.length;

    // Initialize Status UI
    sidebarStatus.style.display = 'block';
    statProcessed.textContent = `0/${totalFiles}`;
    statAdded.textContent = '0';
    statUpdated.textContent = '0';
    statExisting.textContent = '0';
    statErrors.textContent = '0';

    // 1. Bulk check existing files
    progressText.textContent = 'Checking existing files...';
    const filePaths = files.map(f => f.path);
    let existingRecords = {};

    try {
        const response = await fetch(`${API_BASE_URL}/check-files`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePaths })
        });
        if (response.ok) {
            existingRecords = await response.json();
        }
    } catch (err) {
        console.error('Failed to check existing files:', err);
    }

    // 2. Process each file
    for (let i = 0; i < totalFiles; i++) {
        const fileData = files[i];
        const filePath = fileData.path;
        const filename = filePath.split(/[\\\/]/).pop();

        // Update progress UI
        const percent = Math.round((i / totalFiles) * 100);
        progressBar.style.width = `${percent}%`;
        progressPercent.textContent = `${percent}%`;
        currentFileEl.textContent = `Processing: ${filename}`;
        statProcessed.textContent = `${i + 1}/${totalFiles}`;

        try {
            const existing = existingRecords[filePath];

            // Read file using Electron API
            const fileBuffer = await window.electronAPI.readFile(filePath);
            const base64Data = `data:image/jpeg;base64,${btoa(
                new Uint8Array(fileBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
            )}`;

            const currentHash = await calculateFileHash(fileBuffer);

            if (existing && existing.file_hash === currentHash) {
                console.log(`Skipping ${filename} (already analyzed and unchanged)`);
                existingCount++;
                statExisting.textContent = existingCount;
                processedCount++;
                continue;
            }

            // Perform Analysis
            const analysisResult = await performAnalysis(base64Data);

            // Save to DB
            const saveResult = await autoSaveToDatabase({
                filename,
                path: filePath,
                file_hash: currentHash,
                metadata: analysisResult.metadata,
                analysis: analysisResult.description,
                created_at: new Date().toISOString()
            });

            if (saveResult.new) {
                addedCount++;
                statAdded.textContent = addedCount;
            } else if (saveResult.updated) {
                updatedCount++;
                statUpdated.textContent = updatedCount;
            } else if (saveResult.duplicate) {
                existingCount++;
                statExisting.textContent = existingCount;
            } else {
                addedCount++;
                statAdded.textContent = addedCount;
            }

            // Generate Thumbnail
            await fetch(`${API_BASE_URL}/create-thumbnail`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    imageData: base64Data,
                    filename: filename
                })
            });

        } catch (error) {
            console.error(`Error processing ${filename}:`, error);
            errorCount++;
            statErrors.textContent = errorCount;
        }

        processedCount++;
    }

    // Complete
    progressBar.style.width = '100%';
    progressPercent.textContent = '100%';
    progressText.textContent = 'Batch Processing Complete';
    currentFileEl.textContent = `Processed ${totalFiles} files. Added: ${addedCount}, Updated: ${updatedCount}, Existing: ${existingCount}, Errors: ${errorCount}`;

    isProcessing = false;
    selectFileBtn.style.pointerEvents = 'auto';
}

// ============================================================================
// API FUNCTIONS
// ============================================================================

async function performAnalysis(base64Data) {
    const response = await fetch(`${API_BASE_URL}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageData: base64Data })
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Analysis failed');
    }

    return await response.json();
}

async function autoSaveToDatabase(data) {
    const response = await fetch(`${API_BASE_URL}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Database save failed');
    }

    return await response.json();
}

// ============================================================================
// DISPLAY FUNCTIONS
// ============================================================================

function displayMetadata(metadata) {
    console.log('[APP] Displaying metadata:', metadata); // Debug log
    metadataOutput.innerHTML = '';

    const fields = [
        { label: 'Width', value: metadata.ImageWidth || metadata.ExifImageWidth || metadata.PixelXDimension },
        { label: 'Height', value: metadata.ImageHeight || metadata.ExifImageHeight || metadata.PixelYDimension },
        { label: 'Camera', value: metadata.Make && metadata.Model ? `${metadata.Make} ${metadata.Model}` : null },
        { label: 'Lens', value: metadata.LensModel },
        { label: 'ISO', value: metadata.ISO },
        { label: 'Aperture', value: metadata.FNumber ? `f/${metadata.FNumber}` : null },
        { label: 'Shutter', value: metadata.ExposureTime },
        { label: 'Focal Length', value: metadata.FocalLength ? `${metadata.FocalLength}mm` : null }
    ];

    fields.forEach(field => {
        if (field.value) {
            const item = document.createElement('div');
            item.className = 'metadata-item';
            item.innerHTML = `<strong>${field.label}:</strong> ${field.value}`;
            metadataOutput.appendChild(item);
        }
    });

    // Display ComfyUI Metadata (Prompt/Workflow)
    if (metadata.prompt || metadata.workflow) {
        const comfyDiv = document.createElement('div');
        comfyDiv.style.marginTop = '1rem';
        comfyDiv.style.borderTop = '1px solid var(--border)';
        comfyDiv.style.paddingTop = '0.5rem';

        if (metadata.prompt) {
            const details = document.createElement('details');
            details.innerHTML = '<summary style="cursor:pointer; color:var(--accent);">ComfyUI Prompt</summary><pre style="font-size:0.7rem; overflow:auto; max-height:200px; background:rgba(0,0,0,0.2); padding:0.5rem; border-radius:4px;">' + JSON.stringify(metadata.prompt, null, 2) + '</pre>';
            comfyDiv.appendChild(details);
        }

        if (metadata.workflow) {
            const details = document.createElement('details');
            details.style.marginTop = '0.5rem';
            details.innerHTML = '<summary style="cursor:pointer; color:var(--accent);">ComfyUI Workflow</summary><pre style="font-size:0.7rem; overflow:auto; max-height:200px; background:rgba(0,0,0,0.2); padding:0.5rem; border-radius:4px;">' + JSON.stringify(metadata.workflow, null, 2) + '</pre>';
            comfyDiv.appendChild(details);
        }

        metadataOutput.appendChild(comfyDiv);
    }
}

function displayAnalysis(description) {
    analysisOutput.innerHTML = '';

    // Summary
    if (description.summary) {
        const summaryDiv = document.createElement('div');
        summaryDiv.className = 'analysis-section';
        summaryDiv.innerHTML = `<h3>Summary</h3><p>${description.summary}</p>`;
        analysisOutput.appendChild(summaryDiv);
    }

    // Objects
    if (description.objects && description.objects.length > 0) {
        const objectsDiv = document.createElement('div');
        objectsDiv.className = 'analysis-section';
        objectsDiv.innerHTML = '<h3>Detected Objects</h3><div class="tags-container"></div>';
        const objectsContainer = objectsDiv.querySelector('.tags-container');

        description.objects.forEach(obj => {
            const objSpan = document.createElement('span');
            objSpan.className = 'tag';
            objSpan.style.backgroundColor = 'rgba(16, 185, 129, 0.2)'; // Green tint for objects
            objSpan.style.color = '#34d399';
            objSpan.textContent = obj;
            objectsContainer.appendChild(objSpan);
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
            tagSpan.textContent = `#${tag}`;
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
        techDiv.innerHTML = `<h3>Technical Details</h3><p>${description.technical_details}</p>`;
        analysisOutput.appendChild(techDiv);
    }
}
