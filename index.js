const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const crypto = require('crypto');
const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ytdl = require('ytdl-core');
const { sanitizeTitle } = require('./utils');

const heldFiles = new Map();
const heldRootDir = path.join(os.tmpdir(), 'dedao2mp3-held');
const y2mateBaseUrl = 'https://v1.y2mate.nu/';
const y2mateUserAgent = 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Mobile Safari/537.36';
const epsDir = path.join(__dirname, 'eps');
const saveLocalEps = String(process.env.SAVE_LOCAL_EPS || '').trim() === '1';
const youtubeMode = String(process.env.YOUTUBE_MODE || 'y2mate').trim().toLowerCase();

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

function decodeBase64(value) {
    return Buffer.from(value, 'base64').toString('utf8');
}

function parseJsonIfNeeded(payload) {
    if (!payload) {
        return payload;
    }
    if (typeof payload === 'string') {
        try {
            return JSON.parse(payload);
        } catch (error) {
            return payload;
        }
    }
    return payload;
}

function isY2MateError(value) {
    if (value === undefined || value === null) {
        return false;
    }
    if (value === 0 || value === '0') {
        return false;
    }
    return true;
}

function isDedaoUrl(url) {
    return /dedao\.cn|igetget\.com/i.test(String(url || ''));
}

