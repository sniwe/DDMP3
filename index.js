const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const crypto = require('crypto');
const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { sanitizeTitle } = require('./utils');

const heldFiles = new Map();

const axiosInstance = axios.create({
    timeout: 30000,
    headers: { 'User-Agent': 'CustomUserAgent/1.0' },
});

axiosRetry(axiosInstance, {
    retries: 3,
    retryDelay: (retryCount) => retryCount * 1000,
    retryCondition: (error) => error.code === 'ETIMEDOUT' || error.response?.status >= 500,
});

function decodeEscapes(text) {
    if (!text) {
        return '';
    }
    return text
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
        .replace(/\\\//g, '/');
}

async function fetchSharePageData(url) {
    const response = await axiosInstance.get(url);
    const html = response.data;

    const titleMatch = html.match(/"article_title":"([^"]+)"/);
    const rawTitle = decodeEscapes(titleMatch ? titleMatch[1] : '');

    const ordinalMatch = rawTitle.match(/^(\d+)\s*[\-||::]?\s*(.*)$/s);
    const articleOrdinal = ordinalMatch ? ordinalMatch[1].trim() : '';
    const articleTitle = ordinalMatch ? (ordinalMatch[2] || '').trim() : rawTitle.trim();

    const m3u8Match = html.match(/"url":"(https:\\u002F\\u002F[^\"]+m3u8)"/);
    const m3u8Url = decodeEscapes(m3u8Match ? m3u8Match[1] : '');

    if (!m3u8Url) {
        throw new Error('Unable to locate m3u8 URL in share page.');
    }

    return { m3u8Url, articleOrdinal, articleTitle };
}

function decryptTsFile(encryptedContent, key, iv) {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([decipher.update(encryptedContent), decipher.final()]);
}

async function extractDecryptionDetails(m3u8Url) {
    const m3u8Response = await axiosInstance.get(m3u8Url);
    const m3u8Content = m3u8Response.data;
    const lines = m3u8Content.split('\n');
    const keyLine = lines.find(line => line.startsWith('#EXT-X-KEY'));

    const uriMatch = /URI="([^"]+)"/.exec(keyLine || '');
    const ivMatch = /IV=0x([0-9a-fA-F]+)/.exec(keyLine || '');

    if (!uriMatch) {
        throw new Error('Decryption key URI not found in M3U8 file.');
    }

    const keyUrl = new URL(uriMatch[1], m3u8Url).href;
    const keyResponse = await axiosInstance.get(keyUrl, { responseType: 'arraybuffer' });
    const iv = ivMatch ? Buffer.from(ivMatch[1], 'hex') : Buffer.alloc(16, 0);

    return {
        key: keyResponse.data,
        iv,
        tsUrls: lines
            .filter(line => line.trim().endsWith('.ts'))
            .map(line => (line.startsWith('http') ? line : new URL(line, m3u8Url).href)),
    };
}

async function streamToFfmpeg(tsUrls, key, iv, outputPath) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
            '-f', 'mpegts',
            '-i', 'pipe:0',
            '-af', 'atempo=1.15',
            '-f', 'mp3',
            outputPath,
            '-y',
        ], { stdio: ['pipe', 'inherit', 'inherit'] });

        ffmpeg.on('error', reject);
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`ffmpeg exited with code ${code}`));
            }
        });

        (async () => {
            try {
                for (const tsUrl of tsUrls) {
                    const response = await axiosInstance.get(tsUrl, { responseType: 'arraybuffer' });
                    const decrypted = decryptTsFile(response.data, key, iv);
                    if (!ffmpeg.stdin.write(decrypted)) {
                        await new Promise(res => ffmpeg.stdin.once('drain', res));
                    }
                }
                ffmpeg.stdin.end();
            } catch (error) {
                ffmpeg.stdin.destroy(error);
                reject(error);
            }
        })();
    });
}

function registerHeldFile(filePath) {
    const id = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
    const timeout = setTimeout(() => {
        const entry = heldFiles.get(id);
        if (entry) {
            try {
                fs.rmSync(entry.filePath, { force: true });
            } catch (error) {
                console.warn(`Failed to remove expired file ${entry.filePath}:`, error.message || error);
            }
            heldFiles.delete(id);
        }
    }, 30 * 60 * 1000);
    heldFiles.set(id, { filePath, timeout });
    return id;
}

