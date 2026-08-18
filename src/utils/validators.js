export function isValidEthereumAddress(address) {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export function isValidLitecoinAddress(address) {
    // Standard Legacy (L), SegWit (M), or Native Segwit (ltc1)
    return /^(L|M|ltc1)[a-km-zA-HJ-NP-Z1-9]{26,43}$/.test(address);
}

export function sanitizeInput(str) {
    if (!str) return '';
    return String(str).replace(/[<>]/g, '').trim();
}