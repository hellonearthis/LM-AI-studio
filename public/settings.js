const API_BASE_URL = 'http://localhost:3000'; // Adjust if needed

const visionSelect = document.getElementById('visionModelSelect');
const embeddingSelect = document.getElementById('embeddingModelSelect');
const gpuLayersInput = document.getElementById('gpuLayers');
const contextLengthInput = document.getElementById('contextLength');
const advancedToggle = document.getElementById('advancedToggle');
const advancedContent = document.getElementById('advancedContent');
const toggleIcon = document.getElementById('toggleIcon');
const loadModelBtn = document.getElementById('loadModelBtn');
const loadStatus = document.getElementById('loadStatus');

const refreshBtn = document.getElementById('refreshModelsBtn');
const saveBtn = document.getElementById('saveConfigBtn');
const saveStatus = document.getElementById('saveStatus');
const diagnosticsOutput = document.getElementById('diagnosticsOutput');

// Advanced Toggle Logic
if (advancedToggle) {
    advancedToggle.addEventListener('click', () => {
        advancedContent.classList.toggle('open');
        toggleIcon.textContent = advancedContent.classList.contains('open') ? '▼' : '▶';
    });
}

// Initial Load
document.addEventListener('DOMContentLoaded', async () => {
    await refreshModels();
    await loadConfig();
});

refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing...';
    await refreshModels();
    refreshBtn.textContent = '🔄 Refresh Models';
    refreshBtn.disabled = false;
});

saveBtn.addEventListener('click', async () => {
    const config = {
        visionModel: visionSelect.value,
        embeddingModel: embeddingSelect.value,
        gpuLayers: gpuLayersInput ? gpuLayersInput.value : 'max',
        contextLength: parseInt(contextLengthInput ? contextLengthInput.value : '8192', 10) || 8192
    };

    try {
        const res = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });

        if (res.ok) {
            saveStatus.style.display = 'inline';
            setTimeout(() => saveStatus.style.display = 'none', 2000);
            updateDiagnostics(); // Refresh diagnostics to show active logic
        } else {
            alert('Failed to save configuration');
        }
    } catch (e) {
        console.error(e);
        alert('Error saving configuration');
    }
});

if (loadModelBtn) {
    loadModelBtn.addEventListener('click', async () => {
        const modelId = visionSelect.value;
        if (!modelId) {
            alert('Please select a Vision model first.');
            return;
        }

        const gpuLayers = gpuLayersInput ? gpuLayersInput.value : 'max';
        const contextLength = parseInt(contextLengthInput ? contextLengthInput.value : '8192', 10) || 8192;

        loadModelBtn.disabled = true;
        loadModelBtn.textContent = '⏳ Loading Model...';
        loadStatus.textContent = 'Initiating load in LM Studio...';
        loadStatus.style.color = 'var(--accent)';

        try {
            const response = await fetch('/api/proxy/load', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model_identifier: modelId,
                    config: {
                        gpu_offload: gpuLayers,
                        context_length: contextLength
                    }
                })
            });

            const data = await response.json();

            if (response.ok) {
                loadStatus.textContent = '✅ Model Loaded Successfully!';
                loadStatus.style.color = '#4ade80';
                updateDiagnostics();
            } else {
                loadStatus.textContent = '❌ Load Failed: ' + (data.error || 'Check LM Studio');
                loadStatus.style.color = '#ef4444';
            }
        } catch (err) {
            console.error(err);
            loadStatus.textContent = '❌ Connection Error';
            loadStatus.style.color = '#ef4444';
        } finally {
            loadModelBtn.disabled = false;
            loadModelBtn.textContent = '🚀 Load into GPU';
            setTimeout(() => { if (loadStatus.textContent && loadStatus.textContent.includes('Success')) loadStatus.textContent = ''; }, 5000);
        }
    });
}

