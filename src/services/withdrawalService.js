import crypto from 'crypto';
import { withTransaction, query } from '../db/index.js';
import { isValidEthereumAddress, isValidLitecoinAddress } from '../utils/validators.js';

export async function requestWithdrawal(telegramId, method, address, requestedAmount = null) {
    return await withTransaction(async (client) => {
        // Validate address
        if (method === 'USDT_ERC20' && !isValidEthereumAddress(address)) {
            throw new Error('Invalid Ethereum/ERC-20 USDT wallet address format.');
        }
        if (method === 'LTC' && !isValidLitecoinAddress(address)) {
            throw new Error('Invalid Litecoin wallet address format.');
        }

        // Lock user and wallet
        const userRes = await client.query(
            'SELECT * FROM users WHERE telegram_id = $1 FOR UPDATE',
            [telegramId]
        );
        if (userRes.rows.length === 0) throw new Error('User not found.');
        const user = userRes.rows[0];

        if (user.account_status === 'BANNED' || user.account_status === 'SUSPENDED') {
            throw new Error('Your account is suspended. Withdrawals are disabled.');
        }
        if (user.withdrawal_restricted) {
            throw new Error('Withdrawals are restricted on your account.');
        }

        const walletRes = await client.query(
            'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE',
            [telegramId]
        );
        const wallet = walletRes.rows[0];
        const available = parseFloat(wallet.available_balance);

        const minRes = await client.query("SELECT value FROM settings WHERE key = 'min_withdrawal'");
        const minAmount = minRes.rows.length ? parseFloat(minRes.rows[0].value) : 0.15;

        const amount = requestedAmount !== null ? parseFloat(requestedAmount) : available;

        if (amount < minAmount) {
            throw new Error(`Minimum withdrawal amount is $${minAmount.toFixed(2)}. Available: $${available.toFixed(2)}`);
        }
        if (available < amount) {
            throw new Error(`Insufficient available balance ($${available.toFixed(2)}). Hold balances cannot be withdrawn.`);
        }

        // Reserve balance immediately to prevent double spending
        await client.query(`
            UPDATE wallets 
            SET available_balance = available_balance - $1,
                pending_withdrawal = pending_withdrawal + $1,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $2
        `, [amount, telegramId]);

        const withdrawalId = `WD-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        await client.query(`
            INSERT INTO withdrawals (withdrawal_id, user_id, amount, method, wallet_address, status)
            VALUES ($1, $2, $3, $4, $5, 'PENDING')
        `, [withdrawalId, telegramId, amount, method, address]);

        const txId = `TXN-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
        await client.query(`
            INSERT INTO wallet_transactions (transaction_id, user_id, type, amount, balance_type, reference_id, description)
            VALUES ($1, $2, 'WITHDRAWAL_RESERVATION', $3, 'PENDING_WITHDRAWAL', $4, $5)
        `, [txId, telegramId, -amount, withdrawalId, `Withdrawal reserved for ${method}`]);

        return { withdrawal_id: withdrawalId, amount, method, address };
    });
}

export async function processAdminWithdrawal(withdrawalId, action, adminId, txHash = '', reason = '') {
    return await withTransaction(async (client) => {
        const wdRes = await client.query(
            'SELECT * FROM withdrawals WHERE withdrawal_id = $1 FOR UPDATE',
            [withdrawalId]
        );
        if (wdRes.rows.length === 0) throw new Error('Withdrawal not found');
        const wd = wdRes.rows[0];

        if (wd.status === 'COMPLETED' || wd.status === 'REJECTED' || wd.status === 'CANCELLED') {
            throw new Error(`Withdrawal is already in terminal state: ${wd.status}`);
        }

        const amount = parseFloat(wd.amount);

        if (action === 'PROCESSING') {
            await client.query("UPDATE withdrawals SET status = 'PROCESSING' WHERE withdrawal_id = $1", [withdrawalId]);
            return { status: 'PROCESSING', withdrawal: wd };
        }

        if (action === 'COMPLETE') {
            await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [wd.user_id]);
            // Deduct pending_withdrawal permanently
            await client.query(`
                UPDATE wallets 
                SET pending_withdrawal = GREATEST(0, pending_withdrawal - $1),
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_id = $2
            `, [amount, wd.user_id]);

            await client.query(`
                UPDATE withdrawals 
                SET status = 'COMPLETED', tx_hash = $1, processed_at = CURRENT_TIMESTAMP
                WHERE withdrawal_id = $2
            `, [txHash || 'CONFIRMED_MANUALLY', withdrawalId]);

            const txId = `TXN-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
            await client.query(`
                INSERT INTO wallet_transactions (transaction_id, user_id, type, amount, balance_type, reference_id, description)
                VALUES ($1, $2, 'WITHDRAWAL_COMPLETED', $3, 'PENDING_WITHDRAWAL', $4, $5)
            `, [txId, wd.user_id, -amount, withdrawalId, `Blockchain TX: ${txHash || 'N/A'}`]);

            return { status: 'COMPLETED', withdrawal: wd, txHash };
        }

        if (action === 'REJECT') {
            await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [wd.user_id]);
            // Refund pending back to available
            await client.query(`
                UPDATE wallets 
                SET pending_withdrawal = GREATEST(0, pending_withdrawal - $1),
                    available_balance = available_balance + $1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_id = $2
            `, [amount, wd.user_id]);

            await client.query(`
                UPDATE withdrawals 
                SET status = 'REJECTED', rejection_reason = $1, processed_at = CURRENT_TIMESTAMP
                WHERE withdrawal_id = $2
            `, [reason || 'Declined by Administrator', withdrawalId]);

            const txId = `TXN-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
            await client.query(`
                INSERT INTO wallet_transactions (transaction_id, user_id, type, amount, balance_type, reference_id, description)
                VALUES ($1, $2, 'WITHDRAWAL_REFUND', $3, 'AVAILABLE', $4, $5)
            `, [txId, wd.user_id, amount, withdrawalId, `Refund: ${reason || 'Declined'}`]);

            return { status: 'REJECTED', withdrawal: wd, reason };
        }
    });
}