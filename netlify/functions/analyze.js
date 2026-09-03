const { GoogleGenerativeAI } = require('@google/generative-ai');
const Busboy = require('busboy');

const SYSTEM_PROMPT = `
You are CropAI, an elite agricultural plant pathologist and agronomist AI.
Analyze the provided crop image and respond with ONLY a valid, raw JSON object matching the standard schema.
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
                generationConfig: { responseMimeType: 'application/json' }
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
        return { statusCode: 500, body: JSON.stringify({ error: 'GEMINI_API_KEY not configured.' }) };
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
                    return resolve({
                        statusCode: 503,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ error: 'AI servers under heavy demand. Please retry in a moment.' })
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