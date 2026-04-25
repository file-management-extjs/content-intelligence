const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const mime = require('mime');

const PORT = process.env.PORT || 4200;
const WORK_ROOT = process.env.CONTENT_INTELLIGENCE_WORK_ROOT || path.join(os.tmpdir(), 'content-intelligence');
const COMMAND_TIMEOUT_MS = parseInt(process.env.CONTENT_INTELLIGENCE_COMMAND_TIMEOUT_MS || `${8 * 60 * 1000}`, 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.CONTENT_INTELLIGENCE_REQUEST_TIMEOUT_MS || `${12 * 60 * 1000}`, 10);
const JSON_LIMIT = process.env.CONTENT_INTELLIGENCE_JSON_LIMIT || '160mb';

const app = express();
app.use(cors());
app.use(express.json({ limit: JSON_LIMIT }));

function normalizeWhitespace(value) {
    return String(value || '')
        .replace(/\r\n/g, '\n')
        .replace(/\u0000/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();
}

function truncate(value, maxLength) {
    const text = String(value || '');
    return text.length <= maxLength ? text : text.slice(0, maxLength);
}

function uniqueStrings(values, max = 20) {
    const seen = new Set();
    const result = [];

    (values || []).forEach(value => {
        const normalized = String(value || '').trim().replace(/\s+/g, ' ');
        if (!normalized) {
            return;
        }

        const key = normalized.toLowerCase();
        if (seen.has(key)) {
            return;
        }

        seen.add(key);
        result.push(normalized.slice(0, 80));
    });

    return result.slice(0, max);
}

function parseJsonObject(value) {
    const text = String(value || '').trim();
    if (!text) {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch (error) {
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) {
            return null;
        }

        try {
            return JSON.parse(match[0]);
        } catch (innerError) {
            return null;
        }
    }
}

function runCommand(command, args = [], options = {}) {
    return new Promise((resolve, reject) => {
        const timeoutMs = options.timeoutMs || COMMAND_TIMEOUT_MS;
        const child = spawn(command, args, {
            cwd: options.cwd || undefined,
            env: options.env || process.env,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        let finished = false;
        const maxBuffer = options.maxBuffer || (25 * 1024 * 1024);

        const timer = setTimeout(() => {
            if (finished) {
                return;
            }

            finished = true;
            child.kill('SIGKILL');
            reject(new Error(`${command} timed out.`));
        }, timeoutMs);

        child.stdout.on('data', chunk => {
            stdout += chunk.toString();
            if (stdout.length > maxBuffer) {
                child.kill('SIGKILL');
            }
        });

        child.stderr.on('data', chunk => {
            stderr += chunk.toString();
        });

        child.on('error', error => {
            if (finished) {
                return;
            }

            finished = true;
            clearTimeout(timer);
            reject(error);
        });

        child.on('close', code => {
            if (finished) {
                return;
            }

            finished = true;
            clearTimeout(timer);

            if (code !== 0) {
                reject(new Error(`${command} failed with code ${code}: ${stderr.slice(0, 500)}`));
                return;
            }

            resolve({ stdout, stderr });
        });
    });
}

function postRequest(urlString, { headers = {}, body = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const client = url.protocol === 'https:' ? https : http;
        const payload = Buffer.isBuffer(body)
            ? body
            : (body === null || body === undefined ? null : Buffer.from(String(body)));

        const request = client.request({
            method: 'POST',
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || undefined,
            path: `${url.pathname}${url.search}`,
            headers: {
                ...(payload ? { 'Content-Length': payload.length } : {}),
                ...headers
            },
            timeout: timeoutMs
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const responseBody = Buffer.concat(chunks).toString('utf8');
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    reject(new Error(`Provider request failed with HTTP ${response.statusCode}: ${responseBody.slice(0, 300)}`));
                    return;
                }

                resolve(responseBody);
            });
        });

        request.on('timeout', () => request.destroy(new Error('Provider request timed out.')));
        request.on('error', reject);

        if (payload) {
            request.write(payload);
        }

        request.end();
    });
}