function isYouTubeUrl(url) {
    return /(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i.test(String(url || ''));
}

function detectSource(url) {
    if (isYouTubeUrl(url)) return 'youtube';
    if (isDedaoUrl(url)) return 'dedao';
    return 'other';
}

function extractYouTubeIdLoose(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    try {
        return ytdl.getURLVideoID(raw);
    } catch {
        // Fall back to basic regex match if ytdl rejects the URL.
        const match = raw.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
        return match ? match[1] : '';
    }
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

function ensureHeldRoot() {
    fs.mkdirSync(heldRootDir, { recursive: true });
    return heldRootDir;
}

function ensureEpsRoot() {
    fs.mkdirSync(epsDir, { recursive: true });
    return epsDir;
}

function buildHeldAudioPath(sanitizedTitle) {
    const safeTitle = sanitizedTitle || 'audio';
    const uniqueSuffix = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
    return path.join(ensureHeldRoot(), `${safeTitle}-${uniqueSuffix}.mp3`);
}

function buildEpsAudioPath(sanitizedTitle) {
    const safeTitle = sanitizedTitle || 'audio';
    const uniqueSuffix = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
    return path.join(ensureEpsRoot(), `${safeTitle}-${uniqueSuffix}.mp3`);
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

function resolveWixTitle(mediaTitle) {
    const forcedTitle = String(process.env.WIX_FORCE_TITLE || '').trim();
    return forcedTitle || mediaTitle;
}

async function checkWixForExisting(mediaTitle, wixEndpoint) {
    if (!wixEndpoint) {
        throw new Error('WIX_ENDPOINT is required.');
    }

    const response = await axiosInstance.get(wixEndpoint, {
        params: {
            mediaTitle: String(mediaTitle),
            checkOnly: '1',
        },
        headers: {
            Accept: '*/*',
            'User-Agent': 'Mozilla/5.0',
        },
        validateStatus: () => true,
    });

    if (response.status >= 400) {
        throw new Error(`Wix check failed (status ${response.status}): ${JSON.stringify(response.data)}`);
    }

    if (!response.data || response.data.ok !== true) {
        throw new Error(`Wix check failed: ${JSON.stringify(response.data)}`);
    }

    return response.data.exists === true;
}

async function run(url, wixEndpoint, publicBaseUrl) {
    const { m3u8Url, articleOrdinal, articleTitle } = await fetchSharePageData(url);

    const rawTitle = articleTitle
        ? `${articleOrdinal} ${articleTitle}`.trim()
        : `LJSW${articleOrdinal}`;
    const sanitizedTitle = sanitizeTitle(rawTitle);
    const wixTitle = resolveWixTitle(sanitizedTitle);
    const finalAudioPath = buildHeldAudioPath(sanitizedTitle);

    console.log(`M3U8 URL: ${m3u8Url}`);
    console.log(`Article ordinal: ${articleOrdinal}`);
    console.log(`Article title: ${articleTitle}`);
    console.log(`Temporary audio path: ${finalAudioPath}`);

    let uploadResult = null;
    let fileId = null;
    try {
        const exists = await checkWixForExisting(wixTitle, wixEndpoint);
        if (exists) {
            return { skipped: true, reason: 'exists', mediaTitle: wixTitle };
        }

        const { key, iv, tsUrls } = await extractDecryptionDetails(m3u8Url);
        await streamToFfmpeg(tsUrls, key, iv, finalAudioPath);
        if (!publicBaseUrl) {
            throw new Error('PUBLIC_BASE_URL is required to expose the mp3 file.');
        }
        fileId = registerHeldFile(finalAudioPath);
        const fileUrl = `${publicBaseUrl.replace(/\/+$/, '')}/files/${fileId}`;
        uploadResult = await uploadMp3UrlToWix(fileUrl, sanitizedTitle, wixEndpoint);
    } finally {
        // Let the TTL cleanup remove the held file later to avoid 404s for async fetches.
    }

    console.log('Process completed successfully.');
    return uploadResult;
}

function ensureYouTubeUrl(url) {
    if (!ytdl.validateURL(url)) {
        throw new Error('Invalid YouTube URL.');
    }
}

async function fetchYouTubeMetadata(url) {
    ensureYouTubeUrl(url);
    const info = await ytdl.getInfo(url);
    const title = info?.videoDetails?.title || 'youtube-audio';
    const channel = info?.videoDetails?.author?.name || '';
    return { title, channel, videoId: info?.videoDetails?.videoId || '' };
}

async function streamYouTubeToMp3(url, outputPath) {
    ensureYouTubeUrl(url);
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
            '-i', 'pipe:0',
            '-vn',
            '-acodec', 'libmp3lame',
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

        const audioStream = ytdl(url, {
            quality: 'highestaudio',
            filter: 'audioonly',
            highWaterMark: 1 << 25,
        });

        audioStream.on('error', (error) => {
            ffmpeg.stdin.destroy(error);
            reject(error);
        });

        audioStream.pipe(ffmpeg.stdin);
    });
}

async function runYouTube(url, wixEndpoint, publicBaseUrl) {
    let metaTitle = '';
    let channel = '';
    let usedFallback = false;
    let usedDirect = false;
    let usedY2Mate = false;
    try {
        const metadata = await fetchYouTubeMetadata(url);
        metaTitle = metadata.title;
        channel = metadata.channel;
    } catch (error) {
        console.warn('Direct YouTube metadata failed, will fallback to Y2Mate:', error.message || error);
        usedFallback = true;
    }

    const rawTitle = metaTitle || (channel ? `${channel} audio` : 'youtube-audio');
    let finalMediaTitle = sanitizeTitle(rawTitle);
    let wixTitle = resolveWixTitle(finalMediaTitle);
    const finalAudioPath = buildHeldAudioPath(finalMediaTitle);

    console.log(`YouTube title: ${metaTitle || '(unknown)'}`);
    console.log(`YouTube channel: ${channel || '(unknown)'}`);
    console.log(`Temporary audio path: ${finalAudioPath}`);

    let uploadResult = null;
    let fileId = null;
    try {
        const exists = await checkWixForExisting(wixTitle, wixEndpoint);
        if (exists) {
            return { skipped: true, reason: 'exists', mediaTitle: wixTitle };
        }

        const mode = youtubeMode || 'y2mate';
        const y2mateOnly = mode === 'y2mate-only';
        const directOnly = mode === 'direct';
        const tryY2MateFirst = !directOnly;
        console.log(`YouTube mode resolved: ${mode}`);

        if (tryY2MateFirst) {
            try {
                const videoId = extractYouTubeIdLoose(url);
                if (!videoId) {
                    throw new Error('Unable to extract YouTube video ID for Y2Mate.');
                }
                const fallbackResult = await resolveY2MateDownload(videoId);
                const fallbackTitle = fallbackResult.title || metaTitle || `youtube-${videoId}`;
                const fallbackSanitized = sanitizeTitle(fallbackTitle);
                const fallbackWixTitle = resolveWixTitle(fallbackSanitized);
                if (fallbackWixTitle !== wixTitle) {
                    const alreadyExists = await checkWixForExisting(fallbackWixTitle, wixEndpoint);
                    if (alreadyExists) {
                        return { skipped: true, reason: 'exists', mediaTitle: fallbackWixTitle };
                    }
                    wixTitle = fallbackWixTitle;
                    finalMediaTitle = fallbackSanitized;
                }
                await downloadY2MateMp3(fallbackResult.downloadUrl, videoId, finalAudioPath, fallbackResult.useProxy);
                usedY2Mate = true;
            } catch (error) {
                if (y2mateOnly) {
                    throw error;
                }
                console.warn('Y2Mate primary failed, switching to direct YouTube:', error.message || error);
                usedFallback = true;
            }
        }

        if (!usedY2Mate && !directOnly && !usedFallback) {
            usedFallback = true;
        }

        if (!usedY2Mate) {
            try {
                await streamYouTubeToMp3(url, finalAudioPath);
                usedDirect = true;
            } catch (error) {
                if (directOnly) {
                    throw error;
                }
                console.warn('Direct YouTube download failed:', error.message || error);
                usedFallback = true;
            }
        }

        if (usedFallback && !usedY2Mate) {
            const videoId = extractYouTubeIdLoose(url);
            if (!videoId) {
                throw new Error('Unable to extract YouTube video ID for Y2Mate fallback.');
            }
            const fallbackResult = await resolveY2MateDownload(videoId);
            const fallbackTitle = fallbackResult.title || metaTitle || `youtube-${videoId}`;
            const fallbackSanitized = sanitizeTitle(fallbackTitle);
            const fallbackWixTitle = resolveWixTitle(fallbackSanitized);
            if (fallbackWixTitle !== wixTitle) {
                const alreadyExists = await checkWixForExisting(fallbackWixTitle, wixEndpoint);
                if (alreadyExists) {
                    return { skipped: true, reason: 'exists', mediaTitle: fallbackWixTitle };
                }
                wixTitle = fallbackWixTitle;
                finalMediaTitle = fallbackSanitized;
            }
            await downloadY2MateMp3(fallbackResult.downloadUrl, videoId, finalAudioPath, fallbackResult.useProxy);
            usedY2Mate = true;
        }

        if (saveLocalEps) {
            try {
                const epsPath = buildEpsAudioPath(finalMediaTitle);
                fs.copyFileSync(finalAudioPath, epsPath);
                console.log(`Saved local copy to: ${epsPath}`);
            } catch (error) {
                console.warn('Failed to save local eps copy:', error.message || error);
            }
        }

        if (!publicBaseUrl) {
            throw new Error('PUBLIC_BASE_URL is required to expose the mp3 file.');
        }
        fileId = registerHeldFile(finalAudioPath);
        const fileUrl = `${publicBaseUrl.replace(/\/+$/, '')}/files/${fileId}`;
        uploadResult = await uploadMp3UrlToWix(fileUrl, finalMediaTitle, wixEndpoint);
    } finally {
        // Let the TTL cleanup remove the held file later to avoid 404s for async fetches.
    }

    const modeNote = usedY2Mate ? 'Y2Mate' : (usedDirect ? 'Direct' : 'Unknown');
    console.log(`YouTube process completed successfully. mode=${modeNote}${usedFallback ? ' fallback=1' : ''}`);
    return {
        ...(uploadResult || {}),
        mediaTitle: wixTitle,
    };
}

function extractYouTubeId(url) {
    ensureYouTubeUrl(url);
    return ytdl.getURLVideoID(url);
}

async function fetchY2MateConfig() {
    const response = await axiosInstance.get(y2mateBaseUrl, {
        headers: {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'User-Agent': y2mateUserAgent,
        },
    });
    const html = String(response.data || '');
    const match = html.match(/var json = JSON\.parse\('([^']+)'\)/);
    if (!match) {
        throw new Error('Unable to locate Y2Mate config payload.');
    }
    try {
        console.log('Y2Mate config payload loaded.');
        return JSON.parse(match[1]);
    } catch (error) {
        throw new Error('Failed to parse Y2Mate config payload.');
    }
}

function computeY2MateAuthorization(config) {
    let token = '';
    for (let i = 0; i < config[0].length; i += 1) {
        const offset = config[2][config[2].length - (i + 1)];
        token += String.fromCharCode(config[0][i] - offset);
    }
    if (config[1]) {
        token = token.split('').reverse().join('');
    }
    return token.length > 32 ? token.substring(0, 32) : token;
}

function y2MateEndpoint(pathKey, targetUrl) {
    const match = /\/\/([a-z]{6})\./.exec(targetUrl);
    if (!match) {
        throw new Error('Unable to derive Y2Mate endpoint proxy.');
    }
    const query = targetUrl.split('?')[1] || '';
    return `${y2mateBaseUrl.replace(/\/+$/, '')}/~${pathKey}/${match[1]}/?${query}`;
}

async function y2MateInit(config) {
    const auth = computeY2MateAuthorization(config);
    const host = decodeBase64('ZXRhY2xvdWQub3Jn');
    const paramName = String.fromCharCode(config[6]);
    const timestamp = Math.floor(Date.now() / 1000);
    const directUrl = `https://eta.${host}/api/v1/init?${paramName}=${encodeURIComponent(auth)}&t=${timestamp}`;
    console.log('Y2Mate init (direct) request:', directUrl);
    const response = await axiosInstance.get(directUrl, {
        headers: {
            Accept: '*/*',
            Origin: y2mateBaseUrl.replace(/\/+$/, ''),
            Referer: y2mateBaseUrl,
            'User-Agent': y2mateUserAgent,
        },
        validateStatus: () => true,
    });
    const directData = parseJsonIfNeeded(response.data);
    if (response.status === 200 && directData && !isY2MateError(directData.error) && directData.convertURL) {
        console.log('Y2Mate init (direct) success.');
        return { convertUrl: directData.convertURL, useProxy: false };
    }

    const proxyUrl = `${y2mateBaseUrl.replace(/\/+$/, '')}/~i/?${paramName}=${encodeURIComponent(auth)}&t=${timestamp}`;
    console.log('Y2Mate init (proxy) request:', proxyUrl);
    const proxyResponse = await axiosInstance.get(proxyUrl, {
        headers: {
            Accept: '*/*',
            Origin: y2mateBaseUrl.replace(/\/+$/, ''),
            Referer: y2mateBaseUrl,
            'User-Agent': y2mateUserAgent,
        },
        validateStatus: () => true,
    });
    const proxyData = parseJsonIfNeeded(proxyResponse.data);
    if (proxyResponse.status !== 200 || !proxyData || isY2MateError(proxyData.error) || !proxyData.convertURL) {
        throw new Error(`Y2Mate init failed: ${JSON.stringify(proxyData || directData)}`);
    }
    console.log('Y2Mate init (proxy) success.');
    return { convertUrl: proxyData.convertURL, useProxy: true };
}

async function y2MateConvert(convertUrl, videoId, format, useProxy) {
    const baseUrl = useProxy ? y2MateEndpoint('c', convertUrl) : convertUrl;
    const url = `${baseUrl}&v=${encodeURIComponent(videoId)}&f=${encodeURIComponent(format)}&t=${Math.floor(Date.now() / 1000)}`;
    console.log('Y2Mate convert request:', url);
    const response = await axiosInstance.get(url, {
        headers: {
            Accept: '*/*',
            Origin: y2mateBaseUrl.replace(/\/+$/, ''),
            Referer: y2mateBaseUrl,
            'User-Agent': y2mateUserAgent,
        },
    });
    const data = parseJsonIfNeeded(response.data);
    if (!data) {
        throw new Error('Y2Mate convert returned empty response.');
    }
    if (typeof data === 'string') {
        throw new Error('Y2Mate convert returned non-JSON response.');
    }
    if (isY2MateError(data.error)) {
        throw new Error(`Y2Mate convert failed: ${JSON.stringify(data)}`);
    }
    if (data.redirect === 1 && data.redirectURL) {
        console.log('Y2Mate convert redirecting.');
        return y2MateConvert(data.redirectURL, videoId, format, useProxy);
    }
    console.log('Y2Mate convert response:', {
        hasProgressUrl: !!data.progressURL,
        hasDownloadUrl: !!data.downloadURL,
        progress: data.progress,
        title: data.title || '',
    });
    return data;
}

async function y2MateProgress(progressUrl, useProxy) {
    const baseUrl = useProxy ? y2MateEndpoint('p', progressUrl) : progressUrl;
    const url = `${baseUrl}&t=${Math.floor(Date.now() / 1000)}`;
    console.log('Y2Mate progress request:', url);
    const response = await axiosInstance.get(url, {
        headers: {
            Accept: '*/*',
            Origin: y2mateBaseUrl.replace(/\/+$/, ''),
            Referer: y2mateBaseUrl,
            'User-Agent': y2mateUserAgent,
        },
    });
    const data = parseJsonIfNeeded(response.data);
    if (typeof data === 'string') {
        throw new Error('Y2Mate progress returned non-JSON response.');
    }
    console.log('Y2Mate progress response:', {
        progress: data?.progress,
        hasDownloadUrl: !!data?.downloadURL,
        title: data?.title || '',
    });
    return data;
}

async function resolveY2MateDownload(videoId) {
    const config = await fetchY2MateConfig();
    const initResult = await y2MateInit(config);
    const convertResult = await y2MateConvert(initResult.convertUrl, videoId, 'mp3', initResult.useProxy);
    if (config[3] === 1 && convertResult.downloadURL && convertResult.title) {
        console.log('Y2Mate conversion completed immediately.');
        return {
            downloadUrl: convertResult.downloadURL,
            title: convertResult.title,
            useProxy: initResult.useProxy,
        };
    }
    let progressUrl = convertResult.progressURL;
    let downloadUrl = convertResult.downloadURL;
    let title = convertResult.title || '';
    let progress = convertResult.progress || 0;
    const maxAttempts = 40;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (downloadUrl && progress >= 3) {
            break;
        }
        if (!progressUrl) {
            break;
        }
        await new Promise(res => setTimeout(res, 3000));
        const progressResult = await y2MateProgress(progressUrl, initResult.useProxy);
        if (isY2MateError(progressResult?.error)) {
            throw new Error(`Y2Mate progress failed: ${JSON.stringify(progressResult)}`);
        }
        progress = progressResult?.progress ?? progress;
        if (progressResult?.title && !title) {
            title = progressResult.title;
        }
        if (progressResult?.downloadURL) {
            downloadUrl = progressResult.downloadURL;
        }
    }
    if (!downloadUrl) {
        throw new Error('Y2Mate did not return a download URL.');
    }
    console.log('Y2Mate conversion completed after progress polling.');
    return { downloadUrl, title, useProxy: initResult.useProxy };
}

