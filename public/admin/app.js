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
    loadSection('stats');
}

async function fetchAuth(url, opts = {}) {
    opts.headers = opts.headers || {};
    opts.headers['Authorization'] = `Bearer ${token}`;
    opts.headers['Content-Type'] = 'application/json';
    const res = await fetch(url, opts);
    if (res.status === 401) logout();
    return res.json();
}

async function loadSection(sec) {
    const main = document.getElementById('content');
    if (sec === 'stats') {
        const d = await fetchAuth(`${API_URL}/dashboard`);
        main.innerHTML = `
            <h2>📊 Performance & Financial Statistics</h2>
            <div class="grid">
                <div class="stat-card"><div>Total Users</div><div class="stat-val">${d.users.total}</div></div>
                <div class="stat-card"><div>Pending Submissions</div><div class="stat-val">${d.tasks.pending}</div></div>
                <div class="stat-card"><div>Approved Tasks</div><div class="stat-val">${d.tasks.approved}</div></div>
                <div class="stat-card"><div>Locked in Hold</div><div class="stat-val">$${d.financials.totalHeld.toFixed(2)}</div></div>
                <div class="stat-card"><div>User Available Balance</div><div class="stat-val">$${d.financials.availableUserBalance.toFixed(2)}</div></div>
                <div class="stat-card"><div>Pending Withdrawals</div><div class="stat-val">${d.financials.pendingWithdrawalsCount}</div></div>
                <div class="stat-card"><div>Total Paid Out</div><div class="stat-val">$${d.financials.totalWithdrawnCompleted.toFixed(2)}</div></div>
            </div>
        `;
    } else if (sec === 'tasks') {
        const tasks = await fetchAuth(`${API_URL}/tasks`);
        let html = `<h2>📥 Submissions & Task Review</h2><table><tr><th>ID</th><th>User</th><th>Type</th><th>Details</th><th>Reward</th><th>Status</th><th>Action</th></tr>`;
        for (const t of tasks) {
            const details = t.task_type === 'CREATE_NEW' 
                ? `${t.first_name} | ${t.email}` 
                : JSON.stringify(t.safe_data);
            html += `
                <tr>
                    <td><code>${t.task_id}</code></td>
                    <td>${t.user_id}</td>
                    <td>${t.task_type}</td>
                    <td><small>${details}</small></td>
                    <td>$${parseFloat(t.reward_amount).toFixed(2)}</td>
                    <td><span class="badge badge-${t.status}">${t.status}</span></td>
                    <td>
                        ${t.status === 'SUBMITTED' || t.status === 'UNDER_REVIEW' ? `
                            <button style="background:#22c55e;padding:4px 8px;" onclick="reviewTask('${t.task_id}','APPROVE')">Approve</button>
                            <button style="background:#ef4444;padding:4px 8px;" onclick="reviewTask('${t.task_id}','REJECT')">Reject</button>
                        ` : '-'}
                    </td>
                </tr>
            `;
        }
        html += '</table>';
        main.innerHTML = html;
    } else if (sec === 'withdrawals') {
        const wds = await fetchAuth(`${API_URL}/withdrawals`);
        let html = `<h2>💸 Withdrawal Requests</h2><table><tr><th>ID</th><th>User</th><th>Amount</th><th>Method</th><th>Address</th><th>Status</th><th>Action</th></tr>`;
        for (const w of wds) {
            html += `
                <tr>
                    <td><code>${w.withdrawal_id}</code></td>
                    <td>${w.user_id}</td>
                    <td>$${parseFloat(w.amount).toFixed(2)}</td>
                    <td>${w.method}</td>
                    <td><small><code>${w.wallet_address}</code></small></td>
                    <td><span class="badge badge-${w.status}">${w.status}</span></td>
                    <td>
                        ${w.status === 'PENDING' || w.status === 'PROCESSING' ? `
                            <button style="background:#22c55e;padding:4px 8px;" onclick="completeWithdrawal('${w.withdrawal_id}')">Complete</button>
                            <button style="background:#ef4444;padding:4px 8px;" onclick="rejectWithdrawal('${w.withdrawal_id}')">Reject</button>
                        ` : '-'}
                    </td>
                </tr>
            `;
        }
        html += '</table>';
        main.innerHTML = html;
    } else if (sec === 'settings') {
        const s = await fetchAuth(`${API_URL}/settings`);
        main.innerHTML = `
            <h2>⚙️ Platform Pricing & Configurations</h2>
            <div class="card" style="max-width:600px;">
                <label>Old Account Payment ($):</label>
                <input id="cfg-old" type="number" step="0.01" value="${s.old_account_payment}" />
                <label>Create New Account Payment ($):</label>
                <input id="cfg-create" type="number" step="0.01" value="${s.create_new_payment}" />
                <label>Hold Period (Days):</label>
                <input id="cfg-hold" type="number" value="${s.hold_period_days}" />
                <label>Minimum Withdrawal ($):</label>
                <input id="cfg-minwd" type="number" step="0.01" value="${s.min_withdrawal}" />
                <label>Referral Reward ($):</label>
                <input id="cfg-ref" type="number" step="0.01" value="${s.referral_reward}" />
                <button onclick="saveSettings()">Save Configuration</button>
            </div>
        `;
    } else if (sec === 'broadcast') {
        main.innerHTML = `
            <h2>📢 Telegram Broadcast Announcement</h2>
            <div class="card" style="max-width:600px;">
                <label>Target Audience:</label>
                <select id="bc-target">
                    <option value="ALL">All Registered Users</option>
                    <option value="ACTIVE">Active Users</option>
                    <option value="WITH_BALANCE">Users with Balance > $0.00</option>
                </select>
                <label>Message (Supports HTML formatting):</label>
                <textarea id="bc-msg" rows="5" placeholder="Enter broadcast text here..."></textarea>
                <button onclick="sendBroadcast()">Send Broadcast</button>
            </div>
        `;
    } else if (sec === 'logs') {
        const logs = await fetchAuth(`${API_URL}/audit-logs`);
        let html = `<h2>📝 System Audit Logs</h2><table><tr><th>ID</th><th>Admin</th><th>Action</th><th>Target</th><th>Details</th><th>Date</th></tr>`;
        for (const l of logs) {
            html += `<tr><td>${l.id}</td><td>${l.admin_id}</td><td>${l.action}</td><td>${l.target_type}:${l.target_id}</td><td><small>${JSON.stringify(l.details)}</small></td><td>${new Date(l.created_at).toLocaleString()}</td></tr>`;
        }
        html += '</table>';
        main.innerHTML = html;
    }
}

