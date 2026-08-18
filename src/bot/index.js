import { Telegraf, session } from 'telegraf';
import crypto from 'crypto';
import { query } from '../db/index.js';
import { getSetting } from '../services/settingsService.js';
import { getUserWallet } from '../services/accounting.js';
import { requestWithdrawal } from '../services/withdrawalService.js';
import { isValidEthereumAddress, isValidLitecoinAddress, sanitizeInput } from '../utils/validators.js';
import {
    mainMenuKeyboard,
    sellSubMenuKeyboard,
    oldAccountSubmitKeyboard,
    getCreateTaskKeyboard,
    getWithdrawMethodsKeyboard,
    getWithdrawConfirmKeyboard
} from './keyboards.js';

export function createTelegramBot(token) {
    const bot = new Telegraf(token);
    bot.use(session());

    // Middleware: Ensure user registered in DB and verify account status
    bot.use(async (ctx, next) => {
        if (!ctx.from) return next();
        const { id, username, first_name, last_name } = ctx.from;

        let res = await query('SELECT * FROM users WHERE telegram_id = $1', [id]);
        if (res.rows.length === 0) {
            let referrerId = null;
            if (ctx.message && ctx.message.text && ctx.message.text.startsWith('/start ref_')) {
                const refCode = ctx.message.text.split('ref_')[1];
                const refNum = parseInt(refCode, 10);
                if (!isNaN(refNum) && refNum !== id) {
                    referrerId = refNum;
                }
            }

            await query(`
                INSERT INTO users (telegram_id, username, first_name, last_name, referrer_id)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (telegram_id) DO UPDATE 
                SET username = EXCLUDED.username, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name
            `, [id, username || null, first_name || null, last_name || null, referrerId]);

            await query('INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
        } else {
            const user = res.rows[0];
            if (user.account_status === 'BANNED') {
                return ctx.reply('⛔ Your account has been permanently banned.');
            }
        }
        return next();
    });

    // 1. /start command
    bot.start(async (ctx) => {
        const welcomeText = `👋 Welcome to the Account Submission Platform!\n\nSubmit accounts directly to the buyer, track your balances, and request crypto payouts securely.`;
        await ctx.reply(welcomeText, mainMenuKeyboard);
    });

    // 2. MAIN MENU BUTTONS
    bot.hears('➕ Sell Account', async (ctx) => {
        const userRes = await query('SELECT selling_restricted, account_status FROM users WHERE telegram_id = $1', [ctx.from.id]);
        if (userRes.rows[0]?.selling_restricted || userRes.rows[0]?.account_status === 'SUSPENDED') {
            return ctx.reply('⚠️ Account selling is currently restricted on your profile.');
        }
        await ctx.reply('Select submission type:', sellSubMenuKeyboard);
    });

    bot.hears('💰 Balance', async (ctx) => {
        const w = await getUserWallet(ctx.from.id);
        const msg = `💰 <b>Balance</b>\n\n` +
                    `Available: $${w.available.toFixed(2)}\n` +
                    `🔒 Hold: $${w.hold.toFixed(2)}\n` +
                    `⏳ Withdrawal Pending: $${w.pending.toFixed(2)}\n\n` +
                    `<b>Total: $${w.total.toFixed(2)}</b>`;
        await ctx.replyWithHTML(msg);
    });

    bot.hears('💸 Withdraw', async (ctx) => {
        const w = await getUserWallet(ctx.from.id);
        const minWd = await getSetting('min_withdrawal', 0.15);

        const msg = `💸 <b>Withdraw</b>\n\n` +
                    `Available Balance: $${w.available.toFixed(2)}\n` +
                    `🔒 Hold Balance: $${w.hold.toFixed(2)}\n\n` +
                    `Minimum Withdrawal: $${parseFloat(minWd).toFixed(2)}\n\n` +
                    `Select Payment Method:`;
        await ctx.replyWithHTML(msg, getWithdrawMethodsKeyboard());
    });

    bot.hears('📋 My Tasks', async (ctx) => {
        const res = await query(
            'SELECT task_id, task_type, status, reward_amount, created_at FROM tasks WHERE user_id = $1 ORDER BY id DESC LIMIT 10',
            [ctx.from.id]
        );
        if (res.rows.length === 0) {
            return ctx.reply('📋 You have no submitted tasks yet.');
        }
        let text = '📋 <b>Your Recent Tasks:</b>\n\n';
        for (const t of res.rows) {
            text += `• <b>${t.task_id}</b> (${t.task_type})\n  Status: <code>${t.status}</code> | Reward: $${parseFloat(t.reward_amount).toFixed(2)}\n\n`;
        }
        await ctx.replyWithHTML(text);
    });

    bot.hears('📜 Transaction History', async (ctx) => {
        const res = await query(
            'SELECT transaction_id, type, amount, balance_type, reference_id, created_at FROM wallet_transactions WHERE user_id = $1 ORDER BY id DESC LIMIT 10',
            [ctx.from.id]
        );
        if (res.rows.length === 0) {
            return ctx.reply('📜 No transaction history found.');
        }
        let text = '📜 <b>Transaction History:</b>\n\n';
        for (const tx of res.rows) {
            const sign = parseFloat(tx.amount) >= 0 ? '+' : '';
            text += `📋 <b>${tx.transaction_id}</b>\n` +
                    `Type: ${tx.type}\n` +
                    `Amount: ${sign}$${parseFloat(tx.amount).toFixed(2)} (${tx.balance_type})\n` +
                    `Ref: ${tx.reference_id || 'N/A'}\n` +
                    `Date: ${new Date(tx.created_at).toLocaleDateString('en-GB')}\n\n`;
        }
        await ctx.replyWithHTML(text);
    });

    bot.hears('👥 Referral', async (ctx) => {
        const botUsername = ctx.botInfo.username;
        const refLink = `https://t.me/${botUsername}?start=ref_${ctx.from.id}`;
        
        const countRes = await query('SELECT COUNT(*) FROM users WHERE referrer_id = $1', [ctx.from.id]);
        const totalRef = parseInt(countRes.rows[0].count, 10);

        const rewardsRes = await query('SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS qualified FROM referral_rewards WHERE referrer_id = $1', [ctx.from.id]);
        const earnings = parseFloat(rewardsRes.rows[0].total);
        const qualified = parseInt(rewardsRes.rows[0].qualified, 10);

        const msg = `👥 <b>Referral Program</b>\n\n` +
                    `Share your referral link with sellers to earn rewards.\n\n` +
                    `<b>Your Link:</b>\n<code>${refLink}</code>\n\n` +
                    `Total Referrals: ${totalRef}\n` +
                    `Qualified Referrals: ${qualified}\n` +
                    `Referral Earnings: $${earnings.toFixed(2)}`;
        await ctx.replyWithHTML(msg);
    });

    bot.hears('⚙️ Settings', async (ctx) => {
        await ctx.replyWithHTML(`⚙️ <b>User Profile & Settings</b>\n\nTelegram ID: <code>${ctx.from.id}</code>\nUsername: @${ctx.from.username || 'None'}`);
    });

    bot.hears('❓ Help', async (ctx) => {
        const guide = await getSetting('how_to_create_guide', 'Submit accounts following instructions to receive crypto payouts.');
        await ctx.replyWithHTML(`❓ <b>Help & FAQ</b>\n\n${guide}`);
    });

    // 3. INLINE CALLBACK ACTIONS
    bot.action('menu_main', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.deleteMessage().catch(() => {});
        await ctx.reply('Main Menu', mainMenuKeyboard);
    });

    bot.action('sell_menu', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.editMessageText('Select submission type:', sellSubMenuKeyboard);
    });

    // OLD ACCOUNT FLOW
    bot.action('sell_old_account', async (ctx) => {
        await ctx.answerCbQuery();
        const text = `Old Account Submission\n\nSubmit your existing account information for buyer review.`;
        await ctx.editMessageText(text, oldAccountSubmitKeyboard);
    });

    bot.action('old_account_continue', async (ctx) => {
        await ctx.answerCbQuery();
        ctx.session = ctx.session || {};
        ctx.session.step = 'AWAITING_OLD_ACCOUNT_DATA';

        await ctx.editMessageText(
            `Please send the account email address / identifier and creation year.\n\n` +
            `⚠️ <b>DO NOT send passwords, OTP, recovery codes, or 2FA codes.</b>`
        );
    });

    // CREATE NEW ACCOUNT FLOW
    bot.action('sell_create_new', async (ctx) => {
        await ctx.answerCbQuery();
        const taskId = `TASK-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const reward = await getSetting('create_new_payment', 0.23);

        const randFirst = ['Alex', 'David', 'Elena', 'Mark', 'Sarah', 'Lucas'][Math.floor(Math.random() * 6)];
        const randEmail = `${randFirst.toLowerCase()}.${crypto.randomBytes(3).toString('hex')}@gmail.com`;
        const randDob = 1990 + Math.floor(Math.random() * 12);

        await query(`
            INSERT INTO tasks (task_id, user_id, task_type, status, first_name, last_name, email, dob_year, password_placeholder, reward_amount)
            VALUES ($1, $2, 'CREATE_NEW', 'CREATED', $3, '✖️', $4, $5, 'SecuredTemp2026!', $6)
        `, [taskId, ctx.from.id, randFirst, randEmail, randDob, parseFloat(reward)]);

        const text = `Register Gmail account using the specified data and get from $${parseFloat(reward).toFixed(2)}\n\n` +
                     `First name: ${randFirst}\n` +
                     `Name: ✖️\n` +
                     `Email: ${randEmail}\n` +
                     `Password: SecuredTemp2026!\n` +
                     `Year of birth: ${randDob}\n\n` +
                     `🔐 Be sure to use the specified data, otherwise the account will not be paid.`;

        const sentMsg = await ctx.editMessageText(text, getCreateTaskKeyboard(taskId, false, false));
        await query('UPDATE tasks SET telegram_message_id = $1 WHERE task_id = $2', [sentMsg.message_id, taskId]);
    });

    // DONE -> CONFIRM TRANSITION
    bot.action(/task_done_(.+)/, async (ctx) => {
        const taskId = ctx.match[1];
        await ctx.answerCbQuery();
        const taskRes = await query('SELECT * FROM tasks WHERE task_id = $1', [taskId]);
        if (taskRes.rows.length === 0 || taskRes.rows[0].status !== 'CREATED') return;

        await ctx.editMessageReplyMarkup(getCreateTaskKeyboard(taskId, true, false).reply_markup);
    });

    // CONFIRM SUBMISSION
    bot.action(/task_confirm_(.+)/, async (ctx) => {
        const taskId = ctx.match[1];
        await ctx.answerCbQuery();

        const taskRes = await query('SELECT * FROM tasks WHERE task_id = $1', [taskId]);
        if (taskRes.rows.length === 0) return;
        const task = taskRes.rows[0];

        if (task.status !== 'CREATED' && task.status !== 'CONFIRMATION_REQUIRED') {
            return ctx.reply(`Task is already ${task.status}.`);
        }

        await query(`
            UPDATE tasks 
            SET status = 'SUBMITTED', submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE task_id = $1
        `, [taskId]);

        await ctx.editMessageText(
            `⏳ Your Gmail account creation task (${taskId}) has been submitted for review.\n\nPlease wait for confirmation.`
        );
    });

    // CANCEL -> CONFIRM CANCEL
    bot.action(/task_cancel_(.+)/, async (ctx) => {
        const taskId = ctx.match[1];
        await ctx.answerCbQuery();
        await ctx.editMessageReplyMarkup(getCreateTaskKeyboard(taskId, false, true).reply_markup);
    });

    // YES, CANCEL
    bot.action(/task_cancel_yes_(.+)/, async (ctx) => {
        const taskId = ctx.match[1];
        await ctx.answerCbQuery();

        const res = await query('SELECT * FROM tasks WHERE task_id = $1', [taskId]);
        if (res.rows.length === 0) return;
        const task = res.rows[0];

        await query(`
            UPDATE tasks SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE task_id = $1
        `, [taskId]);

        const text = `Register Gmail account using the specified data and get from $${parseFloat(task.reward_amount).toFixed(2)}\n\n` +
                     `First name: ${task.first_name}\n` +
                     `Name: ${task.last_name || '✖️'}\n` +
                     `Email: ${task.email}\n` +
                     `Password: ${task.password_placeholder}\n` +
                     `Year of birth: ${task.dob_year}\n\n` +
                     `🔐 Be sure to use the specified data, otherwise the account will not be paid.\n\n` +
                     `⛔ Registration cancelled`;

        // Action buttons removed
        await ctx.editMessageText(text);
    });

    bot.action(/task_guide_(.+)/, async (ctx) => {
        const taskId = ctx.match[1];
        await ctx.answerCbQuery();
        const guide = await getSetting('how_to_create_guide', 'Follow the registration information provided in your task exactly.');
        await ctx.reply(guide);
    });

    // WITHDRAWAL FLOW
    bot.action(/wd_method_(.+)/, async (ctx) => {
        const method = ctx.match[1]; // USDT_ERC20 or LTC
        await ctx.answerCbQuery();

        ctx.session = ctx.session || {};
        ctx.session.wd_method = method;
        ctx.session.step = 'AWAITING_WD_ADDRESS';

        const label = method === 'USDT_ERC20' ? '🪙 USDT — ERC-20' : '🪙 LTC — Litecoin Network';
        await ctx.editMessageText(
            `${label}\n\nPlease enter your ${method === 'USDT_ERC20' ? 'USDT (ERC-20)' : 'Litecoin'} wallet address:`
        );
    });

    bot.action('wd_back_to_methods', async (ctx) => {
        await ctx.answerCbQuery();
        const w = await getUserWallet(ctx.from.id);
        const minWd = await getSetting('min_withdrawal', 0.15);

        const msg = `💸 <b>Withdraw</b>\n\n` +
                    `Available Balance: $${w.available.toFixed(2)}\n` +
                    `🔒 Hold Balance: $${w.hold.toFixed(2)}\n\n` +
                    `Minimum Withdrawal: $${parseFloat(minWd).toFixed(2)}\n\n` +
                    `Select Payment Method:`;
        await ctx.editMessageText(msg, { parse_mode: 'HTML', ...getWithdrawMethodsKeyboard() });
    });

    bot.action('wd_confirm_submit', async (ctx) => {
        await ctx.answerCbQuery();
        ctx.session = ctx.session || {};
        const { wd_method, wd_address } = ctx.session;

        if (!wd_method || !wd_address) {
            return ctx.reply('⚠️ Withdrawal session expired. Please start again from 💸 Withdraw.');
        }

        try {
            const res = await requestWithdrawal(ctx.from.id, wd_method, wd_address);
            ctx.session = {}; // Clear session state

            const label = wd_method === 'USDT_ERC20' ? 'USDT — ERC-20' : 'LTC — Litecoin';
            await ctx.editMessageText(
                `✅ <b>Withdrawal Submitted</b>\n\n` +
                `Amount: $${res.amount.toFixed(2)}\n` +
                `Method: ${label}\n` +
                `Address: <code>${res.address}</code>\n` +
                `Status: ⏳ Pending\n` +
                `Withdrawal ID: <code>${res.withdrawal_id}</code>`,
                { parse_mode: 'HTML' }
            );
        } catch (err) {
            await ctx.reply(`⚠️ ${err.message}`);
        }
    });

    // TEXT MESSAGE HANDLER FOR STEPS
    bot.on('text', async (ctx) => {
        const text = ctx.message.text.trim();
        ctx.session = ctx.session || {};

        if (ctx.session.step === 'AWAITING_OLD_ACCOUNT_DATA') {
            const taskId = `TASK-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
            const reward = await getSetting('old_account_payment', 0.20);
            const safeData = { submission_text: sanitizeInput(text) };

            await query(`
                INSERT INTO tasks (task_id, user_id, task_type, status, safe_data, reward_amount, submitted_at)
                VALUES ($1, $2, 'OLD_ACCOUNT', 'SUBMITTED', $3, $4, CURRENT_TIMESTAMP)
            `, [taskId, ctx.from.id, JSON.stringify(safeData), parseFloat(reward)]);

            ctx.session.step = null;
            await ctx.reply(
                `⏳ Your account submission is under review.\n\nPlease wait for confirmation.\n\nTask ID: <code>${taskId}</code>`,
                { parse_mode: 'HTML', ...mainMenuKeyboard }
            );
            return;
        }

        if (ctx.session.step === 'AWAITING_WD_ADDRESS') {
            const method = ctx.session.wd_method;
            if (method === 'USDT_ERC20' && !isValidEthereumAddress(text)) {
                return ctx.reply('⚠️ Invalid ERC-20 address format (Must start with 0x and be 42 characters). Please try again:');
            }
            if (method === 'LTC' && !isValidLitecoinAddress(text)) {
                return ctx.reply('⚠️ Invalid Litecoin address format. Please try again:');
            }

            ctx.session.wd_address = text;
            ctx.session.step = 'AWAITING_WD_CONFIRM';

            const w = await getUserWallet(ctx.from.id);
            const label = method === 'USDT_ERC20' ? 'USDT — ERC-20' : 'LTC — Litecoin';

            const confText = `💸 <b>Withdrawal Confirmation</b>\n\n` +
                             `Amount: $${w.available.toFixed(2)}\n` +
                             `Method: ${label}\n` +
                             `Address: <code>${text}</code>\n\n` +
                             `⚠️ Make sure the network and address are correct before confirming.`;

            await ctx.replyWithHTML(confText, getWithdrawConfirmKeyboard(method));
            return;
        }
    });

    return bot;
}