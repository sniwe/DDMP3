// utils.js
function sanitizeTitle(title) {
    if (!title) {
        return '';
    }

    const cleaned = title
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();

    // Windows disallows trailing dots/spaces in filenames.
    return cleaned.replace(/[. ]+$/g, '');
}

module.exports = { sanitizeTitle };