function removeHeldFile(id) {
    const entry = heldFiles.get(id);
    if (!entry) {
        return;
    }
    clearTimeout(entry.timeout);
    try {
        fs.rmSync(entry.filePath, { force: true });
    } catch (error) {
        console.warn(`Failed to remove file ${entry.filePath}:`, error.message || error);
    }
    heldFiles.delete(id);
}

async function run(url, wixEndpoint, publicBaseUrl) {
    const { m3u8Url, articleOrdinal, articleTitle } = await fetchSharePageData(url);

    const rawTitle = articleTitle
        ? `${articleOrdinal} ${articleTitle}`.trim()
        : `LJSW${articleOrdinal}`;
    const sanitizedTitle = sanitizeTitle(rawTitle);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedao2mp3-'));
    const finalAudioPath = path.join(tempDir, `${sanitizedTitle}.mp3`);

    console.log(`M3U8 URL: ${m3u8Url}`);
    console.log(`Article ordinal: ${articleOrdinal}`);
    console.log(`Article title: ${articleTitle}`);
    console.log(`Temporary audio path: ${finalAudioPath}`);

    let uploadResult = null;
    let fileId = null;
    try {
        const { key, iv, tsUrls } = await extractDecryptionDetails(m3u8Url);
        await streamToFfmpeg(tsUrls, key, iv, finalAudioPath);
        if (!publicBaseUrl) {
            throw new Error('PUBLIC_BASE_URL is required to expose the mp3 file.');
        }
        fileId = registerHeldFile(finalAudioPath);
        const fileUrl = `${publicBaseUrl.replace(/\/+$/, '')}/files/${fileId}`;
        uploadResult = await uploadMp3UrlToWix(fileUrl, sanitizedTitle, wixEndpoint);
    } finally {
        if (fileId) {
            removeHeldFile(fileId);
        }
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (error) {
            console.warn(`Failed to clean temp directory ${tempDir}:`, error.message || error);
        }
    }

    console.log('Process completed successfully.');
    return uploadResult;
}

async function uploadMp3UrlToWix(fileUrl, mediaTitle, wixEndpoint) {
    if (!wixEndpoint) {
        throw new Error('WIX_ENDPOINT is required.');
    }

    const forcedTitle = String(process.env.WIX_FORCE_TITLE || '').trim();
    const finalTitle = forcedTitle || mediaTitle;

    const params = {
        fileUrl,
        mediaTitle: String(finalTitle),
    };

    const response = await axiosInstance.get(wixEndpoint, {
        params,
        headers: {
            Accept: '*/*',
            'User-Agent': 'Mozilla/5.0',
        },
        validateStatus: () => true,
    });

    if (response.status >= 400) {
        throw new Error(`Wix upload failed (status ${response.status}): ${JSON.stringify(response.data)}`);
    }
    if (!response.data || response.data.ok !== true) {
        throw new Error(`Wix upload failed: ${JSON.stringify(response.data)}`);
    }

    return response.data;
}

const app = express();
const port = Number.parseInt(process.env.PORT || '3000', 10);

app.get('/fetch', async (req, res) => {
    const url = String(req.query.url || '').trim();
    const wixEndpoint = String(process.env.WIX_ENDPOINT || '').trim();
    const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || '').trim();

    if (!url) {
        return res.status(400).json({ ok: false, error: 'Missing url query parameter.' });
    }

    if (!wixEndpoint) {
        return res.status(500).json({ ok: false, error: 'WIX_ENDPOINT is not configured.' });
    }

    try {
        const uploadResult = await run(url, wixEndpoint, publicBaseUrl);
        return res.json({ ok: true, result: uploadResult });
    } catch (error) {
        console.error('Request failed:', error.message || error);
        return res.status(500).json({ ok: false, error: error.message || String(error) });
    }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/files/:id', (req, res) => {
    const id = String(req.params.id || '').trim();
    const entry = heldFiles.get(id);
    if (!entry) {
        return res.status(404).json({ ok: false, error: 'File not found.' });
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    const stream = fs.createReadStream(entry.filePath);
    stream.on('error', (error) => {
        console.error('Failed to stream file:', error.message || error);
        res.status(500).end();
    });
    stream.pipe(res);
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
