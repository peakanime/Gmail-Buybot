import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import { pool } from './index.js';
import dotenv from 'dotenv';
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runMigrations() {
    console.log('🔄 Running database migrations and schema patches...');
    const schemaPath = path.join(__dirname, '../../sql/schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Run main schema
        await client.query(sql);

        // 2. Self-Healing Patches for existing tables
        // Fix wallet_transactions check constraint to allow all adjustment types
        await client.query(`
            ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS wallet_transactions_type_check;
            ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_type_check CHECK (type IN (
                'ACCOUNT_PAYMENT', 
                'HOLD_CREATED', 
                'HOLD_RELEASED', 
                'WITHDRAWAL_RESERVATION', 
                'WITHDRAWAL_COMPLETED', 
                'WITHDRAWAL_REFUND', 
                'ADJUSTMENT',
                'ADJUSTMENT_ADD', 
                'ADJUSTMENT_DEDUCT', 
                'REFERRAL_REWARD'
            ));
        `);

        // Ensure missing columns exist in tasks
        await client.query(`
            ALTER TABLE tasks ADD COLUMN IF NOT EXISTS submitted_email VARCHAR(255);
            ALTER TABLE tasks ADD COLUMN IF NOT EXISTS submitted_password VARCHAR(255);
        `);

        // Ensure Admin Task Pool table exists
        await client.query(`
            CREATE TABLE IF NOT EXISTS admin_task_pool (
                id BIGSERIAL PRIMARY KEY,
                pool_id VARCHAR(64) UNIQUE NOT NULL,
                task_type VARCHAR(50) DEFAULT 'CREATE_NEW',
                first_name VARCHAR(100) NOT NULL,
                last_name VARCHAR(100) DEFAULT '✖️',
                email VARCHAR(255) NOT NULL,
                password_placeholder VARCHAR(255) NOT NULL,
                dob_year INT NOT NULL,
                reward_amount NUMERIC(15, 4) NOT NULL DEFAULT 0.23,
                status VARCHAR(50) DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'ASSIGNED', 'COMPLETED', 'DISABLED')),
                assigned_to_user_id BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL,
                assigned_task_id VARCHAR(64),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Create default superadmin if not exists
        const defaultUser = process.env.ADMIN_DEFAULT_USER || 'admin';
        const defaultPass = process.env.ADMIN_DEFAULT_PASS || 'AdminSecurePass2026!';
        const hash = await bcrypt.hash(defaultPass, 10);

        await client.query(`
            INSERT INTO admin_users (username, password_hash, role)
            VALUES ($1, $2, 'SUPERADMIN')
            ON CONFLICT (username) DO NOTHING
        `, [defaultUser, hash]);

        await client.query('COMMIT');
        console.log('✅ Migrations and self-healing patches executed successfully.');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Migration failed:', err);
        process.exit(1);
    } finally {
        client.release();
        process.exit(0);
    }
}

runMigrations();
