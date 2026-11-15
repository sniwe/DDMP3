const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const { extractDecryptionDetails, streamToFfmpeg, buildEpsAudioPath } = require('./index');
const { sanitizeTitle } = require('./utils');

const app = express();
const port = Number.parseInt(process.env.LOCAL_PORT || '3001', 10);
const files = new Map();

function cleanUrl(value) {
    return String(value || '').trim().replace(/&amp;/g, '&');
}

function decodeEscapes(value) {
    return String(value || '')
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
        .replace(/\\\//g, '/');
}

function titleFromHtml(html) {
    const match = String(html || '').match(/"article_title":"([^"]+)"/);
    const raw = decodeEscapes(match ? match[1] : '');
    const ordinal = raw.match(/^(\d+)\s*[\-||::]?\s*(.*)$/s);
    return {
        ordinal: ordinal ? ordinal[1].trim() : '',
        title: ordinal ? (ordinal[2] || '').trim() : raw.trim(),
    };
}

async function readSharePage(url) {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    try {
        let m3u8Url = '';
        const page = await browser.newPage();
        page.on('response', response => {
            if (/\.m3u8(?:\?|$)/i.test(response.url()) && !m3u8Url) {
                m3u8Url = response.url();
            }
        });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        try {
            await page.waitForFunction(() => performance.getEntriesByType('resource').some(entry => /\.m3u8(?:\?|$)/i.test(entry.name)), { timeout: 45000 });
        } catch {}
        const html = await page.content();
        if (!m3u8Url) {
            const match = html.match(/"url":"(https:\\u002F\\u002F[^\"]+m3u8)"/);
            m3u8Url = decodeEscapes(match ? match[1] : '');
        }
        if (!m3u8Url) throw new Error('Browser could not locate an m3u8 URL.');
        return { m3u8Url, ...titleFromHtml(html) };
    } finally {
        await browser.close();
    }
}

function registerFile(filePath) {
    const id = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
    files.set(id, filePath);
    return id;
}

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'local-render' }));

app.get('/files/:id', (req, res) => {
    const filePath = files.get(req.params.id);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: 'File not found.' });
    res.type('audio/mpeg').sendFile(filePath);
});

app.get('/fetch', async (req, res) => {
    const url = cleanUrl(req.query.url);
    if (!url) return res.status(400).json({ ok: false, error: 'Missing url query parameter.' });
    let outputPath;
    try {
        const page = await readSharePage(url);
        const rawTitle = page.title ? `${page.ordinal} ${page.title}`.trim() : `LJSW${page.ordinal}`;
        const mediaTitle = sanitizeTitle(rawTitle) || 'dedao-audio';
        outputPath = buildEpsAudioPath(mediaTitle);
        const { key, iv, tsUrls } = await extractDecryptionDetails(page.m3u8Url);
        await streamToFfmpeg(tsUrls, key, iv, outputPath);
        const id = registerFile(outputPath);
        const baseUrl = String(process.env.LOCAL_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');
        return res.json({ ok: true, source: 'dedao', result: { mediaTitle, fileUrl: `${baseUrl}/files/${id}`, path: outputPath } });
    } catch (error) {
        if (outputPath) try { fs.rmSync(outputPath, { force: true }); } catch {}
        console.error('Local browser request failed:', error.message || error);
        return res.status(500).json({ ok: false, error: error.message || String(error) });
    }
});

app.listen(port, () => console.log(`Local browser service listening on port ${port}`));
