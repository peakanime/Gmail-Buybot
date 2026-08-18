import { Markup } from 'telegraf';

export const mainMenuKeyboard = Markup.keyboard([
    ['➕ Sell Account', '💰 Balance'],
    ['💸 Withdraw', '📋 My Tasks'],
    ['📜 Transaction History', '👥 Referral'],
    ['⚙️ Settings', '❓ Help']
]).resize();

export const sellSubMenuKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🟢 Old Account', 'sell_old_account')],
    [Markup.button.callback('🆕 Create New', 'sell_create_new')],
    [Markup.button.callback('🔙 Back', 'menu_main')]
]);

export const oldAccountSubmitKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('Continue Submission', 'old_account_continue')],
    [Markup.button.callback('🔙 Back', 'sell_menu')]
]);

export function getCreateTaskKeyboard(taskId, isConfirmingDone = false, isConfirmingCancel = false) {
    const buttons = [];
    
    if (isConfirmingDone) {
        buttons.push([Markup.button.callback('❗ CONFIRM', `task_confirm_${taskId}`)]);
    } else {
        buttons.push([Markup.button.callback('✅ Done', `task_done_${taskId}`)]);
    }

    if (isConfirmingCancel) {
        buttons.push([Markup.button.callback('⛔ Yes, Cancel', `task_cancel_yes_${taskId}`)]);
    } else {
        buttons.push([Markup.button.callback('🚫 Cancel', `task_cancel_${taskId}`)]);
    }

    buttons.push([Markup.button.callback('❓ How Create Gmail Account', `task_guide_${taskId}`)]);
    buttons.push([Markup.button.callback('🔙 Back', 'sell_menu')]);

    return Markup.inlineKeyboard(buttons);
}

export function getWithdrawMethodsKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🪙 USDT — ERC-20', 'wd_method_USDT_ERC20')],
        [Markup.button.callback('🪙 LTC — Litecoin', 'wd_method_LTC')],
        [Markup.button.callback('🔙 Back', 'menu_main')]
    ]);
}

export function getWithdrawConfirmKeyboard(method) {
    return Markup.inlineKeyboard([
        [Markup.button.callback('✅ Confirm', `wd_confirm_submit`)],
        [Markup.button.callback('🔙 Back', 'wd_back_to_methods')]
    ]);
}