require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configure Multer in-memory storage
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('INVALID_FILE_TYPE'));
        }
    }
});

const SYSTEM_PROMPT = `
You are CropAI, an elite agricultural plant pathologist and agronomist AI.
Analyze the provided crop image and respond with ONLY a valid, raw JSON object strictly conforming to this schema without markdown codeblocks or quotes:

{
  "analysis_status": "SUCCESS" | "INSUFFICIENT_IMAGE" | "UNKNOWN_CROP",
  "crop": {
    "name": "string",
    "confidence": number
  },
  "disease": {
    "detected": boolean,
    "name": "string",
    "confidence": number,
    "severity": "None" | "Low" | "Moderate" | "High" | "Severe" | "Unknown",
    "description": "string"
  },
  "affected_percentage": number,
  "healthy_percentage": number,
  "fertilizer": {
    "recommended": boolean,
    "reason": "string",
    "recommendations": [
      {
        "name": "string",
        "purpose": "string",
        "amount": "string",
        "unit": "string",
        "notes": "string"
      }
    ]
  },
  "evidence": ["string"],
  "precautions": ["string"],
  "recommended_actions": ["string"],
  "image_quality": "Excellent" | "Good" | "Fair" | "Poor",
  "overall_confidence": number,
  "needs_expert_confirmation": boolean
}

RULES:
1. If the plant is healthy, set disease.detected to false, disease.name to "Healthy / No Disease Detected", and severity to "None".
2. affected_percentage and healthy_percentage must be realistic estimates of visible foliage adding up to approximately 100%.
3. Do NOT fabricate exact chemical dosages. Return "Requires crop-specific/local recommendation" when exact dosage is not determinable.
4. If the photograph is not a plant or is unreadable, set analysis_status to "INSUFFICIENT_IMAGE".
`;

// Priority list: Latest 3.x series down to 2.5 Flash
const MODEL_CASCADES = [
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-2.5-flash'
];

async function generateWithModernFallback(genAI, imagePart) {
    let lastError = null;

    for (const modelName of MODEL_CASCADES) {
        try {
            console.log(`📡 Analyzing crop foliage using ${modelName}...`);
            const model = genAI.getGenerativeModel({
                model: modelName,
                generationConfig: {
                    responseMimeType: 'application/json'
                }
            });

            const result = await model.generateContent([SYSTEM_PROMPT, imagePart]);
            const text = result.response.text();
            console.log(`✅ Analysis successfully completed with ${modelName}`);
            return text;
        } catch (err) {
            console.warn(`⚠️ ${modelName} received (${err.status || err.message || '503/Busy'}). Falling back...`);
            lastError = err;
            // Brief pause before querying the next model tier
            await new Promise(res => setTimeout(res, 500));
        }
    }

    throw lastError || new Error('All model endpoints are currently experiencing high demand.');
}

app.post('/api/analyze', (req, res) => {
    upload.single('image')(req, res, async (err) => {
        if (err) {
            if (err.message === 'INVALID_FILE_TYPE') {
                return res.status(400).json({ error: 'Unsupported file format. Please upload JPG, PNG, or WEBP.' });
            }
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: 'Image exceeds the maximum allowed size of 10MB.' });
            }
            return res.status(400).json({ error: 'Image upload failed. Please try again.' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'No image file provided. Please select an image.' });
        }

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'GEMINI_API_KEY is not configured in .env' });
        }

        try {
            const genAI = new GoogleGenerativeAI(apiKey);
            const imagePart = {
                inlineData: {
                    data: req.file.buffer.toString('base64'),
                    mimeType: req.file.mimetype
                }
            };

            const rawResponse = await generateWithModernFallback(genAI, imagePart);

            // Clean out markdown wrappers if present
            const cleanedJson = rawResponse.replace(/```json\n?|\n?```/g, '').trim();
            const parsedData = JSON.parse(cleanedJson);

            // Parse optional total cultivated field area
            const totalArea = parseFloat(req.body.totalArea);
            const areaUnit = req.body.areaUnit || 'acres';

            const affectedPct = Math.min(100, Math.max(0, parsedData.affected_percentage || 0));
            const healthyPct = Math.min(100, Math.max(0, parsedData.healthy_percentage || (100 - affectedPct)));

            const areaCalculations = {
                user_provided: !isNaN(totalArea) && totalArea > 0,
                total_area: !isNaN(totalArea) && totalArea > 0 ? totalArea : null,
                unit: areaUnit,
                affected_percentage: affectedPct,
                healthy_percentage: healthyPct,
                estimated_affected_area: !isNaN(totalArea) && totalArea > 0 ? Number(((affectedPct / 100) * totalArea).toFixed(2)) : null,
                estimated_healthy_area: !isNaN(totalArea) && totalArea > 0 ? Number(((healthyPct / 100) * totalArea).toFixed(2)) : null
            };

            return res.status(200).json({
                ...parsedData,
                area: areaCalculations
            });
        } catch (apiError) {
            console.error('Diagnostic error:', apiError);
            return res.status(500).json({
                error: 'AI service temporarily unavailable due to high demand. Please retry in a few moments.'
            });
        }
    });
});

app.listen(PORT, () => {
    console.log(`🌾 CropAI server is running at http://localhost:${PORT}`);
});