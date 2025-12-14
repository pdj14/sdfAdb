/**
 * SDF ADB - Helper Utilities
 */

const crypto = require('crypto');

/**
 * Generate random ID with prefix
 */
function generateId(prefix = 'ID') {
    const random = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `${prefix}_${random}`;
}

/**
 * Parse address string (host:port)
 */
function parseAddress(addr) {
    const parts = addr.split(':');
    return {
        host: parts[0],
        port: parseInt(parts[1]) || 5555
    };
}

/**
 * Sleep for ms
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    generateId,
    parseAddress,
    sleep
};
