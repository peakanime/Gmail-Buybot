import crypto from 'crypto';
import { query, withTransaction } from '../db/index.js';

export async function processReferralRewardIfQualified(userId, taskId) {
    return await withTransaction(async (client) => {
        const userRes = await client.query('SELECT referrer_id FROM users WHERE telegram_id = $1', [userId]);
        if (userRes.rows.length === 0 || !userRes.rows[0].referrer_id) return null;

        const referrerId = userRes.rows[0].referrer_id;

        // Check if referral reward is already granted for this user
        const rewardCheck = await client.query(
            'SELECT id FROM referral_rewards WHERE referred_user_id = $1',
            [userId]
        );
        if (rewardCheck.rows.length > 0) return null;

        const enabledRes = await client.query("SELECT value FROM settings WHERE key = 'referral_enabled'");
        if (enabledRes.rows.length && enabledRes.rows[0].value === false) return null;

        const rewardAmountRes = await client.query("SELECT value FROM settings WHERE key = 'referral_reward'");
        const rewardAmount = rewardAmountRes.rows.length ? parseFloat(rewardAmountRes.rows[0].value) : 0.05;

        // Credit to referrer's available balance
        await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [referrerId]);
        await client.query(
            'UPDATE wallets SET available_balance = available_balance + $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2',
            [rewardAmount, referrerId]
        );

        await client.query(`
            INSERT INTO referral_rewards (referrer_id, referred_user_id, amount, qualifying_task_id)
            VALUES ($1, $2, $3, $4)
        `, [referrerId, userId, rewardAmount, taskId]);

        const txId = `TXN-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
        await client.query(`
            INSERT INTO wallet_transactions (transaction_id, user_id, type, amount, balance_type, reference_id, description)
            VALUES ($1, $2, 'REFERRAL_REWARD', $3, 'AVAILABLE', $4, $5)
        `, [txId, referrerId, rewardAmount, taskId, `Referral reward from user ${userId}`]);

        return { referrerId, rewardAmount };
    });
}