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
You are CropAI, a world-class agronomist and senior plant pathologist.
Analyze the provided crop/plant photograph using rigorous agronomical diagnostic standards.

### DIAGNOSTIC PROTOCOL:
1. CROP IDENTIFICATION:
   - Identify crop species by leaf venation, shape, phyllotaxy, margin, and texture (e.g., Tomato, Potato, Rice, Wheat, Maize/Corn, Cotton, Apple, Grape, Pepper/Chilli, Soybean, Banana, Citrus, Cucumber, etc.).
   - Calibrate crop confidence: 85-99% if clearly identifiable, 60-84% if partially obscured. Do NOT return 0 unless the image is not a plant.

2. PATHOLOGY & DISEASE DETECTION:
   - Carefully inspect for:
     * Fungal: Concentric rings (Early Blight), water-soaked lesions with white mold (Late Blight), white powdery coating (Powdery Mildew), rust-colored pustules (Rust), dark sunken lesions (Anthracnose).
     * Bacterial: Angular water-soaked spots with yellow halos (Bacterial Leaf Spot), vascular wilting.
     * Viral: Mosaic discoloration, leaf curling, mottling, stunting.
     * Nutrient Deficiencies: Interveinal chlorosis (Iron/Magnesium), uniform yellowing (Nitrogen), purple leaf tinting (Phosphorus), leaf edge burn (Potassium).
     * Pest Damage: Chewed leaf margins, stippling, mite webbing, leaf miners.
   - If the leaf is vigorous, green, and free of pathology:
     * disease.detected = false
     * disease.name = "Healthy Plant / No Disease Detected"
     * disease.severity = "None"
     * disease.description = "Foliage exhibits healthy coloration, intact vascular venation, and no visible signs of pathogen infection or nutrient distress."

3. SEVERITY & FOLIAGE AREA RATIO:
   - Estimate affected_percentage: Visible percentage of leaf surface exhibiting lesions, necrosis, chlorosis, or damage (0-100).
   - Estimate healthy_percentage: (100 - affected_percentage).
   - Set severity: "None" (0%), "Low" (1-15%), "Moderate" (16-40%), "High" (41-70%), "Severe" (71-100%).

4. FERTILIZER & SOIL NUTRITION:
   - If diseased or deficient, recommend safe corrective fertilizers (e.g., Foliar micronutrient spray, Balanced NPK 19-19-19, Potassium sulphate, Calcium nitrate).
   - Do NOT guess exact toxic chemical dosages. Specify standard agronomic guidelines (e.g., "Apply 2-3 g/L foliar spray during early morning or as per local extension service").

5. CONFIDENCE SCORING GUIDELINE:
   - Realistic calibration based on visual clarity (Never output 0% for recognizable photos):
     * Clear, in-focus leaf image: 80% – 98%
     * Slightly blurry or distant photo: 60% – 79%
     * Highly ambiguous / unidentifiable: 30% – 59%

Return ONLY a valid, raw JSON object conforming strictly to this schema:
{
  "analysis_status": "SUCCESS",
  "crop": {
    "name": "Crop Name",
    "confidence": 92
  },
  "disease": {
    "detected": true,
    "name": "Disease Name or Healthy Plant",
    "confidence": 88,
    "severity": "Low | Moderate | High | Severe | None",
    "description": "Detailed explanation of observed pathology"
  },
  "affected_percentage": 25,
  "healthy_percentage": 75,
  "fertilizer": {
    "recommended": true,
    "reason": "Agronomical reason for fertilizer guidance",
    "recommendations": [
      {
        "name": "Fertilizer Category/Name",
        "purpose": "Why this is recommended",
        "amount": "Recommended application rate/guideline",
        "unit": "g/L or kg/acre",
        "notes": "Application timing and precautions"
      }
    ]
  },
  "evidence": [
    "Specific observable symptom 1",
    "Specific observable symptom 2"
  ],
  "precautions": [
    "Cultural or chemical precaution 1",
    "Precaution 2"
  ],
  "recommended_actions": [
    "Immediate action 1",
    "Action 2"
  ],
  "image_quality": "Excellent | Good | Fair | Poor",
  "overall_confidence": 90,
  "needs_expert_confirmation": false
}
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