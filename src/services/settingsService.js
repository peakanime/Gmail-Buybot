import { query } from '../db/index.js';

export async function getSetting(key, defaultValue = null) {
    const res = await query('SELECT value FROM settings WHERE key = $1', [key]);
    if (res.rows.length === 0) return defaultValue;
    return res.rows[0].value;
}

export async function setSetting(key, value) {
    await query(`
        INSERT INTO settings (key, value, updated_at) 
        VALUES ($1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT (key) DO UPDATE 
        SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
    `, [key, JSON.stringify(value)]);
}

export async function getAllSettings() {
    const res = await query('SELECT key, value FROM settings');
    const settings = {};
    for (const row of res.rows) {
        settings[row.key] = row.value;
    }
    return settings;
}