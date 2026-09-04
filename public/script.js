document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('analysisForm');
    const fileInput = document.getElementById('fileInput');
    const dropZone = document.getElementById('dropZone');
    const dropPrompt = document.getElementById('dropPrompt');
    const previewContainer = document.getElementById('previewContainer');
    const imagePreview = document.getElementById('imagePreview');
    const removeImgBtn = document.getElementById('removeImgBtn');
    const browseBtn = document.getElementById('browseBtn');
    const submitBtn = document.getElementById('submitBtn');

    const errorBox = document.getElementById('errorBox');
    const errorMessage = document.getElementById('errorMessage');

    const loadingCard = document.getElementById('loadingCard');
    const loadingStatus = document.getElementById('loadingStatus');
    const resultsDashboard = document.getElementById('resultsDashboard');
    const resetBtn = document.getElementById('resetBtn');

    let selectedFile = null;
    let loadingInterval = null;

    const loadingMessages = [
        'Analyzing crop image...',
        'Identifying crop species...',
        'Scanning for visible symptoms & pathogens...',
        'Estimating healthy vs affected foliage...',
        'Formulating agronomical recommendations...'
    ];

    browseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
    });

    dropZone.addEventListener('click', () => fileInput.click());

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.add('dragover');
        });
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('dragover');
        });
    });

    dropZone.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files.length > 0) handleFile(files[0]);
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) handleFile(e.target.files[0]);
    });

    removeImgBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearSelectedFile();
    });

    resetBtn.addEventListener('click', () => {
        clearSelectedFile();
        resultsDashboard.classList.add('hidden');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    function handleFile(file) {
        const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        if (!allowed.includes(file.type)) {
            showError('Please select a valid image file (JPG, PNG, or WEBP).');
            return;
        }

        hideError();
        selectedFile = file;

        const reader = new FileReader();
        reader.onload = (e) => {
            imagePreview.src = e.target.result;
            dropPrompt.classList.add('hidden');
            previewContainer.classList.remove('hidden');
        };
        reader.readAsDataURL(file);
    }

    function clearSelectedFile() {
        selectedFile = null;
        fileInput.value = '';
        imagePreview.src = '';
        dropPrompt.classList.remove('hidden');
        previewContainer.classList.add('hidden');
        hideError();
    }

    function showError(msg) {
        errorMessage.textContent = msg;
        errorBox.classList.remove('hidden');
    }

    function hideError() {
        errorBox.classList.add('hidden');
    }

    function startLoadingCycle() {
        loadingCard.classList.remove('hidden');
        submitBtn.disabled = true;
        let index = 0;
        loadingStatus.textContent = loadingMessages[0];

        loadingInterval = setInterval(() => {
            index = (index + 1) % loadingMessages.length;
            loadingStatus.textContent = loadingMessages[index];
        }, 1200);
    }

    function stopLoadingCycle() {
        clearInterval(loadingInterval);
        loadingCard.classList.add('hidden');
        submitBtn.disabled = false;
    }

    // Client-side downscaler: shrinks 5MB phone photos to crisp ~120KB in 20ms
    function compressImage(file, maxDimension = 1000, quality = 0.8) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = (event) => {
                const img = new Image();
                img.src = event.target.result;
                img.onload = () => {
                    let width = img.width;
                    let height = img.height;

                    if (width > height) {
                        if (width > maxDimension) {
                            height = Math.round((height * maxDimension) / width);
                            width = maxDimension;
                        }
                    } else {
                        if (height > maxDimension) {
                            width = Math.round((width * maxDimension) / height);
                            height = maxDimension;
                        }
                    }

                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);

                    canvas.toBlob(
                        (blob) => {
                            resolve(blob || file);
                        },
                        'image/jpeg',
                        quality
                    );
                };
            };
        });
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideError();

        if (!selectedFile) {
            showError('Please upload or select an image of a crop.');
            return;
        }

        resultsDashboard.classList.add('hidden');
        startLoadingCycle();

        try {
            // Compress image before network transfer
            const optimizedBlob = await compressImage(selectedFile);

            const formData = new FormData();
            formData.append('image', optimizedBlob, 'crop.jpg');

            const totalAreaVal = document.getElementById('totalArea').value.trim();
            const areaUnitVal = document.getElementById('areaUnit').value;

            if (totalAreaVal) {
                formData.append('totalArea', totalAreaVal);
                formData.append('areaUnit', areaUnitVal);
            }

            const response = await fetch('/api/analyze', {
                method: 'POST',
                body: formData
            });

            // Safe response parser (prevents '<HTML>' error when status is not 200)
            const contentType = response.headers.get('content-type') || '';
            let data;
            if (contentType.includes('application/json')) {
                data = await response.json();
            } else {
                const text = await response.text();
                if (response.status === 504) {
                    throw new Error('Analysis timed out on the server. Please try a clearer or smaller crop photo.');
                }
                throw new Error(`Server Error (${response.status}): ${text.slice(0, 100)}`);
            }

            if (!response.ok) {
                throw new Error(data.error || 'Server error occurred during crop analysis.');
            }

            renderResults(data);
            resultsDashboard.classList.remove('hidden');
            resultsDashboard.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (err) {
            showError(err.message || 'Network or analysis error occurred.');
        } finally {
            stopLoadingCycle();
        }
    });

    function renderResults(data) {
        document.getElementById('cropName').textContent = data.crop?.name || 'Unknown Crop';
        document.getElementById('cropConfidence').textContent = `${data.crop?.confidence || 0}% Confident`;

        const isDetected = data.disease?.detected;
        document.getElementById('diseaseName').textContent = isDetected ? (data.disease?.name || 'Infection Detected') : 'Healthy Crop';
        document.getElementById('diseaseSeverity').textContent = data.disease?.severity || 'None';
        document.getElementById('diseaseStatusDesc').textContent = data.disease?.description || 'No abnormal disease pattern detected.';

        const severityPill = document.getElementById('diseaseSeverity');
        if (!isDetected || data.disease?.severity === 'None') {
            severityPill.style.background = 'var(--primary-light)';
            severityPill.style.color = 'var(--primary)';
        } else {
            severityPill.style.background = 'var(--warning-light)';
            severityPill.style.color = 'var(--warning)';
        }

        document.getElementById('overallConfidence').textContent = `${data.overall_confidence || 0}%`;
        document.getElementById('imageQuality').textContent = `${data.image_quality || 'Good'} Quality`;
        document.getElementById('expertFlag').textContent = data.needs_expert_confirmation
            ? '⚠️ Expert Confirmation Recommended'
            : '✓ Standard AI Diagnostic Confidence';

        const affectedPct = Math.min(100, Math.max(0, data.area?.affected_percentage ?? data.affected_percentage ?? 0));
        const healthyPct = Math.min(100, Math.max(0, data.area?.healthy_percentage ?? data.healthy_percentage ?? 100));

        document.getElementById('affectedPctText').textContent = `${affectedPct}%`;
        document.getElementById('healthyPctText').textContent = `${healthyPct}%`;
        document.getElementById('affectedBar').style.width = `${affectedPct}%`;
        document.getElementById('healthyBar').style.width = `${healthyPct}%`;

        const areaContainer = document.getElementById('physicalAreaContainer');
        if (data.area?.user_provided && data.area?.total_area) {
            areaContainer.classList.remove('hidden');
            document.getElementById('totalCultivatedVal').textContent = `${data.area.total_area} ${data.area.unit}`;
            document.getElementById('estimatedAffectedVal').textContent = `${data.area.estimated_affected_area} ${data.area.unit}`;
            document.getElementById('estimatedHealthyVal').textContent = `${data.area.estimated_healthy_area} ${data.area.unit}`;
        } else {
            areaContainer.classList.add('hidden');
        }

        const evidenceList = document.getElementById('evidenceList');
        evidenceList.innerHTML = '';
        if (data.evidence && data.evidence.length > 0) {
            data.evidence.forEach(ev => {
                const li = document.createElement('li');
                li.textContent = ev;
                evidenceList.appendChild(li);
            });
        }

        const fertCards = document.getElementById('fertilizerCards');
        const fertPill = document.getElementById('fertStatusPill');
        const fertReasonText = document.getElementById('fertReasonText');
        fertCards.innerHTML = '';

        if (data.fertilizer?.recommended && data.fertilizer?.recommendations?.length > 0) {
            fertPill.textContent = 'Recommended';
            fertPill.style.background = 'var(--primary-light)';
            fertPill.style.color = 'var(--primary)';
            fertReasonText.textContent = data.fertilizer?.reason || 'Recommended fertilizers to support plant recovery:';

            data.fertilizer.recommendations.forEach(item => {
                const card = document.createElement('div');
                card.className = 'fert-card';
                card.innerHTML = `
            <h4 class="fert-card-title">${escapeHtml(item.name)}</h4>
            <p class="fert-card-item"><strong>Purpose:</strong> ${escapeHtml(item.purpose || 'Nutrient Support')}</p>
            <p class="fert-card-item"><strong>Application Rate:</strong> ${escapeHtml(item.amount || 'Follow local guidance')} ${item.unit ? `(${escapeHtml(item.unit)})` : ''}</p>
            <p class="fert-card-item"><strong>Notes:</strong> ${escapeHtml(item.notes || 'Apply according to soil tests and local guidance.')}</p>
          `;
                fertCards.appendChild(card);
            });
        } else {
            fertPill.textContent = 'Not Required';
            fertPill.style.background = 'var(--gray-100)';
            fertPill.style.color = 'var(--gray-700)';
            fertReasonText.textContent = data.fertilizer?.reason || 'No additional fertilizer is advised at this stage.';
        }

        const actionList = document.getElementById('actionList');
        actionList.innerHTML = '';
        if (data.recommended_actions && data.recommended_actions.length > 0) {
            data.recommended_actions.forEach(action => {
                const li = document.createElement('li');
                li.textContent = action;
                actionList.appendChild(li);
            });
        }

        const precautionList = document.getElementById('precautionList');
        precautionList.innerHTML = '';
        if (data.precautions && data.precautions.length > 0) {
            data.precautions.forEach(prec => {
                const li = document.createElement('li');
                li.textContent = prec;
                precautionList.appendChild(li);
            });
        }
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
});