async function reviewTask(taskId, action) {
    let reason = '';
    if (action === 'REJECT') {
        reason = prompt('Enter rejection reason:');
        if (!reason) return;
    }
    await fetchAuth(`${API_URL}/tasks/${taskId}/review`, {
        method: 'POST',
        body: JSON.stringify({ action, reason })
    });
    loadSection('tasks');
}

async function completeWithdrawal(wdId) {
    const txHash = prompt('Enter Blockchain TX Hash (or leave empty):');
    await fetchAuth(`${API_URL}/withdrawals/${wdId}/process`, {
        method: 'POST',
        body: JSON.stringify({ action: 'COMPLETE', txHash })
    });
    loadSection('withdrawals');
}

async function rejectWithdrawal(wdId) {
    const reason = prompt('Enter rejection reason:');
    if (!reason) return;
    await fetchAuth(`${API_URL}/withdrawals/${wdId}/process`, {
        method: 'POST',
        body: JSON.stringify({ action: 'REJECT', reason })
    });
    loadSection('withdrawals');
}

async function saveSettings() {
    const body = {
        old_account_payment: parseFloat(document.getElementById('cfg-old').value),
        create_new_payment: parseFloat(document.getElementById('cfg-create').value),
        hold_period_days: parseInt(document.getElementById('cfg-hold').value, 10),
        min_withdrawal: parseFloat(document.getElementById('cfg-minwd').value),
        referral_reward: parseFloat(document.getElementById('cfg-ref').value)
    };
    await fetchAuth(`${API_URL}/settings`, { method: 'POST', body: JSON.stringify(body) });
    alert('Settings saved successfully!');
}

async function sendBroadcast() {
    const target = document.getElementById('bc-target').value;
    const message = document.getElementById('bc-msg').value;
    if (!confirm('Are you sure you want to broadcast this message?')) return;

    const res = await fetchAuth(`${API_URL}/broadcast`, {
        method: 'POST',
        body: JSON.stringify({ target, message })
    });
    alert(res.message || 'Broadcast initiated');
}