-- PostgreSQL Production Schema for Velrix Platform

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. USERS
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    telegram_id BIGINT UNIQUE NOT NULL,
    username VARCHAR(255),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    account_status VARCHAR(50) DEFAULT 'ACTIVE' CHECK (account_status IN ('ACTIVE', 'RESTRICTED', 'SUSPENDED', 'BANNED')),
    selling_restricted BOOLEAN DEFAULT FALSE,
    withdrawal_restricted BOOLEAN DEFAULT FALSE,
    referrer_id BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_referrer_id ON users(referrer_id);

-- 2. ADMIN USERS (Web Panel)
CREATE TABLE IF NOT EXISTS admin_users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'ADMIN' CHECK (role IN ('SUPERADMIN', 'ADMIN', 'REVIEWER')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. WALLETS (Financial State Engine)
CREATE TABLE IF NOT EXISTS wallets (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT UNIQUE NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    available_balance NUMERIC(15, 4) DEFAULT 0.0000 CHECK (available_balance >= 0),
    hold_balance NUMERIC(15, 4) DEFAULT 0.0000 CHECK (hold_balance >= 0),
    pending_withdrawal NUMERIC(15, 4) DEFAULT 0.0000 CHECK (pending_withdrawal >= 0),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);

-- 4. WALLET LEDGER TRANSACTIONS (Immutable Financial Ledger)
CREATE TABLE IF NOT EXISTS wallet_transactions (
    id BIGSERIAL PRIMARY KEY,
    transaction_id VARCHAR(64) UNIQUE NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL CHECK (type IN (
        'ACCOUNT_PAYMENT', 
        'HOLD_CREATED', 
        'HOLD_RELEASED', 
        'WITHDRAWAL_RESERVATION', 
        'WITHDRAWAL_COMPLETED', 
        'WITHDRAWAL_REFUND', 
        'ADJUSTMENT', 
        'REFERRAL_REWARD'
    )),
    amount NUMERIC(15, 4) NOT NULL,
    balance_type VARCHAR(50) NOT NULL CHECK (balance_type IN ('AVAILABLE', 'HOLD', 'PENDING_WITHDRAWAL')),
    reference_id VARCHAR(100),
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_id ON wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_ref ON wallet_transactions(reference_id);

-- 5. TASKS (Seller Submissions & Tasks)
CREATE TABLE IF NOT EXISTS tasks (
    id BIGSERIAL PRIMARY KEY,
    task_id VARCHAR(64) UNIQUE NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    task_type VARCHAR(50) NOT NULL CHECK (task_type IN ('OLD_ACCOUNT', 'CREATE_NEW')),
    status VARCHAR(50) NOT NULL DEFAULT 'CREATED' CHECK (status IN (
        'CREATED', 
        'IN_PROGRESS', 
        'CONFIRMATION_REQUIRED', 
        'SUBMITTED', 
        'UNDER_REVIEW', 
        'APPROVED', 
        'REJECTED', 
        'CANCELLED', 
        'EXPIRED'
    )),
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    email VARCHAR(255),
    dob_year INT,
    password_placeholder VARCHAR(255),
    safe_data JSONB DEFAULT '{}'::jsonb,
    reward_amount NUMERIC(15, 4) NOT NULL DEFAULT 0.0000,
    telegram_message_id BIGINT,
    rejection_reason TEXT,
    submitted_at TIMESTAMP WITH TIME ZONE,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_task_id ON tasks(task_id);

-- 6. HOLDS
CREATE TABLE IF NOT EXISTS holds (
    id BIGSERIAL PRIMARY KEY,
    hold_id VARCHAR(64) UNIQUE NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    task_id VARCHAR(64) REFERENCES tasks(task_id) ON DELETE SET NULL,
    amount NUMERIC(15, 4) NOT NULL CHECK (amount > 0),
    release_at TIMESTAMP WITH TIME ZONE NOT NULL,
    status VARCHAR(50) DEFAULT 'HELD' CHECK (status IN ('HELD', 'RELEASED', 'REVERSED')),
    released_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_holds_status_release ON holds(status, release_at);

-- 7. WITHDRAWALS
CREATE TABLE IF NOT EXISTS withdrawals (
    id BIGSERIAL PRIMARY KEY,
    withdrawal_id VARCHAR(64) UNIQUE NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    amount NUMERIC(15, 4) NOT NULL CHECK (amount > 0),
    method VARCHAR(50) NOT NULL CHECK (method IN ('USDT_ERC20', 'LTC')),
    wallet_address VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'PENDING' CHECK (status IN (
        'PENDING', 
        'PROCESSING', 
        'COMPLETED', 
        'REJECTED', 
        'CANCELLED'
    )),
    tx_hash VARCHAR(255),
    rejection_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);

-- 8. REFERRALS & REWARDS
CREATE TABLE IF NOT EXISTS referral_rewards (
    id BIGSERIAL PRIMARY KEY,
    referrer_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    referred_user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
    amount NUMERIC(15, 4) NOT NULL CHECK (amount > 0),
    qualifying_task_id VARCHAR(64) REFERENCES tasks(task_id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 9. SETTINGS (Dynamic configuration editable from admin panel)
CREATE TABLE IF NOT EXISTS settings (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 10. AUDIT LOGS (Immutable administrative action log)
CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    admin_id VARCHAR(100) NOT NULL,
    action VARCHAR(100) NOT NULL,
    target_type VARCHAR(50) NOT NULL,
    target_id VARCHAR(100) NOT NULL,
    details JSONB DEFAULT '{}'::jsonb,
    ip_address VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Initial default settings
INSERT INTO settings (key, value) VALUES
('old_account_payment', '0.20'::jsonb),
('create_new_payment', '0.23'::jsonb),
('hold_period_days', '3'::jsonb),
('min_withdrawal', '0.15'::jsonb),
('usdt_enabled', 'true'::jsonb),
('ltc_enabled', 'true'::jsonb),
('referral_enabled', 'true'::jsonb),
('referral_reward', '0.05'::jsonb),
('referral_qualifying_tasks', '1'::jsonb),
('how_to_create_guide', '"📖 How to Create\n\nFollow the registration information provided in your task exactly.\n\nMake sure the information matches the specified task requirements.\n\nAfter completing the task, return here and press ✅ Done."'::jsonb)
ON CONFLICT (key) DO NOTHING;