function getFileCapability(file, settings) {
    const mimetype = String(file.mimetype || mime.getType(file.name || '') || '').toLowerCase();
    const ext = path.extname(file.name || '').toLowerCase();

    if (mimetype === 'application/pdf' || ext === '.pdf') {
        return { supported: true, category: 'pdf' };
    }

    if (mimetype.indexOf('image/') === 0 || /\.(bmp|gif|jpeg|jpg|png|tif|tiff|webp)$/i.test(file.name || '')) {
        return settings.ocr.enabled || settings.features.imageRecognition
            ? { supported: true, category: 'image' }
            : { supported: false, category: 'image', reason: 'OCR or image recognition must be enabled for images.' };
    }

    if (mimetype.indexOf('text/') === 0 ||
        ['application/json', 'application/xml', 'application/javascript', 'application/x-yaml'].includes(mimetype) ||
        /\.(txt|md|markdown|csv|json|xml|html|htm|log|yaml|yml)$/i.test(file.name || '')) {
        return { supported: true, category: 'text' };
    }

    if (/\.(doc|docx|odt|rtf|xls|xlsx|ods|ppt|pptx|odp)$/i.test(file.name || '') ||
        /word|excel|powerpoint|spreadsheet|presentation|opendocument|rtf/.test(mimetype)) {
        return { supported: true, category: 'office' };
    }

    return { supported: false, category: 'unknown', reason: 'Unsupported file type.' };
}

async function readTextFile(filePath, maxChars) {
    const stream = fs.createReadStream(filePath, {
        encoding: 'utf8',
        start: 0,
        end: Math.max(0, maxChars * 2)
    });
    let text = '';

    for await (const chunk of stream) {
        text += chunk;
        if (text.length >= maxChars) {
            break;
        }
    }

    return truncate(text, maxChars);
}

async function extractPdfText(filePath) {
    const result = await runCommand('pdftotext', ['-layout', '-enc', 'UTF-8', filePath, '-']);
    return result.stdout;
}

async function ocrImage(filePath, settings) {
    const remoteText = await remoteOcrImage(filePath, settings).catch(error => {
        console.error('Remote OCR failed, falling back to local Tesseract:', error.message);
        return '';
    });

    if (remoteText) {
        return remoteText;
    }

    const result = await runCommand('tesseract', [
        filePath,
        'stdout',
        '-l',
        settings.ocr.language || 'eng'
    ]);
    return result.stdout;
}

async function ocrPdf(filePath, settings, workDir) {
    const pagesDir = path.join(workDir, 'ocr-pages');
    await fs.ensureDir(pagesDir);
    const outputPrefix = path.join(pagesDir, 'page');
    await runCommand('pdftoppm', [
        '-f', '1',
        '-l', String(settings.limits.maxPages),
        '-r', String(settings.ocr.dpi),
        '-png',
        filePath,
        outputPrefix
    ]);

    const pageFiles = (await fs.readdir(pagesDir))
        .filter(name => /\.png$/i.test(name))
        .sort()
        .map(name => path.join(pagesDir, name));
    const textParts = [];

    for (const pageFile of pageFiles) {
        textParts.push(await ocrImage(pageFile, settings));
    }

    return textParts.join('\n\n');
}

async function extractOfficeText(filePath, workDir) {
    try {
        const result = await runCommand('pandoc', [filePath, '-t', 'plain']);
        const text = normalizeWhitespace(result.stdout);
        if (text) {
            return text;
        }
    } catch (error) {
        // LibreOffice is the broader fallback for binary Office formats.
    }

    const outputDir = path.join(workDir, 'office-text');
    await fs.ensureDir(outputDir);

    try {
        await runCommand('soffice', ['--headless', '--convert-to', 'txt:Text', '--outdir', outputDir, filePath]);
    } catch (error) {
        await runCommand('libreoffice', ['--headless', '--convert-to', 'txt:Text', '--outdir', outputDir, filePath]);
    }

    const outputs = (await fs.readdir(outputDir)).filter(name => /\.txt$/i.test(name));
    if (!outputs.length) {
        return '';
    }

    return fs.readFile(path.join(outputDir, outputs[0]), 'utf8');
}

