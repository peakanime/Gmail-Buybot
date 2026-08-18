import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import { pool } from './index.js';
import dotenv from 'dotenv';
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runMigrations() {
    console.log('🔄 Running database migrations...');
    const schemaPath = path.join(__dirname, '../../sql/schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');

    try {
        await pool.query(sql);
        console.log('✅ Schema executed successfully.');

        // Initialize default admin user
        const defaultUser = process.env.ADMIN_DEFAULT_USER || 'admin';
        const defaultPass = process.env.ADMIN_DEFAULT_PASS || 'AdminSecurePass2026!';
        const hash = await bcrypt.hash(defaultPass, 10);

        await pool.query(`
            INSERT INTO admin_users (username, password_hash, role)
            VALUES ($1, $2, 'SUPERADMIN')
            ON CONFLICT (username) DO NOTHING
        `, [defaultUser, hash]);

        console.log(`✅ Default admin account checked (${defaultUser}).`);
        process.exit(0);
    } catch (err) {
        console.error('❌ Migration failed:', err);
        process.exit(1);
    }
}

runMigrations();