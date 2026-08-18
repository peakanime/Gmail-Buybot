/**
 * Validates and normalizes Ethereum/ERC-20 USDT wallet addresses.
 * Supports standard 42-character hex addresses (with or without '0x', case-insensitive).
 * Automatically trims whitespace and handles uppercase prefixes.
 */
export function normalizeAndValidateEthereum(address) {
    if (!address || typeof address !== 'string') return null;
    let clean = address.trim();

    // If user entered 40 hex characters without '0x', prepend it
    if (/^[a-fA-F0-9]{40}$/.test(clean)) {
        clean = '0x' + clean;
    }

    // Must start with 0x followed by exactly 40 hexadecimal characters
    if (/^0x[a-fA-F0-9]{40}$/i.test(clean)) {
        return clean;
    }
    return null;
}

/**
 * Validates and normalizes Litecoin (LTC) wallet addresses.
 * Supports:
 * - Legacy addresses (starts with 'L', 26-35 characters)
 * - P2SH / SegWit addresses (starts with 'M' or '3', 26-35 characters)
 * - Bech32 Native SegWit addresses (starts with 'ltc1' or 'LTC1', 40-58 characters)
 */
export function normalizeAndValidateLitecoin(address) {
    if (!address || typeof address !== 'string') return null;
    const clean = address.trim();

    // 1. Legacy (L) and P2SH (M or 3)
    const isLegacyOrP2SH = /^[LM3][a-km-zA-HJ-NP-Z1-9]{26,34}$/.test(clean);

    // 2. Bech32 Native SegWit (ltc1...)
    const isBech32 = /^ltc1[0-9a-z]{38,58}$/i.test(clean);

    if (isLegacyOrP2SH || isBech32) {
        return clean;
    }
    return null;
}

// Backward-compatible boolean helper functions
export function isValidEthereumAddress(address) {
    return normalizeAndValidateEthereum(address) !== null;
}

export function isValidLitecoinAddress(address) {
    return normalizeAndValidateLitecoin(address) !== null;
}

/**
 * Strips dangerous HTML tags from user inputs to prevent injection issues.
 */
export function sanitizeInput(str) {
    if (!str) return '';
    return String(str).replace(/[<>]/g, '').trim();
}
