const API_BASE_URL = 'http://localhost:3000'; // Adjust if needed

const visionSelect = document.getElementById('visionModelSelect');
const embeddingSelect = document.getElementById('embeddingModelSelect');
const refreshBtn = document.getElementById('refreshModelsBtn');
const saveBtn = document.getElementById('saveConfigBtn');
const saveStatus = document.getElementById('saveStatus');
const diagnosticsOutput = document.getElementById('diagnosticsOutput');

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
        embeddingModel: embeddingSelect.value
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
            if (config.visionModel) visionSelect.value = config.visionModel;
            if (config.embeddingModel) embeddingSelect.value = config.embeddingModel;
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