async function extractContent(file, filePath, capability, settings, workDir) {
    if (capability.category === 'text') {
        return { text: await readTextFile(filePath, settings.limits.maxTextChars), method: 'text', ocrApplied: false };
    }

    if (capability.category === 'pdf') {
        const nativeText = await extractPdfText(filePath).catch(() => '');
        if (normalizeWhitespace(nativeText).length >= 40 || !settings.ocr.enabled) {
            return { text: nativeText, method: 'pdf-text', ocrApplied: false };
        }

        const ocrText = await ocrPdf(filePath, settings, workDir);
        return {
            text: normalizeWhitespace([nativeText, ocrText].filter(Boolean).join('\n\n')),
            method: nativeText ? 'pdf-text+ocr' : 'pdf-ocr',
            ocrApplied: true
        };
    }

    if (capability.category === 'image') {
        if (!settings.ocr.enabled) {
            return { text: '', method: 'image-metadata', ocrApplied: false };
        }

        return { text: await ocrImage(filePath, settings), method: 'image-ocr', ocrApplied: true };
    }

    if (capability.category === 'office') {
        return { text: await extractOfficeText(filePath, workDir), method: 'office-text', ocrApplied: false };
    }

    return { text: '', method: 'metadata', ocrApplied: false };
}

async function remoteOcrImage(filePath, settings) {
    const connection = {
        type: settings.ocr.provider || 'local',
        apiKey: settings.ocr.apiKey || settings.provider.apiKey || '',
        endpoint: settings.ocr.endpoint || '',
        model: settings.ocr.model || settings.provider.model || ''
    };
    const canUseRemote = connection.type === 'generic' ? !!connection.endpoint : !!connection.apiKey;

    if (connection.type === 'local' || !canUseRemote) {
        return '';
    }

    const image = {
        mimetype: mime.getType(filePath) || 'image/png',
        base64: (await fs.readFile(filePath)).toString('base64')
    };
    const prompt = `Extract all visible text from this image. Return only extracted text. Language hint: ${settings.ocr.language || 'eng'}.`;

    if (connection.type === 'openai') {
        const raw = await postRequest(connection.endpoint || 'https://api.openai.com/v1/chat/completions', {
            headers: { Authorization: `Bearer ${connection.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: connection.model || 'gpt-4o-mini',
                temperature: 0,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        { type: 'image_url', image_url: { url: `data:${image.mimetype};base64,${image.base64}` } }
                    ]
                }]
            })
        });
        const parsed = JSON.parse(raw);
        return parsed.choices && parsed.choices[0] && parsed.choices[0].message
            ? parsed.choices[0].message.content || ''
            : '';
    }

    if (connection.type === 'anthropic') {
        const raw = await postRequest(connection.endpoint || 'https://api.anthropic.com/v1/messages', {
            headers: {
                'x-api-key': connection.apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: connection.model || 'claude-3-5-haiku-latest',
                max_tokens: 1600,
                temperature: 0,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        { type: 'image', source: { type: 'base64', media_type: image.mimetype, data: image.base64 } }
                    ]
                }]
            })
        });
        const parsed = JSON.parse(raw);
        return (parsed.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    }

    if (connection.type === 'huggingface') {
        const endpoint = connection.endpoint || (connection.model ? `https://api-inference.huggingface.co/models/${connection.model}` : '');
        if (!endpoint) {
            return '';
        }

        const raw = await postRequest(endpoint, {
            headers: { Authorization: `Bearer ${connection.apiKey}`, 'Content-Type': image.mimetype },
            body: Buffer.from(image.base64, 'base64')
        });
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed)
            ? parsed.map(item => item.generated_text || item.text || item.label || '').filter(Boolean).join('\n')
            : (parsed.generated_text || parsed.text || '');
    }

    if (connection.type === 'generic') {
        const headers = { 'Content-Type': 'application/json' };
        if (connection.apiKey) {
            headers.Authorization = `Bearer ${connection.apiKey}`;
        }

        const raw = await postRequest(connection.endpoint, {
            headers,
            body: JSON.stringify({ task: 'ocr', language: settings.ocr.language || 'eng', image })
        });
        const parsed = parseJsonObject(raw) || JSON.parse(raw);
        return parsed.text || parsed.extractedText || parsed.ocrText || '';
    }

    return '';
}

function buildPrompt(file, text, capability, settings) {
    return [
        'Analyze this file for content intelligence.',
        'Return compact JSON only with keys: classification, tags, summary, language, entities.',
        `Enabled features: classification=${settings.features.classification}, tagging=${settings.features.tagging}, summarization=${settings.features.summarization}, imageRecognition=${settings.features.imageRecognition}.`,
        `File name: ${file.name}`,
        `MIME type: ${file.mimetype || ''}`,
        `Detected category: ${capability.category}`,
        text ? `Extracted text:\n${truncate(text, 16000)}` : 'Extracted text is empty. Use image content if available, otherwise metadata.'
    ].join('\n\n');
}

async function maybeImagePayload(file, filePath, capability) {
    if (capability.category !== 'image') {
        return null;
    }

    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats || stats.size > 8 * 1024 * 1024) {
        return null;
    }

    return {
        mimetype: file.mimetype || mime.getType(filePath) || 'image/png',
        base64: (await fs.readFile(filePath)).toString('base64')
    };
}

function normalizeAnalysis(analysis = {}, overrides = {}) {
    const safe = analysis && typeof analysis === 'object' && !Array.isArray(analysis) ? analysis : {};
    return {
        classification: String(safe.classification || safe.category || safe.documentType || 'Document').slice(0, 120),
        tags: uniqueStrings(safe.tags || safe.keywords || [], 20),
        summary: String(safe.summary || safe.description || '').slice(0, 1600),
        language: String(safe.language || '').slice(0, 40) || null,
        entities: uniqueStrings(safe.entities || safe.people || safe.organizations || [], 30),
        provider: overrides.provider || safe.provider || 'local',
        model: overrides.model || safe.model || '',
        imageRecognized: overrides.imageRecognized === true || safe.imageRecognized === true
    };
}

function analyzeLocally(file, text, capability) {
    const lowerName = String(file.name || '').toLowerCase();
    const lowerText = String(text || '').toLowerCase();
    const combined = `${lowerName} ${lowerText}`;
    let classification = 'Document';

    if (capability.category === 'image') {
        classification = text ? 'Scanned image' : 'Image';
    } else if (/\binvoice\b|\breceipt\b|\bamount due\b|\btax\b/.test(combined)) {
        classification = 'Invoice or receipt';
    } else if (/\bcontract\b|\bagreement\b|\bparty\b|\bterms\b/.test(combined)) {
        classification = 'Contract';
    } else if (/\breport\b|\banalysis\b|\bfindings\b|\bexecutive summary\b/.test(combined)) {
        classification = 'Report';
    } else if (/\bpresentation\b|\bslide\b|\bagenda\b/.test(combined)) {
        classification = 'Presentation';
    } else if (/\btable\b|\bcsv\b|\bworksheet\b|\bspreadsheet\b/.test(combined)) {
        classification = 'Spreadsheet';
    } else if (/\bresume\b|\bcv\b|\bexperience\b|\beducation\b/.test(combined)) {
        classification = 'Resume';
    }

    const stopWords = new Set(['about', 'after', 'again', 'also', 'and', 'are', 'been', 'before', 'between', 'could', 'document', 'from', 'have', 'into', 'more', 'other', 'over', 'that', 'the', 'their', 'there', 'these', 'this', 'with', 'would', 'your']);
    const counts = {};
    (String(text || '').toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || []).forEach(word => {
        if (!stopWords.has(word)) {
            counts[word] = (counts[word] || 0) + 1;
        }
    });
    const ranked = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 12);
    const clean = normalizeWhitespace(text);

    return {
        classification,
        tags: uniqueStrings([classification, capability.category, path.extname(file.name || '').replace('.', ''), ...ranked], 16),
        summary: clean
            ? truncate(clean.split(/(?<=[.!?])\s+/).slice(0, 3).join(' ') || clean, 700)
            : `No extractable text was found. The file was classified from metadata as ${capability.category}.`,
        language: /[\u0600-\u06ff]/.test(text) ? 'ar' : (/[\u0400-\u04ff]/.test(text) ? 'ru' : 'en'),
        entities: uniqueStrings(String(text || '').match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\b/g) || [], 20),
        provider: 'local',
        model: 'local-heuristics',
        imageRecognized: capability.category === 'image'
    };
}

