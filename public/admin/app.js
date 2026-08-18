const API_URL = '/api/admin';
let token = localStorage.getItem('velrix_admin_token');

if (token) {
    showDashboard();
}

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
    const container = document.getElementById('content-body');
    const title = document.getElementById('section-title');

    if (tab === 'stats') {
        title.innerText = 'Platform Analytics & Overview';
        const d = await fetchAuth(`${API_URL}/dashboard`);
        container.innerHTML = `
            <div class="grid">
                <div class="stat-card"><div class="stat-title">Total Users</div><div class="stat-val">${d.users.total}</div></div>
                <div class="stat-card"><div class="stat-title">Tasks in Pool (Admin)</div><div class="stat-val">${d.poolAvailable}</div></div>
                <div class="stat-card"><div class="stat-title">Pending Submissions</div><div class="stat-val">${d.tasks.pending}</div></div>
                <div class="stat-card"><div class="stat-title">Total Held Balances</div><div class="stat-val">$${d.financials.totalHeld.toFixed(2)}</div></div>
                <div class="stat-card"><div class="stat-title">Available Balances</div><div class="stat-val">$${d.financials.availableUserBalance.toFixed(2)}</div></div>
                <div class="stat-card"><div class="stat-title">Pending Withdrawals</div><div class="stat-val">${d.financials.pendingWithdrawalsCount}</div></div>
            </div>
        `;
    } 
    else if (tab === 'task-pool') {
        title.innerText = 'Admin Task Creation & Pool';
        const pool = await fetchAuth(`${API_URL}/tasks/pool`);
        container.innerHTML = `
            <div class="auth-card" style="width:100%;max-width:800px;margin-bottom:24px;">
                <h3>➕ Create New Task for Pool</h3>
                <p class="subtitle">Sellers clicking "🆕 Create New" will immediately receive these preset tasks.</p>
                <div class="grid" style="grid-template-columns: 1fr 1fr;">
                    <div><label>First Name:</label><input id="p-first" placeholder="e.g. Alex" /></div>
                    <div><label>Last Name:</label><input id="p-last" placeholder="e.g. ✖️" value="✖️" /></div>
                    <div><label>Registration Email:</label><input id="p-email" placeholder="e.g. alex.work@gmail.com" /></div>
                    <div><label>Task Password:</label><input id="p-pass" placeholder="e.g. SecurePass2026!" value="SecuredTask2026!" /></div>
                    <div><label>DOB Year:</label><input id="p-dob" type="number" value="1998" /></div>
                    <div><label>Reward ($):</label><input id="p-reward" type="number" step="0.01" value="0.23" /></div>
                </div>
                <button class="btn btn-primary btn-block" onclick="createPoolTask()">Publish Task into Pool</button>
            </div>

            <div class="table-wrap">
                <table>
                    <tr><th>ID</th><th>First Name</th><th>Email</th><th>Password</th><th>Status</th><th>Action</th></tr>
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
        title.innerText = 'Submissions Review (Old & New)';
        const tasks = await fetchAuth(`${API_URL}/tasks`);
        container.innerHTML = `
            <div class="table-wrap">
                <table>
                    <tr><th>Task ID</th><th>User</th><th>Type</th><th>Account Data / Credentials</th><th>Reward</th><th>Status</th><th>Review Action</th></tr>
                    ${tasks.map(t => {
                        const creds = t.task_type === 'OLD_ACCOUNT' 
                            ? `Email: <b>${t.submitted_email || 'N/A'}</b><br>Pass: <code>${t.submitted_password || 'N/A'}</code>`
                            : `Assigned: ${t.email}`;
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
        title.innerText = 'Comprehensive User Master Data & Ledger Logs';
        const users = await fetchAuth(`${API_URL}/users/detailed`);
        container.innerHTML = `
            <div class="table-wrap">
                <table>
                    <tr><th>Telegram ID</th><th>User</th><th>Status</th><th>Available</th><th>Hold</th><th>Pending WD</th><th>Tasks (Appr/Rej)</th><th>Actions</th></tr>
                    ${users.map(u => `
                        <tr>
                            <td><code>${u.telegram_id}</code></td>
                            <td>@${u.username || 'None'}<br><small>${u.first_name || ''}</small></td>
                            <td><span class="badge badge-${u.account_status}">${u.account_status}</span></td>
                            <td><b>$${parseFloat(u.available_balance).toFixed(2)}</b></td>
                            <td>$${parseFloat(u.hold_balance).toFixed(2)}</td>
                            <td>$${parseFloat(u.pending_withdrawal).toFixed(2)}</td>
                            <td>${u.approved_tasks} / ${u.rejected_tasks}</td>
                            <td>
                                <button class="btn btn-primary btn-sm" onclick="openBalanceModal('${u.telegram_id}')">Adjust Balance</button>
                                <button class="btn btn-danger btn-sm" onclick="toggleUserStatus('${u.telegram_id}', '${u.account_status === 'BANNED' ? 'UNBAN' : 'BAN'}')">${u.account_status === 'BANNED' ? 'Unban' : 'Ban'}</button>
                                <button class="btn btn-sm" style="background:#475569;" onclick="openDirectAlertModal('${u.telegram_id}')">Send Notice</button>
                            </td>
                        </tr>
                    `).join('')}
                </table>
            </div>
        `;
    }
    else if (tab === 'alerts') {
        title.innerText = 'Rich Broadcast & Direct Alert Sender';
        container.innerHTML = `
            <div class="auth-card" style="width:100%;max-width:700px;">
                <h3>📢 Send Rich Alert / Notice</h3>
                <p class="subtitle">Broadcast text, banner images, and custom clickable URL buttons to sellers.</p>
                
                <label>Target Audience:</label>
                <select id="a-target">
                    <option value="ALL">All Registered Users</option>
                    <option value="ACTIVE">Active Users Only</option>
                </select>

                <label>Banner Image URL (Optional):</label>
                <input id="a-image" placeholder="https://example.com/banner.jpg" />

                <label>Message Content (HTML Allowed):</label>
                <textarea id="a-text" rows="4" placeholder="Important announcement details..."></textarea>

                <label>Interactive Button 1 (Text & Link):</label>
                <div class="grid" style="grid-template-columns: 1fr 1fr;">
                    <input id="a-btn1-text" placeholder="Button Text (e.g. Join Channel)" />
                    <input id="a-btn1-url" placeholder="https://t.me/yourchannel" />
                </div>

                <button class="btn btn-primary btn-block" onclick="sendRichAlert()">Send Announcement</button>
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
    alert('Task successfully published into Pool!');
    switchTab('task-pool');
}

async function deletePoolTask(id) {
    if (!confirm('Delete this task from pool?')) return;
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
            <option value="ADD">➕ Add Funds (Credit)</option>
            <option value="DEDUCT">➖ Deduct Funds (Debit)</option>
        </select>
        <label>Balance Type:</label>
        <select id="m-type">
            <option value="AVAILABLE">Available Balance</option>
            <option value="HOLD">Hold Balance</option>
        </select>
        <label>Amount ($):</label>
        <input id="m-amount" type="number" step="0.01" placeholder="0.50" />
        <label>Reason / Audit Description:</label>
        <input id="m-reason" placeholder="Bonus, manual adjustment, etc." />
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
    alert('Balance updated successfully!');
    switchTab('users');
}

async function toggleUserStatus(telegramId, action) {
    if (!confirm(`Are you sure you want to execute ${action} on ${telegramId}?`)) return;
    await fetchAuth(`${API_URL}/users/${telegramId}/status-action`, { method: 'POST', body: JSON.stringify({ action }) });
    switchTab('users');
}

function openDirectAlertModal(telegramId) {
    document.getElementById('modal-title').innerText = `Send Alert to User: ${telegramId}`;
    document.getElementById('modal-body').innerHTML = `
        <label>Message Content:</label>
        <textarea id="dm-text" rows="4" placeholder="Hello, regarding your account..."></textarea>
        <label>Optional Photo Link:</label>
        <input id="dm-img" placeholder="https://..." />
        <button class="btn btn-primary btn-block" onclick="sendDirectNotice('${telegramId}')">Send Direct Notice</button>
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
    alert('Notice delivered!');
}

async function sendRichAlert() {
    const buttons = [];
    const bText = document.getElementById('a-btn1-text').value;
    const bUrl = document.getElementById('a-btn1-url').value;
    if (bText && bUrl) buttons.push({ text: bText, url: bUrl });

    const body = {
        targetType: document.getElementById('a-target').value,
        messageText: document.getElementById('a-text').value,
        imageUrl: document.getElementById('a-image').value,
        buttons
    };

    await fetchAuth(`${API_URL}/messages/send-alert`, { method: 'POST', body: JSON.stringify(body) });
    alert('Broadcast initialized successfully!');
}