async function refreshModels() {
    try {
        // We can proxy this through our server to avoid CORS if needed, 
        // but let's try direct first or use a new proxy endpoint if we made one?
        // Actually, let's use a new proxy endpoint for cleaner architecture 
        // or just hit the LM Studio URL if we are sure about CORS.
        // Server side proxy is safer.
        const res = await fetch('/api/proxy/models');
        if (!res.ok) throw new Error('Failed to fetch models');

        const data = await res.json();
        const models = data.data || [];

        // Save current selection to restore it if it exists in new list
        const currentVision = visionSelect.value;
        const currentEmbed = embeddingSelect.value;

        // Clear options (keep first "Auto" option)
        while (visionSelect.options.length > 1) visionSelect.remove(1);
        while (embeddingSelect.options.length > 1) embeddingSelect.remove(1);

        models.forEach(model => {
            const optV = document.createElement('option');
            optV.value = model.id;
            optV.textContent = model.id;
            visionSelect.appendChild(optV);

            const optE = document.createElement('option');
            optE.value = model.id;
            optE.textContent = model.id;
            embeddingSelect.appendChild(optE);
        });

        // Restore selection if possible, or set to empty (auto)
        visionSelect.value = currentVision;
        embeddingSelect.value = currentEmbed;

        updateDiagnostics(models);

    } catch (e) {
        console.error(e);
        diagnosticsOutput.textContent = 'Error loading models from LM Studio: ' + e.message + '\nEnsure LM Studio is running.';
    }
}

async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        if (res.ok) {
            const config = await res.json();
            if (config.visionModel) {
                // Check if it exists in select, if not, add it (it might be a JIT model not in the list yet)
                const exists = Array.from(visionSelect.options).some(opt => opt.value === config.visionModel);
                if (!exists && config.visionModel) {
                    const opt = document.createElement('option');
                    opt.value = config.visionModel;
                    opt.textContent = `${config.visionModel} (Configured)`;
                    visionSelect.appendChild(opt);
                }
                visionSelect.value = config.visionModel;
            }
            if (config.embeddingModel) embeddingSelect.value = config.embeddingModel;
            if (config.gpuLayers && gpuLayersInput) gpuLayersInput.value = config.gpuLayers;
            if (config.contextLength && contextLengthInput) contextLengthInput.value = config.contextLength;
        }
    } catch (e) {
        console.error('Error loading config:', e);
    }
}

function updateDiagnostics(models = []) {
    // Show what the server thinks is active
    // We can fetch this from `GET /api/config?diagnostics=true` if we implement it,
    // or just infer it here.
    // Let's implement a diagnostics endpoint.
    fetch('/api/diagnostics').then(r => r.text()).then(text => {
        diagnosticsOutput.textContent = text;
    }).catch(e => {
        diagnosticsOutput.textContent = 'Failed to load server diagnostics.';
    });
}

// Data Mapping & Clustering Logic
const runEvocBtn = document.getElementById('runEvocBtn');
const evocLogContainer = document.getElementById('evocLogContainer');
const evocLogOutput = document.getElementById('evocLogOutput');
const evocStatusText = document.getElementById('evocStatusText');

runEvocBtn.addEventListener('click', async () => {
    runEvocBtn.disabled = true;
    runEvocBtn.textContent = '⏳ Processing Data...';
    evocLogContainer.style.display = 'block';
    evocLogOutput.innerHTML = '<i>Initializing pipeline...</i><br>';
    evocStatusText.textContent = 'Starting Python EVoC + UMAP analysis...';

    try {
        const response = await fetch('/api/maintenance/run-evoc', { method: 'POST' });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const text = decoder.decode(value, { stream: true });
            const formatted = text.replace(/\n/g, '<br>').replace(/\[\*\]/g, '<span style="color: #0ff">[*]</span>');
            evocLogOutput.innerHTML += formatted;
            evocLogContainer.scrollTop = evocLogContainer.scrollHeight;
        }

        evocStatusText.textContent = 'Analysis complete! Check the Data Map.';
        runEvocBtn.innerHTML = '✅ Analysis Finished';
        setTimeout(() => {
            runEvocBtn.disabled = false;
            runEvocBtn.textContent = '🚀 Run Map Analysis (EVoC + UMAP)';
        }, 5000);

    } catch (e) {
        console.error(e);
        evocLogOutput.innerHTML += `<br><span style="color: #f00">Error: ${e.message}</span>`;
        evocStatusText.textContent = 'Pipeline failed. Check output for details.';
        runEvocBtn.disabled = false;
        runEvocBtn.textContent = '🚀 Retry Map Analysis';
    }
});
