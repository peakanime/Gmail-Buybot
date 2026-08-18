import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import { pool } from './index.js';
import dotenv from 'dotenv';
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runMigrations() {
    console.log('🔄 Running database migrations and self-healing patches...');
    const schemaPath = path.join(__dirname, '../../sql/schema.sql');
    let sql = '';
    
    if (fs.existsSync(schemaPath)) {
        sql = fs.readFileSync(schemaPath, 'utf8');
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Execute Base Schema if available
        if (sql) {
            await client.query(sql);
        }

        // 2. Ensure Users table has profile collection and metadata columns
        await client.query(`
            ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number VARCHAR(50);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS language_code VARCHAR(10);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS user_metadata JSONB DEFAULT '{}'::jsonb;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS selling_restricted BOOLEAN DEFAULT FALSE;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS withdrawal_restricted BOOLEAN DEFAULT FALSE;
        `);

        // 3. Fix wallet_transactions check constraint to support all transaction and adjustment types
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

        // 4. Ensure Tasks table has submitted credentials columns
        await client.query(`
            ALTER TABLE tasks ADD COLUMN IF NOT EXISTS submitted_email VARCHAR(255);
            ALTER TABLE tasks ADD COLUMN IF NOT EXISTS submitted_password VARCHAR(255);
        `);

        // 5. Ensure Admin Task Pool table exists
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
            CREATE INDEX IF NOT EXISTS idx_pool_status ON admin_task_pool(status);
        `);

        // 6. Ensure default Superadmin account exists in admin_users
        const defaultUser = process.env.ADMIN_DEFAULT_USER || 'admin';
        const defaultPass = process.env.ADMIN_DEFAULT_PASS || 'AdminSecurePass2026!';
        const hash = await bcrypt.hash(defaultPass, 10);

        await client.query(`
            INSERT INTO admin_users (username, password_hash, role)
            VALUES ($1, $2, 'SUPERADMIN')
            ON CONFLICT (username) DO NOTHING
        `, [defaultUser, hash]);

        await client.query('COMMIT');
        console.log('✅ Migrations, self-healing patches, and user metadata columns successfully verified.');
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
