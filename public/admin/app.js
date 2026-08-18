const API_URL = '/api/admin';
let token = localStorage.getItem('velrix_admin_token');

if (token) showDashboard();

async function login() {
    const u = document.getElementById('username').value;
    const p = document.getElementById('password').value;
    const err = document.getElementById('login-error');

    try {
        const res = await fetch(`${API_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, password: p })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Login failed');
        localStorage.setItem('velrix_admin_token', data.token);
        token = data.token;
        showDashboard();
    } catch (e) {
        err.innerText = e.message;
    }
}

function logout() {
    localStorage.removeItem('velrix_admin_token');
    location.reload();
}

function showDashboard() {
    document.getElementById('login-container').classList.add('hidden');
    document.getElementById('dashboard-container').classList.remove('hidden');
    switchTab('stats');
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
}

async function fetchAuth(url, opts = {}) {
    opts.headers = opts.headers || {};
    opts.headers['Authorization'] = `Bearer ${token}`;
    opts.headers['Content-Type'] = 'application/json';
    const res = await fetch(url, opts);
    if (res.status === 401) logout();
    return res.json();
}

function closeModal() {
    document.getElementById('action-modal').classList.add('hidden');
}

async function switchTab(tab) {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.getElementById('sidebar').classList.remove('open');
    const container = document.getElementById('content-body');
    const title = document.getElementById('section-title');

    if (tab === 'stats') {
        title.innerText = 'Platform Analytics & Overview';
        const d = await fetchAuth(`${API_URL}/dashboard`);
        container.innerHTML = `
            <div class="grid">
                <div class="stat-card"><div class="stat-title">Total Users</div><div class="stat-val">${d.users.total}</div></div>
                <div class="stat-card"><div class="stat-title">Available Pool Tasks</div><div class="stat-val">${d.poolAvailable}</div></div>
                <div class="stat-card"><div class="stat-title">Pending Reviews</div><div class="stat-val">${d.tasks.pending}</div></div>
                <div class="stat-card"><div class="stat-title">Locked Hold Balance</div><div class="stat-val">$${d.financials.totalHeld.toFixed(2)}</div></div>
                <div class="stat-card"><div class="stat-title">User Available Balance</div><div class="stat-val">$${d.financials.availableUserBalance.toFixed(2)}</div></div>
                <div class="stat-card"><div class="stat-title">Pending Withdrawals</div><div class="stat-val">${d.financials.pendingWithdrawalsCount}</div></div>
            </div>
        `;
    } 
    else if (tab === 'task-pool') {
        title.innerText = 'Admin Task Creation & Pool';
        const pool = await fetchAuth(`${API_URL}/tasks/pool`);
        container.innerHTML = `
            <div class="stat-card" style="margin-bottom:20px;">
                <h3 style="margin-bottom:12px;">➕ Add Gmail Task to Pool</h3>
                <div class="grid" style="grid-template-columns: 1fr 1fr;">
                    <div><label>First Name:</label><input id="p-first" placeholder="e.g. Alex" /></div>
                    <div><label>Last Name:</label><input id="p-last" placeholder="✖️" value="✖️" /></div>
                    <div><label>Email Address:</label><input id="p-email" placeholder="e.g. alex.work@gmail.com" /></div>
                    <div><label>Password:</label><input id="p-pass" value="SecuredTask2026!" /></div>
                    <div><label>DOB Year:</label><input id="p-dob" type="number" value="1998" /></div>
                    <div><label>Reward ($):</label><input id="p-reward" type="number" step="0.01" value="0.23" /></div>
                </div>
                <button class="btn btn-primary btn-block" onclick="createPoolTask()">Publish Task</button>
            </div>

            <div class="table-wrap">
                <table>
                    <tr><th>Pool ID</th><th>First Name</th><th>Email</th><th>Password</th><th>Status</th><th>Action</th></tr>
                    ${pool.map(p => `
                        <tr>
                            <td><code>${p.pool_id}</code></td>
                            <td>${p.first_name}</td>
                            <td>${p.email}</td>
                            <td><code>${p.password_placeholder}</code></td>
                            <td><span class="badge badge-${p.status}">${p.status}</span></td>
                            <td><button class="btn btn-danger btn-sm" onclick="deletePoolTask(${p.id})">Delete</button></td>
                        </tr>
                    `).join('')}
                </table>
            </div>
        `;
    }
    else if (tab === 'tasks') {
        title.innerText = 'Account Submissions';
        const tasks = await fetchAuth(`${API_URL}/tasks`);
        container.innerHTML = `
            <div class="table-wrap">
                <table>
                    <tr><th>Task ID</th><th>User</th><th>Type</th><th>Submitted Credentials</th><th>Reward</th><th>Status</th><th>Action</th></tr>
                    ${tasks.map(t => {
                        const creds = t.task_type === 'OLD_ACCOUNT' 
                            ? `Email: <b>${t.submitted_email || 'N/A'}</b><br>Pass: <code>${t.submitted_password || 'N/A'}</code>`
                            : `Email: ${t.email}`;
                        return `
                        <tr>
                            <td><code>${t.task_id}</code></td>
                            <td>${t.user_id}</td>
                            <td><b>${t.task_type}</b></td>
                            <td><small>${creds}</small></td>
                            <td>$${parseFloat(t.reward_amount).toFixed(2)}</td>
                            <td><span class="badge badge-${t.status}">${t.status}</span></td>
                            <td>
                                ${t.status === 'SUBMITTED' ? `
                                    <button class="btn btn-success btn-sm" onclick="review('${t.task_id}','APPROVE')">Approve</button>
                                    <button class="btn btn-danger btn-sm" onclick="review('${t.task_id}','REJECT')">Reject</button>
                                ` : '-'}
                            </td>
                        </tr>`;
                    }).join('')}
                </table>
            </div>
        `;
    }
    else if (tab === 'users') {
        title.innerText = 'User Master Collector & Logs';
        const users = await fetchAuth(`${API_URL}/users/detailed`);
        container.innerHTML = `
            <div class="table-wrap">
                <table>
                    <tr><th>Telegram ID</th><th>User</th><th>Status</th><th>Available</th><th>Hold</th><th>Tasks</th><th>Actions</th></tr>
                    ${users.map(u => `
                        <tr>
                            <td><code>${u.telegram_id}</code></td>
                            <td>@${u.username || 'None'}<br><small>${u.first_name || ''}</small></td>
                            <td><span class="badge badge-${u.account_status}">${u.account_status}</span></td>
                            <td><b>$${parseFloat(u.available_balance).toFixed(2)}</b></td>
                            <td>$${parseFloat(u.hold_balance).toFixed(2)}</td>
                            <td>${u.approved_tasks} Appr / ${u.rejected_tasks} Rej</td>
                            <td>
                                <button class="btn btn-primary btn-sm" onclick="openBalanceModal('${u.telegram_id}')"><i class="fa-solid fa-dollar-sign"></i></button>
                                <button class="btn btn-danger btn-sm" onclick="toggleUserStatus('${u.telegram_id}', '${u.account_status === 'BANNED' ? 'UNBAN' : 'BAN'}')">${u.account_status === 'BANNED' ? 'Unban' : 'Ban'}</button>
                                <button class="btn btn-sm" style="background:#334155;color:#fff;" onclick="openDirectAlertModal('${u.telegram_id}')"><i class="fa-solid fa-comment"></i></button>
                            </td>
                        </tr>
                    `).join('')}
                </table>
            </div>
        `;
    }
    else if (tab === 'withdrawals') {
        title.innerText = 'Withdrawal Requests';
        const wds = await fetchAuth(`${API_URL}/withdrawals`);
        container.innerHTML = `
            <div class="table-wrap">
                <table>
                    <tr><th>ID</th><th>User</th><th>Amount</th><th>Method</th><th>Address</th><th>Status</th><th>Action</th></tr>
                    ${wds.map(w => `
                        <tr>
                            <td><code>${w.withdrawal_id}</code></td>
                            <td>${w.user_id}</td>
                            <td><b>$${parseFloat(w.amount).toFixed(2)}</b></td>
                            <td>${w.method}</td>
                            <td><small><code>${w.wallet_address}</code></small></td>
                            <td><span class="badge badge-${w.status}">${w.status}</span></td>
                            <td>
                                ${w.status === 'PENDING' ? `
                                    <button class="btn btn-success btn-sm" onclick="completeWd('${w.withdrawal_id}')">Complete</button>
                                    <button class="btn btn-danger btn-sm" onclick="rejectWd('${w.withdrawal_id}')">Reject</button>
                                ` : '-'}
                            </td>
                        </tr>
                    `).join('')}
                </table>
            </div>
        `;
    }
    else if (tab === 'alerts') {
        title.innerText = 'Rich Broadcast & Notice';
        container.innerHTML = `
            <div class="stat-card" style="max-width:600px;">
                <label>Target Audience:</label>
                <select id="a-target">
                    <option value="ALL">All Registered Users</option>
                    <option value="ACTIVE">Active Users Only</option>
                </select>
                <label>Banner Image Link (Optional):</label>
                <input id="a-img" placeholder="https://..." />
                <label>Message Text (HTML):</label>
                <textarea id="a-text" rows="4" placeholder="Announcement..."></textarea>
                <label>Custom Link Button (Text & URL):</label>
                <div class="grid" style="grid-template-columns: 1fr 1fr;">
                    <input id="a-btn-txt" placeholder="Button Label" />
                    <input id="a-btn-url" placeholder="https://t.me/..." />
                </div>
                <button class="btn btn-primary btn-block" onclick="sendBroadcast()"><i class="fa-solid fa-paper-plane"></i> Send Alert</button>
            </div>
        `;
    }
    else if (tab === 'settings') {
        title.innerText = 'Pricing & Configuration';
        const s = await fetchAuth(`${API_URL}/settings`);
        container.innerHTML = `
            <div class="stat-card" style="max-width:600px;">
                <label>Old Account Payment ($):</label>
                <input id="s-old" type="number" step="0.01" value="${s.old_account_payment}" />
                <label>Create New Payment ($):</label>
                <input id="s-create" type="number" step="0.01" value="${s.create_new_payment}" />
                <label>Hold Period (Days):</label>
                <input id="s-hold" type="number" value="${s.hold_period_days}" />
                <label>Min Withdrawal ($):</label>
                <input id="s-minwd" type="number" step="0.01" value="${s.min_withdrawal}" />
                <button class="btn btn-primary btn-block" onclick="saveSettings()">Save Settings</button>
            </div>
        `;
    }
}

async function createPoolTask() {
    const body = {
        firstName: document.getElementById('p-first').value,
        lastName: document.getElementById('p-last').value,
        email: document.getElementById('p-email').value,
        password: document.getElementById('p-pass').value,
        dobYear: document.getElementById('p-dob').value,
        rewardAmount: document.getElementById('p-reward').value
    };
    await fetchAuth(`${API_URL}/tasks/pool/create`, { method: 'POST', body: JSON.stringify(body) });
    alert('Task published into Pool!');
    switchTab('task-pool');
}

async function deletePoolTask(id) {
    if (!confirm('Delete this task?')) return;
    await fetchAuth(`${API_URL}/tasks/pool/${id}`, { method: 'DELETE' });
    switchTab('task-pool');
}

async function review(taskId, action) {
    let reason = '';
    if (action === 'REJECT') {
        reason = prompt('Enter rejection reason:');
        if (!reason) return;
    }
    await fetchAuth(`${API_URL}/tasks/${taskId}/review`, { method: 'POST', body: JSON.stringify({ action, reason }) });
    switchTab('tasks');
}

function openBalanceModal(telegramId) {
    document.getElementById('modal-title').innerText = `Adjust Balance: ${telegramId}`;
    document.getElementById('modal-body').innerHTML = `
        <label>Action:</label>
        <select id="m-action">
            <option value="ADD">➕ Add Balance</option>
            <option value="DEDUCT">➖ Deduct Balance</option>
        </select>
        <label>Type:</label>
        <select id="m-type">
            <option value="AVAILABLE">Available Balance</option>
            <option value="HOLD">Hold Balance</option>
        </select>
        <label>Amount ($):</label>
        <input id="m-amount" type="number" step="0.01" placeholder="10.00" />
        <label>Audit Reason:</label>
        <input id="m-reason" placeholder="Admin reason..." />
        <button class="btn btn-primary btn-block" onclick="submitBalanceAdjust('${telegramId}')">Execute Adjustment</button>
    `;
    document.getElementById('action-modal').classList.remove('hidden');
}

async function submitBalanceAdjust(telegramId) {
    const body = {
        actionType: document.getElementById('m-action').value,
        balanceType: document.getElementById('m-type').value,
        amount: document.getElementById('m-amount').value,
        reason: document.getElementById('m-reason').value
    };
    const res = await fetchAuth(`${API_URL}/users/${telegramId}/balance-adjust`, { method: 'POST', body: JSON.stringify(body) });
    if (res.error) return alert(`Error: ${res.error}`);
    closeModal();
    alert('Balance adjusted successfully!');
    switchTab('users');
}

async function toggleUserStatus(telegramId, action) {
    if (!confirm(`Confirm ${action} for ${telegramId}?`)) return;
    await fetchAuth(`${API_URL}/users/${telegramId}/status-action`, { method: 'POST', body: JSON.stringify({ action }) });
    switchTab('users');
}

function openDirectAlertModal(telegramId) {
    document.getElementById('modal-title').innerText = `Send Alert: ${telegramId}`;
    document.getElementById('modal-body').innerHTML = `
        <label>Message Content:</label>
        <textarea id="dm-text" rows="4" placeholder="Hello..."></textarea>
        <label>Photo URL (Optional):</label>
        <input id="dm-img" placeholder="https://..." />
        <button class="btn btn-primary btn-block" onclick="sendDirectNotice('${telegramId}')">Send Notice</button>
    `;
    document.getElementById('action-modal').classList.remove('hidden');
}

async function sendDirectNotice(telegramId) {
    const body = {
        targetType: 'CUSTOM',
        targetIds: [telegramId],
        messageText: document.getElementById('dm-text').value,
        imageUrl: document.getElementById('dm-img').value
    };
    await fetchAuth(`${API_URL}/messages/send-alert`, { method: 'POST', body: JSON.stringify(body) });
    closeModal();
    alert('Notice sent!');
}

async function sendBroadcast() {
    const bTxt = document.getElementById('a-btn-txt').value;
    const bUrl = document.getElementById('a-btn-url').value;
    const buttons = [];
    if (bTxt && bUrl) buttons.push({ text: bTxt, url: bUrl });

    const body = {
        targetType: document.getElementById('a-target').value,
        messageText: document.getElementById('a-text').value,
        imageUrl: document.getElementById('a-img').value,
        buttons
    };

    await fetchAuth(`${API_URL}/messages/send-alert`, { method: 'POST', body: JSON.stringify(body) });
    alert('Broadcast dispatched!');
}

async function completeWd(wdId) {
    const txHash = prompt('Enter Blockchain TX Hash (optional):');
    await fetchAuth(`${API_URL}/withdrawals/${wdId}/process`, { method: 'POST', body: JSON.stringify({ action: 'COMPLETE', txHash }) });
    switchTab('withdrawals');
}

async function rejectWd(wdId) {
    const reason = prompt('Enter rejection reason:');
    if (!reason) return;
    await fetchAuth(`${API_URL}/withdrawals/${wdId}/process`, { method: 'POST', body: JSON.stringify({ action: 'REJECT', reason }) });
    switchTab('withdrawals');
}

async function saveSettings() {
    const body = {
        old_account_payment: parseFloat(document.getElementById('s-old').value),
        create_new_payment: parseFloat(document.getElementById('s-create').value),
        hold_period_days: parseInt(document.getElementById('s-hold').value, 10),
        min_withdrawal: parseFloat(document.getElementById('s-minwd').value)
    };
    await fetchAuth(`${API_URL}/settings`, { method: 'POST', body: JSON.stringify(body) });
    alert('Settings saved!');
}
