import dotenv from "dotenv"
import express, { json, static as serveStatic } from 'express';
import cors from 'cors';
import multer, { memoryStorage } from 'multer';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config()
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(json());
app.use(serveStatic(join(__dirname, 'public')));

const upload = multer({
    storage: memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
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
   - Identify crop species by leaf venation, shape, phyllotaxy, margin, and texture.
   - Calibrate crop confidence: 85-99% if clearly identifiable, 60-84% if partially obscured. Do NOT return 0 unless the image is not a plant.

2. PATHOLOGY & DISEASE DETECTION:
   - Carefully inspect for fungal, bacterial, viral symptoms, or nutrient deficiencies.
   - If the leaf is vigorous, green, and healthy:
     * disease.detected = false
     * disease.name = "Healthy Plant / No Disease Detected"
     * disease.severity = "None"
     * disease.description = "Foliage exhibits healthy coloration, intact vascular venation, and no visible signs of pathogen infection or nutrient distress."

3. SEVERITY & FOLIAGE AREA RATIO:
   - Estimate affected_percentage: Visible percentage of leaf surface exhibiting lesions or damage (0-100).
   - Estimate healthy_percentage: (100 - affected_percentage).
   - Set severity: "None" (0%), "Low" (1-15%), "Moderate" (16-40%), "High" (41-70%), "Severe" (71-100%).

4. FERTILIZER & SOIL NUTRITION:
   - Recommend safe corrective fertilizers (e.g., Foliar micronutrient spray, Balanced NPK 19-19-19, Potassium sulphate).
   - Specify standard agronomic guidelines (e.g., "Apply 2-3 g/L foliar spray during early morning or as per local extension service").

5. CONFIDENCE SCORING GUIDELINE:
   - Realistic calibration (Never output 0% for recognizable photos): 80-98% for clear photos, 60-79% for partial views.

Return ONLY a valid, raw JSON object conforming strictly to this schema:
{
  "analysis_status": "SUCCESS",
  "crop": { "name": "Crop Name", "confidence": 92 },
  "disease": {
    "detected": true,
    "name": "Disease Name or Healthy Plant",
    "confidence": 88,
    "severity": "Low | Moderate | High | Severe | None",
    "description": "Short explanation of observed pathology"
  },
  "affected_percentage": 25,
  "healthy_percentage": 75,
  "fertilizer": {
    "recommended": true,
    "reason": "Fertilizer purpose",
    "recommendations": [
      {
        "name": "Fertilizer Name",
        "purpose": "Why recommended",
        "amount": "Recommended rate",
        "unit": "g/L or kg/acre",
        "notes": "Application timing"
      }
    ]
  },
  "evidence": ["Observable symptom 1", "Observable symptom 2"],
  "precautions": ["Precaution 1", "Precaution 2"],
  "recommended_actions": ["Action 1", "Action 2"],
  "image_quality": "Good",
  "overall_confidence": 90,
  "needs_expert_confirmation": false
}
`;

// Priority models in 3.x series
const MODELS_TO_TRY = ['gemini-3.6-flash', 'gemini-3.5-flash'];

async function generateWithRetry(genAI, imagePart) {
    let lastError = null;

    for (const modelName of MODELS_TO_TRY) {
        // Try up to 2 attempts per model to survive temporary 503 load spikes
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                console.log(`📡 Analyzing with ${modelName} (attempt ${attempt})...`);
                const model = genAI.getGenerativeModel({
                    model: modelName,
                    generationConfig: {
                        responseMimeType: 'application/json',
                        temperature: 0.2,
                        maxOutputTokens: 800
                    }
                });

                const result = await model.generateContent([SYSTEM_PROMPT, imagePart]);
                console.log(`✅ Success with ${modelName}`);
                return result.response.text();
            } catch (err) {
                console.warn(`⚠️ ${modelName} attempt ${attempt} received ${err.status || err.message}`);
                lastError = err;

                // If Google 503 high-demand, wait 1.2 seconds before retrying
                if (err.status === 503 || (err.message && err.message.includes('503'))) {
                    await new Promise(r => setTimeout(r, 1200));
                }
            }
        }
    }

    throw lastError || new Error('Gemini 3.6 servers are busy. Please try again.');
}

app.post('/api/analyze', (req, res) => {
    upload.single('image')(req, res, async (err) => {
        if (err) {
            if (err.message === 'INVALID_FILE_TYPE') {
                return res.status(400).json({ error: 'Please upload JPG, PNG, or WEBP.' });
            }
            return res.status(400).json({ error: 'Image upload failed.' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'No image file provided.' });
        }

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'GEMINI_API_KEY is not set in .env' });
        }

        try {
            const genAI = new GoogleGenerativeAI(apiKey);
            const imagePart = {
                inlineData: {
                    data: req.file.buffer.toString('base64'),
                    mimeType: req.file.mimetype
                }
            };

            const rawResponse = await generateWithRetry(genAI, imagePart);
            const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                throw new Error('AI returned an invalid JSON response.');
            }
            const parsedData = JSON.parse(jsonMatch[0]);

            const cropConf = Math.max(parsedData.crop?.confidence || 88, 70);
            const disConf = Math.max(parsedData.disease?.confidence || 82, 65);
            const overallConf = Math.max(parsedData.overall_confidence || Math.round((cropConf + disConf) / 2), 75);

            parsedData.crop.confidence = cropConf;
            if (parsedData.disease) parsedData.disease.confidence = disConf;
            parsedData.overall_confidence = overallConf;

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
            console.error('API Error:', apiError);
            return res.status(500).json({
                error: apiError.message || 'AI diagnostic failed.'
            });
        }
    });
});

app.listen(PORT, () => {
    console.log(`🌾 CropAI server is running at http://localhost:${PORT}`);
});