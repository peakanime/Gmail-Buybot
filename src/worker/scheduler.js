import cron from 'node-cron';
import { query } from '../db/index.js';
import { releaseMaturedHold } from '../services/accounting.js';
import { notifyUser } from '../services/notificationService.js';

export function initBackgroundWorker(botInstance) {
    console.log('⏱️ Background Worker initialized.');

    // 1. Process Hold Releases every 60 seconds
    cron.schedule('* * * * *', async () => {
        try {
            const maturedHolds = await query(`
                SELECT hold_id FROM holds 
                WHERE status = 'HELD' AND release_at <= CURRENT_TIMESTAMP 
                LIMIT 50
            `);

            for (const row of maturedHolds.rows) {
                const releaseResult = await releaseMaturedHold(row.hold_id);
                if (releaseResult && botInstance) {
                    const msg = `🔓 <b>Hold Released</b>\n\n` +
                                `$${releaseResult.amount.toFixed(2)} has been released to your Available Balance.\n\n` +
                                `Available Balance: $${releaseResult.new_available.toFixed(2)}`;
                    await notifyUser(botInstance, releaseResult.user_id, msg);
                }
            }
        } catch (err) {
            console.error('Error processing matured holds:', err);
        }
    });

    // 2. Mark abandoned tasks as EXPIRED every 10 minutes (Created > 24 hours ago and never submitted)
    cron.schedule('*/10 * * * *', async () => {
        try {
            await query(`
                UPDATE tasks 
                SET status = 'EXPIRED', updated_at = CURRENT_TIMESTAMP 
                WHERE status = 'CREATED' 
                  AND created_at < NOW() - INTERVAL '24 HOURS'
            `);
        } catch (err) {
            console.error('Error expiring stale tasks:', err);
        }
    });
}