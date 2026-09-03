const { GoogleGenerativeAI } = require('@google/generative-ai');
const Busboy = require('busboy');

const SYSTEM_PROMPT = `
You are CropAI, an elite agricultural plant pathologist and agronomist AI.
Analyze the provided crop photograph quickly and accurately.

DIAGNOSTIC PROTOCOL:
1. Identify the crop species (e.g., Tomato, Potato, Rice, Wheat, Maize, Cotton, Apple, Grape, Pepper, Soybean, Banana, Citrus).
2. Check for foliar diseases (Early/Late Blight, Powdery/Downy Mildew, Rust, Leaf Spot, Anthracnose, Mosaic Virus, Chlorosis). If healthy, set disease.detected to false, disease.name to "Healthy Plant / No Disease Detected", and severity to "None".
3. Estimate percentage of visible foliage affected vs healthy (must total ~100%).
4. Provide safe, practical fertilizer suggestions.
5. Calibrate confidence realistically: 80-98% for clear photos, 65-79% for partial views (never return 0).

Return ONLY a valid, raw JSON object conforming strictly to this schema without markdown fences:
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

// Fast direct targets: Primary 2.5-flash with immediate 1.5-flash fallback
async function callGeminiFast(genAI, base64Data, mimeType) {
    const imagePart = { inlineData: { data: base64Data, mimeType } };
    const models = ['gemini-2.5-flash', 'gemini-1.5-flash'];

    for (const modelName of models) {
        try {
            const model = genAI.getGenerativeModel({
                model: modelName,
                generationConfig: {
                    responseMimeType: 'application/json',
                    temperature: 0.2
                }
            });
            const result = await model.generateContent([SYSTEM_PROMPT, imagePart]);
            return result.response.text();
        } catch (err) {
            console.warn(`Model ${modelName} failed (${err.message}). Trying quick backup...`);
        }
    }
    throw new Error('Analysis service is currently busy. Please try again.');
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return { statusCode: 500, body: JSON.stringify({ error: 'GEMINI_API_KEY is not configured in Netlify.' }) };
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
                    const rawText = await callGeminiFast(genAI, fileBuffer.toString('base64'), mimeType);
                    const parsedData = JSON.parse(rawText.replace(/```json\n?|\n?```/g, '').trim());

                    // Confidence & score sanitization
                    const cropConf = Math.max(parsedData.crop?.confidence || 75, 60);
                    const disConf = Math.max(parsedData.disease?.confidence || 70, 55);
                    const overallConf = Math.max(parsedData.overall_confidence || Math.round((cropConf + disConf) / 2), 65);

                    parsedData.crop.confidence = cropConf;
                    if (parsedData.disease) parsedData.disease.confidence = disConf;
                    parsedData.overall_confidence = overallConf;

                    // Area calculations
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
                        statusCode: 500,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ error: apiErr.message || 'AI service busy. Please try again.' })
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