async function downloadY2MateMp3(downloadUrl, videoId, outputPath, useProxy) {
    const baseUrl = useProxy ? y2MateEndpoint('d', downloadUrl) : downloadUrl;
    const finalUrl = `${baseUrl}&s=3&v=${encodeURIComponent(videoId)}&f=mp3`;
    console.log('Y2Mate download request:', finalUrl);
    const response = await axiosInstance.get(finalUrl, {
        responseType: 'stream',
        headers: {
            Accept: '*/*',
            Origin: y2mateBaseUrl.replace(/\/+$/, ''),
            Referer: y2mateBaseUrl,
            'User-Agent': y2mateUserAgent,
        },
    });
    await new Promise((resolve, reject) => {
        const stream = fs.createWriteStream(outputPath);
        response.data.pipe(stream);
        response.data.on('error', reject);
        stream.on('finish', resolve);
        stream.on('error', reject);
    });
}

async function uploadMp3UrlToWix(fileUrl, mediaTitle, wixEndpoint) {
    if (!wixEndpoint) {
        throw new Error('WIX_ENDPOINT is required.');
    }

    const finalTitle = resolveWixTitle(mediaTitle);

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
    const sourceParam = String(req.query.source || '').trim().toLowerCase();
    const wixEndpoint = String(process.env.WIX_ENDPOINT || '').trim();
    const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || '').trim();

    if (!url) {
        return res.status(400).json({ ok: false, error: 'Missing url query parameter.' });
    }

    if (!wixEndpoint) {
        return res.status(500).json({ ok: false, error: 'WIX_ENDPOINT is not configured.' });
    }

    try {
        const source = sourceParam || detectSource(url);
        if (source === 'youtube') {
            const uploadResult = await runYouTube(url, wixEndpoint, publicBaseUrl);
            return res.json({ ok: true, result: uploadResult, source });
        }
        if (source === 'dedao') {
            const uploadResult = await run(url, wixEndpoint, publicBaseUrl);
            return res.json({ ok: true, result: uploadResult, source });
        }
        return res.status(400).json({ ok: false, error: 'Unsupported URL.', source: 'other' });
    } catch (error) {
        console.error('Request failed:', error.message || error);
        return res.status(500).json({ ok: false, error: error.message || String(error) });
    }
});

app.get('/fetch-youtube', async (req, res) => {
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
        const uploadResult = await runYouTube(url, wixEndpoint, publicBaseUrl);
        return res.json({ ok: true, result: uploadResult, source: 'youtube' });
    } catch (error) {
        console.error('YouTube request failed:', error.message || error);
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
