import crypto from 'crypto';
import { withTransaction, query } from '../db/index.js';

export async function getUserWallet(telegramId) {
    let res = await query('SELECT * FROM wallets WHERE user_id = $1', [telegramId]);
    if (res.rows.length === 0) {
        await query('INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [telegramId]);
        res = await query('SELECT * FROM wallets WHERE user_id = $1', [telegramId]);
    }
    const w = res.rows[0];
    const available = parseFloat(w.available_balance);
    const hold = parseFloat(w.hold_balance);
    const pending = parseFloat(w.pending_withdrawal);
    const total = available + hold + pending;
    return { available, hold, pending, total };
}

/**
 * Step 1 of Approval: Add payment to HOLD Balance with scheduled release.
 */
export async function approveTaskPaymentToHold(taskId, adminId) {
    return await withTransaction(async (client) => {
        // Lock Task
        const taskRes = await client.query(
            'SELECT * FROM tasks WHERE task_id = $1 FOR UPDATE',
            [taskId]
        );
        if (taskRes.rows.length === 0) throw new Error('Task not found');
        const task = taskRes.rows[0];

        if (['APPROVED', 'CANCELLED', 'REJECTED'].includes(task.status)) {
            throw new Error(`Task is already ${task.status}`);
        }

        const amount = parseFloat(task.reward_amount);
        const holdDaysRes = await client.query("SELECT value FROM settings WHERE key = 'hold_period_days'");
        const holdDays = holdDaysRes.rows.length ? parseInt(holdDaysRes.rows[0].value, 10) : 3;

        const releaseDate = new Date();
        releaseDate.setDate(releaseDate.getDate() + holdDays);

        // Lock & Update Wallet
        await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [task.user_id]);
        await client.query(
            'UPDATE wallets SET hold_balance = hold_balance + $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2',
            [amount, task.user_id]
        );

        // Record Hold
        const holdId = `HOLD-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        await client.query(`
            INSERT INTO holds (hold_id, user_id, task_id, amount, release_at, status)
            VALUES ($1, $2, $3, $4, $5, 'HELD')
        `, [holdId, task.user_id, taskId, amount, releaseDate]);

        // Ledger Entry
        const txId = `TXN-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
        await client.query(`
            INSERT INTO wallet_transactions (transaction_id, user_id, type, amount, balance_type, reference_id, description)
            VALUES ($1, $2, 'HOLD_CREATED', $3, 'HOLD', $4, $5)
        `, [txId, task.user_id, amount, taskId, `Payment placed on hold for task ${taskId}`]);

        // Update Task State
        await client.query(`
            UPDATE tasks 
            SET status = 'APPROVED', reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE task_id = $1
        `, [taskId]);

        // Audit Log
        await client.query(`
            INSERT INTO audit_logs (admin_id, action, target_type, target_id, details)
            VALUES ($1, 'TASK_APPROVED_HELD', 'TASK', $2, $3)
        `, [adminId || 'SYSTEM', taskId, JSON.stringify({ amount, holdDays, releaseDate })]);

        return { user_id: task.user_id, amount, holdDays, releaseDate, task_id: taskId };
    });
}

/**
 * Step 2 of Payment: Worker releases matured hold to Available Balance.
 */
export async function releaseMaturedHold(holdId) {
    return await withTransaction(async (client) => {
        const holdRes = await client.query(
            "SELECT * FROM holds WHERE hold_id = $1 AND status = 'HELD' FOR UPDATE",
            [holdId]
        );
        if (holdRes.rows.length === 0) return null;
        const hold = holdRes.rows[0];
        const amount = parseFloat(hold.amount);

        // Lock Wallet
        await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [hold.user_id]);

        // Deduct from Hold, Credit to Available
        await client.query(`
            UPDATE wallets 
            SET hold_balance = GREATEST(0, hold_balance - $1),
                available_balance = available_balance + $1,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $2
        `, [amount, hold.user_id]);

        // Update Hold Record
        await client.query(`
            UPDATE holds 
            SET status = 'RELEASED', released_at = CURRENT_TIMESTAMP
            WHERE hold_id = $1
        `, [holdId]);

        // Ledger Entry
        const txId = `TXN-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
        await client.query(`
            INSERT INTO wallet_transactions (transaction_id, user_id, type, amount, balance_type, reference_id, description)
            VALUES ($1, $2, 'HOLD_RELEASED', $3, 'AVAILABLE', $4, $5)
        `, [txId, hold.user_id, amount, hold.task_id, `Hold released to available balance`]);

        const walletRes = await client.query('SELECT available_balance FROM wallets WHERE user_id = $1', [hold.user_id]);
        return {
            user_id: hold.user_id,
            amount,
            new_available: parseFloat(walletRes.rows[0].available_balance)
        };
    });
}