async function analyzeContent(file, text, filePath, capability, settings) {
    const providerType = settings.provider.type || 'local';
    const prompt = buildPrompt(file, text, capability, settings);

    try {
        if (providerType === 'openai' && settings.provider.apiKey) {
            const image = settings.features.imageRecognition ? await maybeImagePayload(file, filePath, capability) : null;
            const raw = await postRequest(settings.provider.endpoint || 'https://api.openai.com/v1/chat/completions', {
                headers: { Authorization: `Bearer ${settings.provider.apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: settings.provider.model || 'gpt-4o-mini',
                    temperature: 0.2,
                    response_format: { type: 'json_object' },
                    messages: [
                        { role: 'system', content: 'You return valid JSON only.' },
                        {
                            role: 'user',
                            content: image
                                ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${image.mimetype};base64,${image.base64}` } }]
                                : prompt
                        }
                    ]
                })
            });
            const parsed = JSON.parse(raw);
            return normalizeAnalysis(parseJsonObject(parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content), {
                provider: 'openai',
                model: settings.provider.model || 'gpt-4o-mini',
                imageRecognized: !!image
            });
        }

        if (providerType === 'anthropic' && settings.provider.apiKey) {
            const image = settings.features.imageRecognition ? await maybeImagePayload(file, filePath, capability) : null;
            const raw = await postRequest(settings.provider.endpoint || 'https://api.anthropic.com/v1/messages', {
                headers: {
                    'x-api-key': settings.provider.apiKey,
                    'anthropic-version': '2023-06-01',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: settings.provider.model || 'claude-3-5-haiku-latest',
                    max_tokens: 800,
                    temperature: 0.2,
                    system: 'Return valid JSON only.',
                    messages: [{
                        role: 'user',
                        content: image
                            ? [{ type: 'text', text: prompt }, { type: 'image', source: { type: 'base64', media_type: image.mimetype, data: image.base64 } }]
                            : [{ type: 'text', text: prompt }]
                    }]
                })
            });
            const parsed = JSON.parse(raw);
            const textBlocks = (parsed.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
            return normalizeAnalysis(parseJsonObject(textBlocks), {
                provider: 'anthropic',
                model: settings.provider.model || 'claude-3-5-haiku-latest',
                imageRecognized: !!image
            });
        }

        if (providerType === 'huggingface' && settings.provider.apiKey) {
            const endpoint = settings.provider.endpoint || (settings.provider.model ? `https://api-inference.huggingface.co/models/${settings.provider.model}` : '');
            if (!endpoint) {
                throw new Error('A HuggingFace endpoint or model is required.');
            }

            const raw = await postRequest(endpoint, {
                headers: { Authorization: `Bearer ${settings.provider.apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ inputs: prompt })
            });
            const parsed = JSON.parse(raw);
            const generated = Array.isArray(parsed)
                ? (parsed[0] && (parsed[0].generated_text || parsed[0].summary_text || parsed[0].label))
                : (parsed.generated_text || parsed.summary_text || JSON.stringify(parsed));
            return normalizeAnalysis(parseJsonObject(generated) || { summary: generated }, {
                provider: 'huggingface',
                model: settings.provider.model || endpoint
            });
        }

        if (providerType === 'generic' && settings.provider.endpoint) {
            const headers = { 'Content-Type': 'application/json' };
            if (settings.provider.apiKey) {
                headers.Authorization = `Bearer ${settings.provider.apiKey}`;
            }
            const raw = await postRequest(settings.provider.endpoint, {
                headers,
                body: JSON.stringify({ prompt, task: 'content-intelligence', responseFormat: 'json' })
            });
            return normalizeAnalysis(parseJsonObject(raw) || JSON.parse(raw), {
                provider: 'generic',
                model: settings.provider.model || settings.provider.endpoint
            });
        }
    } catch (error) {
        const local = analyzeLocally(file, text, capability);
        local.summary = local.summary || `Provider analysis failed; local analysis was used. ${error.message || ''}`.trim();
        return local;
    }

    return analyzeLocally(file, text, capability);
}

function normalizeSettings(settings = {}) {
    const defaults = {
        provider: { type: 'local', model: '', endpoint: '', apiKey: '' },
        ocr: { enabled: true, provider: 'local', language: 'eng', dpi: 220, model: '', endpoint: '', apiKey: '' },
        features: { classification: true, tagging: true, summarization: true, imageRecognition: true },
        limits: { maxTextChars: 40000, maxFileSizeMb: 100, maxPages: 12 }
    };

    return {
        provider: { ...defaults.provider, ...(settings.provider || {}) },
        ocr: { ...defaults.ocr, ...(settings.ocr || {}) },
        features: { ...defaults.features, ...(settings.features || {}) },
        limits: { ...defaults.limits, ...(settings.limits || {}) }
    };
}

app.get('/health', (req, res) => {
    res.status(200).json({ success: true, service: 'content-intelligence' });
});

app.post('/api/content-intelligence/analyze', async (req, res) => {
    const settings = normalizeSettings(req.body.settings || {});
    const file = req.body.file || {};
    const capability = req.body.capability && req.body.capability.supported
        ? req.body.capability
        : getFileCapability(file, settings);
    const jobDir = path.join(WORK_ROOT, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

    if (!capability.supported) {
        res.status(400).json({ success: false, error: capability.reason || 'Unsupported file type.' });
        return;
    }

    try {
        await fs.ensureDir(jobDir);
        const safeName = path.basename(file.name || 'source.bin');
        const sourcePath = path.join(jobDir, safeName);
        await fs.writeFile(sourcePath, Buffer.from(String(file.base64 || ''), 'base64'));

        const extraction = await extractContent(file, sourcePath, capability, settings, jobDir);
        const searchableText = truncate(normalizeWhitespace(extraction.text), settings.limits.maxTextChars);
        const analysis = await analyzeContent(file, searchableText, sourcePath, capability, settings);

        res.status(200).json({
            success: true,
            extraction: {
                searchableText,
                textExcerpt: truncate(searchableText, 1200),
                textLength: searchableText.length,
                method: extraction.method,
                ocrApplied: extraction.ocrApplied === true
            },
            analysis
        });
    } catch (error) {
        console.error('Content intelligence service error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Content intelligence failed.'
        });
    } finally {
        await fs.remove(jobDir).catch(() => null);
    }
});

fs.ensureDir(WORK_ROOT).then(() => {
    app.listen(PORT, () => {
        console.log(`Content intelligence service listening on port ${PORT}`);
    });
});
