const { GoogleGenerativeAI } = require('@google/generative-ai');
const Busboy = require('busboy');

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

const MODEL_CASCADES = [
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-2.5-flash'
];

async function callModernGemini(genAI, base64Data, mimeType) {
    const imagePart = { inlineData: { data: base64Data, mimeType } };
    let lastErr = null;

    for (const model of MODEL_CASCADES) {
        try {
            const gModel = genAI.getGenerativeModel({
                model,
                generationConfig: {
                    responseMimeType: 'application/json',
                    temperature: 0.2 // Lower temperature for high medical/agronomic diagnostic precision
                }
            });
            const result = await gModel.generateContent([SYSTEM_PROMPT, imagePart]);
            return result.response.text();
        } catch (err) {
            lastErr = err;
            await new Promise(r => setTimeout(r, 400));
        }
    }
    throw lastErr;
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return { statusCode: 500, body: JSON.stringify({ error: 'GEMINI_API_KEY not configured in Netlify.' }) };
    }

    return new Promise((resolve) => {
        try {
            const busboy = Busboy({
                headers: { 'content-type': event.headers['content-type'] || event.headers['Content-Type'] },
                limits: { fileSize: 10 * 1024 * 1024 }
            });

            let fileBuffer = null;
            let mimeType = '';
            const fields = {};

            busboy.on('file', (fieldname, file, info) => {
                mimeType = info.mimeType;
                const chunks = [];
                file.on('data', d => chunks.push(d));
                file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
            });

            busboy.on('field', (name, val) => { fields[name] = val; });

            busboy.on('finish', async () => {
                if (!fileBuffer || fileBuffer.length === 0) {
                    return resolve({ statusCode: 400, body: JSON.stringify({ error: 'No image uploaded.' }) });
                }

                try {
                    const genAI = new GoogleGenerativeAI(apiKey);
                    const rawText = await callModernGemini(genAI, fileBuffer.toString('base64'), mimeType);
                    const parsedData = JSON.parse(rawText.replace(/```json\n?|\n?```/g, '').trim());

                    // Confidence & Ratio Sanitization
                    const cropConf = Math.max(parsedData.crop?.confidence || 75, 60);
                    const disConf = Math.max(parsedData.disease?.confidence || 70, 55);
                    const overallConf = Math.max(parsedData.overall_confidence || Math.round((cropConf + disConf) / 2), 65);

                    parsedData.crop.confidence = cropConf;
                    if (parsedData.disease) parsedData.disease.confidence = disConf;
                    parsedData.overall_confidence = overallConf;

                    // Area calculation
                    const totalArea = parseFloat(fields.totalArea);
                    const areaUnit = fields.areaUnit || 'acres';
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

                    return resolve({
                        statusCode: 200,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ...parsedData, area: areaCalculations })
                    });
                } catch (apiErr) {
                    console.error('Diagnostic error:', apiErr);
                    return resolve({
                        statusCode: 503,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ error: 'AI diagnostic service busy. Please try again with a clear photo.' })
                    });
                }
            });

            const bodyData = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body);
            busboy.write(bodyData);
            busboy.end();
        } catch (e) {
            resolve({ statusCode: 500, body: JSON.stringify({ error: 'Internal server error.' }) });
        }
    });
};