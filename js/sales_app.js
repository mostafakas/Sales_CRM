// ==========================================
// ALMASTER Sales CRM - SPA Logic
// ==========================================

// --- Firebase Initialization ---
const firebaseConfig = { 
    apiKey: "AIzaSyCXyuT529aGwiS5j_RPxW_zEeAtkYc7JlM", 
    authDomain: "almaster-b8c18.firebaseapp.com", 
    projectId: "almaster-b8c18", 
    storageBucket: "almaster-b8c18.firebasestorage.app", 
    messagingSenderId: "884142036232", 
    appId: "1:884142036232:web:eeb6677d988565653a08bd" 
};
if (!firebase.apps.length) { firebase.initializeApp(firebaseConfig); }
const db = firebase.firestore();
const auth = firebase.auth();

// --- Global State ---
let currentUser = null;
let currentRole = null;
let currentView = 'leads';
let leadsViewMode = 'table'; // table or kanban
let leadsData = [];
let systemUsers = [];
let settingsData = { employees: [], sources: [], currencies: [] };
let chartInstances = { sales: null, status: null };
let currentLeadFilter = 'all';

// --- Utility Functions ---
function escapeHtml(unsafe) {
    if(!unsafe) return '';
    return String(unsafe)
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

function showToast(message, type = 'success') {
    const Toast = Swal.mixin({
        toast: true,
        position: 'bottom-end',
        showConfirmButton: false,
        timer: 3000,
        timerProgressBar: true,
        background: document.documentElement.classList.contains('dark') ? '#1e293b' : '#ffffff',
        color: document.documentElement.classList.contains('dark') ? '#f1f5f9' : '#0f172a'
    });
    Toast.fire({ icon: type, title: message });
}

// --- Theme Management ---
function toggleTheme() {
    const html = document.documentElement;
    html.classList.toggle('dark');
    const isDark = html.classList.contains('dark');
    localStorage.setItem('almaster_theme', isDark ? 'dark' : 'light');
    updateThemeUI(isDark);
    if(chartInstances.sales) renderCharts(); // Re-render charts for colors
}

function updateThemeUI(isDark) {
    const icon = document.getElementById('theme-icon');
    if (icon) icon.className = isDark ? 'fas fa-sun text-lg' : 'fas fa-moon text-lg';
}

function initTheme() {
    const savedTheme = localStorage.getItem('almaster_theme');
    const html = document.documentElement;
    if (savedTheme === 'light') {
        html.classList.remove('dark');
        updateThemeUI(false);
    } else {
        html.classList.add('dark');
        updateThemeUI(true);
    }
}

// --- Navigation (SPA) ---
function navigate(viewId) {
    currentView = viewId;
    
    // Hide all views
    document.querySelectorAll('.spa-view').forEach(el => el.classList.remove('active'));
    // Show target view
    const viewEl = document.getElementById(`view-${viewId}`);
    if(viewEl) viewEl.classList.add('active');
    
    // Reset Nav styling
    document.querySelectorAll('.nav-link').forEach(el => {
        el.classList.remove('bg-slate-50', 'dark:bg-slate-800', 'text-almaster-royal', 'dark:text-white', 'bg-almaster-royal/10', 'text-almaster-royal');
        el.classList.add('text-slate-500', 'dark:text-slate-400');
    });
    
    // Active Nav styling
    const activeNav = document.getElementById(`nav-${viewId}`);
    if (activeNav) {
        if(viewId === 'settings') {
            activeNav.classList.add('bg-amber-50', 'dark:bg-amber-500/10', 'text-amber-500');
            activeNav.classList.remove('text-slate-500', 'dark:text-slate-400');
        } else {
            activeNav.classList.add('bg-almaster-royal/10', 'text-almaster-royal', 'dark:text-white');
            activeNav.classList.remove('text-slate-500', 'dark:text-slate-400');
        }
    }
    
    // Update Header Actions & Title
    const titles = { 'leads': 'Leads Pipeline', 'analytics': 'Analytics Dashboard', 'reports': 'Sales Reports', 'settings': 'System Settings' };
    document.getElementById('page-title').innerText = titles[viewId] || 'Dashboard';
    
    document.getElementById('header-actions').style.display = viewId === 'leads' ? 'flex' : 'none';
}

// --- Authentication ---
auth.onAuthStateChanged(async (user) => {
    if (!user) { window.location.replace('index.html'); return; }
    try {
        const doc = await db.collection('users').doc(user.email.toLowerCase().trim()).get();
        if (doc.exists) {
            const data = doc.data();
            if (data.isSuspended || (data.role !== 'admin' && (!data.permissions || !data.permissions.crm))) {
                Swal.fire({ icon:'error', title:'Unauthorized', text:'You do not have permission to access the CRM.', allowOutsideClick: false }).then(() => {
                    window.location.replace('app.html');
                });
                return;
            }
            currentUser = data;
            currentRole = (data.permissions && data.permissions.crmRole) || (data.role === 'admin' ? 'admin' : 'Agent');
            
            // Set Header Info
            const userName = data.name || user.email.split('@')[0];
            document.getElementById('user-name').innerText = escapeHtml(userName);
            document.getElementById('user-role').innerText = `CRM ${escapeHtml(currentRole)}`;
            document.getElementById('user-avatar').src = data.profileImage || `https://ui-avatars.com/api/?name=${userName}&background=random`;
            
            // Admin checks
            if(currentRole === 'admin') {
                document.getElementById('admin-nav-section').style.display = 'block';
            }
            
            // Hide Loader & init app
            document.getElementById('global-loader').style.display = 'none';
            initTheme();
            initSettings();
            initUsers();
            initLeads();
            navigate('leads');
        } else {
            window.location.replace('index.html');
        }
    } catch (e) {
        console.error("Auth Error:", e);
    }
});

// --- System Settings (Admin) ---
function initSettings() {
    db.collection('crm_settings').doc('config').onSnapshot(doc => {
        if(doc.exists) {
            settingsData = doc.data();
            if(!settingsData.employees) settingsData.employees = [];
            if(!settingsData.sources) settingsData.sources = [];
            if(!settingsData.currencies) settingsData.currencies = [];
        } else {
            // Default initial setup
            db.collection('crm_settings').doc('config').set({
                employees: ['Mustafa', 'Mohamed', 'Kholoud', 'Magda'],
                sources: ['Website', 'WhatsApp', 'Email', 'Personal'],
                currencies: ['SAR', 'USD', 'EGP']
            });
        }
        renderSettingsAdmin();
        updateLeadFormDropdowns();
    });
}

function renderSettingsAdmin() {
    if(currentRole !== 'admin') return;
    
    const renderList = (id, arr, type) => {
        const el = document.getElementById(id);
        if(!el) return;
        el.innerHTML = arr.map(item => `
            <div class="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-lg group">
                <span class="font-bold text-sm text-slate-700 dark:text-slate-300">${escapeHtml(item)}</span>
                <button onclick="removeSettingItem('${type}', '${item.replace(/'/g, "\\'")}')" class="text-red-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"><i class="fas fa-trash-alt"></i></button>
            </div>
        `).join('');
        if(arr.length === 0) el.innerHTML = '<p class="text-xs text-slate-400 p-2">No items found.</p>';
    };
    
    const empCard = document.getElementById('settings-employees-list');
    if (empCard && empCard.parentElement) empCard.parentElement.style.display = 'none'; // Hide legacy employee settings card
    
    // renderList('settings-employees-list', settingsData.employees, 'employees');
    renderList('settings-sources-list', settingsData.sources, 'sources');
    renderList('settings-currencies-list', settingsData.currencies, 'currencies');
}

async function addSettingItem(type) {
    const { value: item } = await Swal.fire({
        title: `Add New ${type}`,
        input: 'text',
        showCancelButton: true,
        inputValidator: (val) => { if (!val) return 'Cannot be empty!' }
    });
    
    if (item) {
        const arr = [...(settingsData[type] || [])];
        if(!arr.includes(item.trim())) {
            arr.push(item.trim());
            db.collection('crm_settings').doc('config').update({ [type]: arr });
            showToast('Added successfully');
        }
    }
}

function removeSettingItem(type, item) {
    const arr = (settingsData[type] || []).filter(i => i !== item);
    db.collection('crm_settings').doc('config').update({ [type]: arr });
    showToast('Removed successfully', 'info');
}

function updateLeadFormDropdowns() {
    const updateSelect = (id, arr) => {
        const el = document.getElementById(id);
        if(!el) return;
        const currentVal = el.value;
        el.innerHTML = arr.map(i => `<option value="${escapeHtml(i)}">${escapeHtml(i)}</option>`).join('');
        if(arr.includes(currentVal)) el.value = currentVal;
    };
    
    updateSelect('lead-source', settingsData.sources);
    updateSelect('lead-currency', settingsData.currencies);
}

// --- Data Fetching (Users & Leads) ---
function initUsers() {
    db.collection('users').onSnapshot(snapshot => {
        systemUsers = [];
        snapshot.forEach(doc => systemUsers.push({ email: doc.id, ...doc.data() }));
        renderEmployeeDropdown(systemUsers);
    });
}

// Custom Employee Dropdown Logic
let dropdownOpen = false;
function toggleEmployeeDropdown() {
    dropdownOpen = !dropdownOpen;
    const list = document.getElementById('employee-dropdown-list');
    const icon = document.getElementById('employee-dropdown-icon');
    if (!list) return;
    
    if (dropdownOpen) {
        list.classList.remove('hidden');
        icon.classList.add('rotate-180');
        document.getElementById('employee-search').value = '';
        renderEmployeeDropdown(systemUsers);
    } else {
        list.classList.add('hidden');
        icon.classList.remove('rotate-180');
    }
}

function filterEmployeeList() {
    const q = document.getElementById('employee-search').value.toLowerCase();
    const filtered = systemUsers.filter(u => (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q) || (u.title || '').toLowerCase().includes(q));
    renderEmployeeDropdown(filtered);
}

function renderEmployeeDropdown(usersArr) {
    const opts = document.getElementById('employee-options');
    if (!opts) return;
    
    if (usersArr.length === 0) {
        opts.innerHTML = '<div class="p-4 text-center text-xs text-slate-400">No employees found.</div>';
        return;
    }
    
    opts.innerHTML = usersArr.map(u => {
        const photo = u.profileImage || u.photo || (u.gender === 'female' ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="50" fill="#fdf2f8"/><circle cx="50" cy="38" r="16" fill="#db2777"/><path d="M20,95 Q50,60 80,95 Z" fill="#db2777"/><circle cx="34" cy="42" r="8" fill="#db2777"/><circle cx="66" cy="42" r="8" fill="#db2777"/></svg>')}` : `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="50" fill="#eaf1ff"/><circle cx="50" cy="38" r="18" fill="#2563eb"/><path d="M20,95 Q50,60 80,95 Z" fill="#2563eb"/></svg>')}`);
        
        return `
            <div onclick="selectEmployee('${escapeHtml(u.email)}', '${escapeHtml(u.name || u.email)}', '${photo}')" class="flex items-center gap-3 p-2 hover:bg-slate-50 dark:hover:bg-slate-700 rounded-lg cursor-pointer transition-colors">
                <img src="${photo}" class="w-8 h-8 rounded-full object-cover shadow-sm bg-white border border-slate-100 dark:border-slate-600">
                <div class="flex flex-col">
                    <span class="text-sm font-bold text-slate-700 dark:text-slate-300">${escapeHtml(u.name || 'Unknown')}</span>
                    <span class="text-[10px] text-slate-400">${escapeHtml(u.title || 'Employee')}</span>
                </div>
            </div>
        `;
    }).join('');
}

function selectEmployee(email, name, photo) {
    document.getElementById('lead-assignedEmployee').value = name; 
    
    const content = document.getElementById('selected-employee-content');
    content.innerHTML = `
        <img src="${photo}" class="w-6 h-6 rounded-full object-cover shadow-sm border border-slate-100">
        <span class="font-bold text-slate-700 dark:text-slate-300">${name}</span>
    `;
    
    toggleEmployeeDropdown();
}

document.addEventListener('click', (e) => {
    const container = document.getElementById('employee-dropdown-container');
    if (dropdownOpen && container && !container.contains(e.target)) {
        toggleEmployeeDropdown();
    }
});

function initLeads() {
    db.collection('sales_leads').orderBy('createdAt', 'desc').onSnapshot(snapshot => {
        leadsData = [];
        snapshot.forEach(doc => leadsData.push({ id: doc.id, ...doc.data() }));
        
        // Update all views
        document.getElementById('leads-badge').innerText = leadsData.length;
        document.getElementById('leads-badge').classList.remove('hidden');
        
        renderLeadsView();
        renderKanban();
        renderCustomersView();
        renderCharts();
        renderReports();
    }, error => {
        console.error("Error fetching leads:", error);
        Swal.fire('Database Error', 'Could not fetch data. Check Firestore rules.', 'error');
    });
}

// --- Customers Module ---
function filterCustomers() {
    renderCustomersView();
}

function renderCustomersView() {
    const tbody = document.getElementById('customers-table-body');
    if (!tbody) return;
    
    const q = (document.getElementById('customers-search') ? document.getElementById('customers-search').value.toLowerCase() : '');
    
    let customers = leadsData.filter(l => {
        let ls = l.status || 'New';
        if(ls === 'مغلق (نجاح)') ls = 'Closed (Won)';
        return ls === 'Closed (Won)';
    });
    
    if (q) {
        customers = customers.filter(l => {
            const str = `${l.company} ${l.contactName} ${l.phone} ${l.email} ${l.assignedEmployee}`.toLowerCase();
            return str.includes(q);
        });
    }
    
    tbody.innerHTML = customers.map(l => {
        return `
        <tr class="cursor-pointer group hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors" onclick="openLeadDrawer('${l.id}')">
            <td class="p-4">
                <div class="font-bold text-almaster-royal group-hover:text-almaster-navy dark:group-hover:text-white transition-colors">${escapeHtml(l.company)}</div>
                <div class="text-xs text-slate-500 mt-1">${escapeHtml(l.sector || 'N/A')}</div>
            </td>
            <td class="p-4">
                <div class="font-bold flex items-center gap-2 text-slate-700 dark:text-slate-300"><i class="fas fa-user text-slate-400"></i> ${escapeHtml(l.contactName)}</div>
                <div class="text-xs text-slate-500 mt-1"><i class="fas fa-envelope text-slate-400"></i> ${escapeHtml(l.email || '-')}</div>
            </td>
            <td class="p-4">
                <div class="font-bold flex items-center gap-2 text-slate-700 dark:text-slate-300"><i class="fas fa-phone text-slate-400"></i> ${escapeHtml(l.phone)}</div>
            </td>
            <td class="p-4">
                <span class="font-bold text-emerald-500">${escapeHtml(l.value || 0)} <span class="text-xs text-slate-500">${escapeHtml(l.currency)}</span></span>
            </td>
            <td class="p-4">
                <div class="flex items-center gap-2">
                    <div class="w-6 h-6 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-[10px] font-bold text-slate-600 dark:text-slate-300">
                        ${(l.assignedEmployee || 'A')[0].toUpperCase()}
                    </div>
                    <span class="text-sm font-bold text-slate-700 dark:text-slate-300">${escapeHtml(l.assignedEmployee)}</span>
                </div>
            </td>
            <td class="p-4">
                <div class="text-sm font-bold text-slate-700 dark:text-slate-300">
                    ${l.updatedAt ? new Date(l.updatedAt.toDate()).toLocaleDateString() : (l.createdAt ? new Date(l.createdAt.toDate()).toLocaleDateString() : '-')}
                </div>
            </td>
        </tr>
    `}).join('');
    
    if(customers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center py-12 text-slate-500">No customers found. Convert leads to "Closed (Won)" to see them here.</td></tr>';
    }
}

// --- Leads Module ---
function setLeadsView(mode) {
    leadsViewMode = mode;
    document.getElementById('leads-table-container').classList.toggle('hidden', mode === 'kanban');
    document.getElementById('leads-kanban-container').classList.toggle('hidden', mode === 'table');
    
    document.getElementById('btn-view-table').className = mode === 'table' ? 'px-3 py-1.5 rounded text-sm font-bold bg-white dark:bg-slate-700 text-almaster-royal shadow-sm' : 'px-3 py-1.5 rounded text-sm font-bold text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white';
    document.getElementById('btn-view-kanban').className = mode === 'kanban' ? 'px-3 py-1.5 rounded text-sm font-bold bg-white dark:bg-slate-700 text-almaster-royal shadow-sm' : 'px-3 py-1.5 rounded text-sm font-bold text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white';
}

function setQuickFilter(status) {
    currentLeadFilter = status;
    document.querySelectorAll('.quick-filter-btn').forEach(b => {
        b.className = 'quick-filter-btn px-4 py-2 rounded-lg text-sm font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700';
    });
    event.target.className = 'quick-filter-btn active px-4 py-2 rounded-lg text-sm font-bold bg-almaster-royal/10 text-almaster-royal';
    filterLeads();
}

function filterLeads() {
    renderLeadsView();
}

const statusColors = {
    'New': 'bg-blue-500/10 text-blue-500 border-blue-500/20',
    'Negotiation': 'bg-amber-500/10 text-amber-500 border-amber-500/20',
    'Closed (Won)': 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
    'Lost': 'bg-red-500/10 text-red-500 border-red-500/20'
};

function renderLeadsView() {
    const q = document.getElementById('leads-search').value.toLowerCase();
    const tbody = document.getElementById('leads-table-body');
    
    let filtered = leadsData.filter(l => {
        let ls = l.status || 'New';
        if(ls === 'جديد') ls = 'New';
        if(ls === 'قيد التفاوض') ls = 'Negotiation';
        if(ls === 'مغلق (نجاح)') ls = 'Closed (Won)';
        if(ls === 'مستبعد (خسارة)') ls = 'Lost';
        
        if (currentLeadFilter !== 'all' && ls !== currentLeadFilter) return false;
        
        if (q) {
            const str = `${l.company} ${l.contactName} ${l.phone} ${l.email} ${l.assignedEmployee}`.toLowerCase();
            if (!str.includes(q)) return false;
        }
        return true;
    });

    tbody.innerHTML = filtered.map(l => {
        let ls = l.status || 'New';
        if(ls === 'جديد') ls = 'New';
        if(ls === 'قيد التفاوض') ls = 'Negotiation';
        if(ls === 'مغلق (نجاح)') ls = 'Closed (Won)';
        if(ls === 'مستبعد (خسارة)') ls = 'Lost';

        const cColor = statusColors[ls] || 'bg-slate-500/10 text-slate-500 border-slate-500/20';
        
        return `
        <tr class="cursor-pointer group" onclick="openLeadDrawer('${l.id}')">
            <td>
                <div class="font-bold text-slate-900 dark:text-white group-hover:text-almaster-royal transition-colors">${escapeHtml(l.company)}</div>
                <div class="text-xs text-slate-500 mt-1">${escapeHtml(l.sector || 'N/A')}</div>
            </td>
            <td>
                <div class="font-bold flex items-center gap-2"><i class="fas fa-user text-slate-400"></i> ${escapeHtml(l.contactName)}</div>
                <div class="text-xs text-slate-500 mt-1 flex items-center gap-2">
                    <i class="fas fa-phone text-slate-400"></i> ${escapeHtml(l.phone)}
                </div>
            </td>
            <td><span class="chip border ${cColor}">${escapeHtml(ls)}</span></td>
            <td class="font-bold ${ls === 'Closed (Won)' ? 'text-emerald-500' : ''}">${escapeHtml(l.value || 0)} <span class="text-xs text-slate-500">${escapeHtml(l.currency)}</span></td>
            <td>
                <div class="flex items-center gap-2">
                    <div class="w-6 h-6 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-[10px] font-bold text-slate-600 dark:text-slate-300">
                        ${(l.assignedEmployee || 'A')[0].toUpperCase()}
                    </div>
                    <span class="text-sm">${escapeHtml(l.assignedEmployee)}</span>
                </div>
            </td>
            <td>
                <div class="text-xs ${l.nextActionDate && new Date(l.nextActionDate) < new Date() ? 'text-red-500 font-bold' : 'text-slate-500'}">
                    ${l.nextActionDate ? new Date(l.nextActionDate).toLocaleDateString() : '-'}
                </div>
            </td>
            <td class="text-center">
                <button class="text-slate-400 hover:text-almaster-royal transition-colors p-2"><i class="fas fa-chevron-right"></i></button>
            </td>
        </tr>
    `}).join('');
    
    if(filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center py-12 text-slate-500">No leads found matching your criteria.</td></tr>';
    }
}

// --- Kanban Board ---
let kanbanSortables = [];
function renderKanban() {
    const container = document.getElementById('leads-kanban-container');
    const cols = ['New', 'Negotiation', 'Closed (Won)', 'Lost'];
    
    // Clear old sortables
    kanbanSortables.forEach(s => s.destroy());
    kanbanSortables = [];
    
    container.innerHTML = cols.map(col => {
        const bgHead = col === 'Closed (Won)' ? 'border-t-emerald-500' : col === 'Lost' ? 'border-t-red-500' : col === 'Negotiation' ? 'border-t-amber-500' : 'border-t-blue-500';
        return `
        <div class="w-80 shrink-0 bg-slate-50 dark:bg-slate-800/30 rounded-2xl border-t-4 ${bgHead} border-x border-b border-slate-200 dark:border-slate-700 flex flex-col">
            <div class="p-4 flex items-center justify-between border-b border-slate-200 dark:border-slate-700 shrink-0">
                <h3 class="font-bold text-slate-800 dark:text-white">${col}</h3>
                <span class="bg-white dark:bg-slate-800 px-2 py-0.5 rounded-full text-xs font-bold text-slate-500 border border-slate-200 dark:border-slate-700 shadow-sm" id="count-${col.replace(/\W/g,'')}">0</span>
            </div>
            <div class="p-3 flex-1 flex flex-col gap-3 kanban-col overflow-y-auto custom-scrollbar" data-status="${col}" id="col-${col.replace(/\W/g,'')}">
                <!-- Cards here -->
            </div>
        </div>
    `}).join('');
    
    const colCounts = { 'New':0, 'Negotiation':0, 'Closed (Won)':0, 'Lost':0 };
    
    leadsData.forEach(l => {
        let ls = l.status || 'New';
        if(ls === 'جديد') ls = 'New';
        if(ls === 'قيد التفاوض') ls = 'Negotiation';
        if(ls === 'مغلق (نجاح)') ls = 'Closed (Won)';
        if(ls === 'مستبعد (خسارة)') ls = 'Lost';
        
        if(!cols.includes(ls)) ls = 'New';
        
        colCounts[ls]++;
        
        const card = document.createElement('div');
        card.className = "bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-xl shadow-sm cursor-grab active:cursor-grabbing hover:border-almaster-royal transition-colors";
        card.dataset.id = l.id;
        
        const color = statusColors[ls].split(' ')[1];
        
        card.innerHTML = `
            <div class="flex justify-between items-start mb-2">
                <h4 class="font-bold text-sm text-slate-800 dark:text-white">${escapeHtml(l.company)}</h4>
                <div class="w-6 h-6 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center text-[10px] font-bold text-slate-500" title="Assigned to ${escapeHtml(l.assignedEmployee)}">
                    ${(l.assignedEmployee || 'A')[0].toUpperCase()}
                </div>
            </div>
            <p class="text-xs text-slate-500 mb-3"><i class="fas fa-user mr-1"></i> ${escapeHtml(l.contactName)}</p>
            <div class="flex justify-between items-center pt-3 border-t border-slate-100 dark:border-slate-700/50">
                <span class="font-bold text-xs ${ls === 'Closed (Won)' ? 'text-emerald-500' : 'text-slate-600 dark:text-slate-300'}">${escapeHtml(l.value || 0)} ${escapeHtml(l.currency)}</span>
                ${l.nextActionDate ? `<span class="text-[10px] bg-slate-100 dark:bg-slate-700 px-2 py-1 rounded text-slate-500"><i class="far fa-calendar-alt"></i> ${new Date(l.nextActionDate).toLocaleDateString()}</span>` : ''}
            </div>
        `;
        
        // Add click to open drawer
        card.addEventListener('click', (e) => {
            if(e.target.closest('.kanban-col')) openLeadDrawer(l.id);
        });
        
        const targetCol = document.getElementById(`col-${ls.replace(/\W/g,'')}`);
        if(targetCol) targetCol.appendChild(card);
    });
    
    cols.forEach(col => {
        document.getElementById(`count-${col.replace(/\W/g,'')}`).innerText = colCounts[col];
        const el = document.getElementById(`col-${col.replace(/\W/g,'')}`);
        if (el) {
            kanbanSortables.push(new Sortable(el, {
                group: 'kanban',
                animation: 150,
                delay: 50,
                delayOnTouchOnly: true,
                onEnd: function (evt) {
                    const itemEl = evt.item;
                    const newStatus = evt.to.dataset.status;
                    const leadId = itemEl.dataset.id;
                    
                    const oldLead = leadsData.find(l => l.id === leadId);
                    if(oldLead && oldLead.status !== newStatus) {
                        db.collection('sales_leads').doc(leadId).update({ status: newStatus })
                            .then(() => showToast(`Moved to ${newStatus}`))
                            .catch(e => { console.error(e); Swal.fire('Error', 'Failed to update status', 'error'); renderKanban(); });
                    }
                },
            }));
        }
    });
}

// --- Lead Drawer ---
let currentDrawerLeadId = null;

function openLeadDrawer(id) {
    const l = leadsData.find(lead => lead.id === id);
    if(!l) return;
    currentDrawerLeadId = id;
    
    let ls = l.status || 'New';
    if(ls === 'جديد') ls = 'New';
    if(ls === 'قيد التفاوض') ls = 'Negotiation';
    if(ls === 'مغلق (نجاح)') ls = 'Closed (Won)';
    if(ls === 'مستبعد (خسارة)') ls = 'Lost';

    document.getElementById('drawer-company').innerText = l.company || 'Unknown';
    document.getElementById('drawer-contact').innerText = l.contactName + (l.contactTitle ? ` - ${l.contactTitle}` : '');
    
    const cColor = statusColors[ls] || 'bg-slate-500/10 text-slate-500 border-slate-500/20';
    document.getElementById('drawer-status').innerHTML = `<span class="chip border ${cColor}">${escapeHtml(ls)}</span>`;
    document.getElementById('drawer-value').innerText = `${l.value || 0} ${l.currency || 'SAR'}`;
    document.getElementById('drawer-agent').innerText = l.assignedEmployee || '-';
    document.getElementById('drawer-phone').innerText = l.phone || '-';
    
    // Quick Actions
    const phoneClean = l.phone ? l.phone.replace(/\D/g, '') : '';
    document.getElementById('drawer-phone-actions').innerHTML = l.phone ? `
        <a href="tel:${phoneClean}" class="w-8 h-8 rounded-full bg-blue-500/10 text-blue-500 flex items-center justify-center hover:bg-blue-500 hover:text-white transition-colors" title="Call"><i class="fas fa-phone-alt text-xs"></i></a>
        <a href="https://wa.me/${phoneClean}" target="_blank" class="w-8 h-8 rounded-full bg-emerald-500/10 text-emerald-500 flex items-center justify-center hover:bg-emerald-500 hover:text-white transition-colors" title="WhatsApp"><i class="fab fa-whatsapp text-sm"></i></a>
    ` : '';
    
    document.getElementById('drawer-project').innerText = l.projectDetails || 'No details provided.';
    
    // Timeline
    let timelineHTML = '';
    
    // Created event
    const cDate = l.createdAt ? l.createdAt.toDate() : new Date();
    timelineHTML += `
        <div class="relative pl-6">
            <div class="absolute w-3 h-3 bg-almaster-royal rounded-full -left-[7px] top-1.5 border-2 border-white dark:border-slate-900 shadow-sm"></div>
            <p class="text-xs text-slate-400 mb-1">${cDate.toLocaleString()}</p>
            <p class="text-sm font-bold text-slate-800 dark:text-white">Lead Created</p>
            <p class="text-xs text-slate-500 mt-1">Source: ${escapeHtml(l.source || 'Unknown')}</p>
        </div>
    `;
    
    // Next action
    if(l.nextActionDesc) {
        timelineHTML += `
            <div class="relative pl-6">
                <div class="absolute w-3 h-3 bg-amber-500 rounded-full -left-[7px] top-1.5 border-2 border-white dark:border-slate-900 shadow-sm"></div>
                <p class="text-xs text-amber-500 mb-1 font-bold">Follow up / Feedback</p>
                <p class="text-sm text-slate-700 dark:text-slate-300">${escapeHtml(l.nextActionDesc)}</p>
            </div>
        `;
    }

    document.getElementById('drawer-timeline').innerHTML = timelineHTML;
    
    document.getElementById('lead-drawer-overlay').classList.remove('hidden');
    // slight delay for animation
    setTimeout(() => { document.getElementById('lead-drawer').classList.add('open'); }, 10);
}

function closeLeadDrawer() {
    document.getElementById('lead-drawer').classList.remove('open');
    setTimeout(() => { document.getElementById('lead-drawer-overlay').classList.add('hidden'); }, 300);
    currentDrawerLeadId = null;
}

function editLeadFromDrawer() {
    if(currentDrawerLeadId) {
        openLeadModal(currentDrawerLeadId);
        closeLeadDrawer();
    }
}

function deleteLeadFromDrawer() {
    if(currentDrawerLeadId) {
        deleteLead(currentDrawerLeadId);
    }
}

// --- Lead CRUD ---
function openLeadModal(id = null) {
    document.getElementById('lead-form').reset();
    document.getElementById('lead-id').value = '';
    document.getElementById('modal-title').innerText = 'Add New Lead';
    
    // Reset Custom Dropdown
    document.getElementById('lead-assignedEmployee').value = '';
    document.getElementById('selected-employee-content').innerHTML = '<span class="text-slate-400">Select an employee...</span>';
    
    if (id) {
        const l = leadsData.find(x => x.id === id);
        if (l) {
            document.getElementById('modal-title').innerText = 'Edit Lead';
            document.getElementById('lead-id').value = l.id;
            
            document.getElementById('lead-company').value = l.company || '';
            document.getElementById('lead-contactName').value = l.contactName || '';
            document.getElementById('lead-contactTitle').value = l.contactTitle || '';
            document.getElementById('lead-phone').value = l.phone || '';
            document.getElementById('lead-email').value = l.email || '';
            document.getElementById('lead-country').value = l.country || '';
            document.getElementById('lead-sector').value = l.sector || '';
            
            let ls = l.status || 'New';
            if(ls === 'جديد') ls = 'New';
            if(ls === 'قيد التفاوض') ls = 'Negotiation';
            if(ls === 'مغلق (نجاح)') ls = 'Closed (Won)';
            if(ls === 'مستبعد (خسارة)') ls = 'Lost';
            document.getElementById('lead-status').value = ls;
            
            // set dynamically updated lists if they exist in the lead
            const src = document.getElementById('lead-source');
            if(l.source && !Array.from(src.options).map(o=>o.value).includes(l.source)) src.add(new Option(l.source, l.source));
            src.value = l.source || '';
            
            // Set custom dropdown UI
            document.getElementById('lead-assignedEmployee').value = l.assignedEmployee || '';
            const empContent = document.getElementById('selected-employee-content');
            if (l.assignedEmployee) {
                const uMatch = systemUsers.find(u => u.name === l.assignedEmployee || u.email === l.assignedEmployee);
                const uPhoto = uMatch ? (uMatch.profileImage || uMatch.photo) : null;
                const photoHtml = uPhoto ? `<img src="${uPhoto}" class="w-6 h-6 rounded-full object-cover shadow-sm border border-slate-100">` : `<div class="w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center text-[10px] font-bold text-slate-600">${l.assignedEmployee[0].toUpperCase()}</div>`;
                empContent.innerHTML = `${photoHtml} <span class="font-bold text-slate-700 dark:text-slate-300">${escapeHtml(l.assignedEmployee)}</span>`;
            } else {
                empContent.innerHTML = '<span class="text-slate-400">Select an employee...</span>';
            }
            
            const cur = document.getElementById('lead-currency');
            if(l.currency && !Array.from(cur.options).map(o=>o.value).includes(l.currency)) cur.add(new Option(l.currency, l.currency));
            cur.value = l.currency || 'SAR';
            
            document.getElementById('lead-value').value = l.value || '';
            document.getElementById('lead-projectDetails').value = l.projectDetails || '';
            
            if(l.firstContactDate) document.getElementById('lead-firstContactDate').value = l.firstContactDate;
            if(l.nextActionDate) document.getElementById('lead-nextActionDate').value = l.nextActionDate;
            document.getElementById('lead-nextActionDesc').value = l.nextActionDesc || '';
        }
    }
    
    document.getElementById('lead-modal').classList.remove('hidden');
}

function closeLeadModal() {
    document.getElementById('lead-modal').classList.add('hidden');
}

async function saveLead(e) {
    e.preventDefault();
    if(!document.getElementById('lead-form').checkValidity()) {
        document.getElementById('lead-form').reportValidity();
        return;
    }
    
    const id = document.getElementById('lead-id').value;
    const leadData = {
        company: document.getElementById('lead-company').value,
        contactName: document.getElementById('lead-contactName').value,
        contactTitle: document.getElementById('lead-contactTitle').value,
        phone: document.getElementById('lead-phone').value,
        email: document.getElementById('lead-email').value,
        country: document.getElementById('lead-country').value,
        source: document.getElementById('lead-source').value,
        sector: document.getElementById('lead-sector').value,
        assignedEmployee: document.getElementById('lead-assignedEmployee').value,
        status: document.getElementById('lead-status').value,
        value: Number(document.getElementById('lead-value').value || 0),
        currency: document.getElementById('lead-currency').value,
        projectDetails: document.getElementById('lead-projectDetails').value,
        firstContactDate: document.getElementById('lead-firstContactDate').value,
        nextActionDate: document.getElementById('lead-nextActionDate').value,
        nextActionDesc: document.getElementById('lead-nextActionDesc').value,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    
    try {
        if(id) {
            await db.collection('sales_leads').doc(id).update(leadData);
            showToast('Lead updated successfully');
        } else {
            leadData.createdAt = firebase.firestore.FieldValue.serverTimestamp();
            await db.collection('sales_leads').add(leadData);
            showToast('Lead created successfully');
        }
        closeLeadModal();
    } catch (err) {
        console.error(err);
        Swal.fire('Error', 'Failed to save lead. Ensure you have permissions.', 'error');
    }
}

function deleteLead(id) {
    Swal.fire({
        title: 'Are you sure?',
        text: "You won't be able to revert this lead deletion!",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        cancelButtonColor: '#64748b',
        confirmButtonText: 'Yes, delete it!'
    }).then((result) => {
        if (result.isConfirmed) {
            db.collection('sales_leads').doc(id).delete().then(() => {
                showToast('Lead deleted');
                closeLeadDrawer();
            }).catch(e => {
                console.error(e);
                Swal.fire('Error', 'Could not delete lead.', 'error');
            });
        }
    });
}

// --- Analytics ---
function renderCharts() {
    if(leadsData.length === 0) return;
    
    const isDark = document.documentElement.classList.contains('dark');
    const textColor = isDark ? '#94a3b8' : '#475569';
    const gridColor = isDark ? '#1e293b' : '#f1f5f9';

    Chart.defaults.color = textColor;
    Chart.defaults.font.family = 'Outfit, sans-serif';
    
    let totalSales = 0;
    let activeLeads = 0;
    let closedLeads = 0;
    let statusCounts = { 'New': 0, 'Negotiation': 0, 'Closed (Won)': 0, 'Lost': 0 };
    let monthlySales = { 1:0, 2:0, 3:0, 4:0, 5:0, 6:0, 7:0, 8:0, 9:0, 10:0, 11:0, 12:0 };

    leadsData.forEach(lead => {
        let ls = lead.status || 'New';
        if(ls === 'جديد') ls = 'New';
        if(ls === 'قيد التفاوض') ls = 'Negotiation';
        if(ls === 'مغلق (نجاح)') ls = 'Closed (Won)';
        if(ls === 'مستبعد (خسارة)') ls = 'Lost';

        if(statusCounts[ls] !== undefined) statusCounts[ls]++;
        else statusCounts[ls] = 1;
        
        if (ls === 'Closed (Won)') {
            totalSales += Number(lead.value || 0);
            closedLeads++;
            let d = lead.firstContactDate ? new Date(lead.firstContactDate) : (lead.createdAt ? lead.createdAt.toDate() : new Date());
            let month = d.getMonth() + 1;
            monthlySales[month] += Number(lead.value || 0);
        } else if (ls !== 'Lost') {
            activeLeads++;
        }
    });

    let conversionRate = leadsData.length > 0 ? Math.round((closedLeads / leadsData.length) * 100) : 0;
    
    document.getElementById('stat-totalSales').innerText = totalSales.toLocaleString() + ' SAR';
    document.getElementById('stat-activeLeads').innerText = activeLeads;
    document.getElementById('stat-conversion').innerText = conversionRate + '%';
    
    // Sales Line Chart
    const ctxSales = document.getElementById('salesChart').getContext('2d');
    if(chartInstances.sales) chartInstances.sales.destroy();
    
    const gradient = ctxSales.createLinearGradient(0, 0, 0, 400);
    gradient.addColorStop(0, 'rgba(37, 99, 235, 0.5)'); // royal
    gradient.addColorStop(1, 'rgba(37, 99, 235, 0.0)');
    
    const monthsEn = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    
    chartInstances.sales = new Chart(ctxSales, {
        type: 'line',
        data: {
            labels: monthsEn,
            datasets: [{
                label: 'Sales Revenue',
                data: Object.values(monthlySales),
                borderColor: '#2563eb',
                backgroundColor: gradient,
                borderWidth: 3,
                pointBackgroundColor: '#2563eb',
                pointBorderColor: isDark ? '#0b1b3f' : '#ffffff',
                pointBorderWidth: 2,
                pointRadius: 4,
                pointHoverRadius: 6,
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { display: false } },
                y: { grid: { color: gridColor } }
            },
            interaction: { mode: 'nearest', axis: 'x', intersect: false }
        }
    });

    // Status Doughnut Chart
    const ctxStatus = document.getElementById('statusChart').getContext('2d');
    if(chartInstances.status) chartInstances.status.destroy();
    
    chartInstances.status = new Chart(ctxStatus, {
        type: 'doughnut',
        data: {
            labels: ['New', 'Negotiation', 'Closed (Won)', 'Lost'],
            datasets: [{
                data: [
                    statusCounts['New'] || 0, 
                    statusCounts['Negotiation'] || 0, 
                    statusCounts['Closed (Won)'] || 0, 
                    statusCounts['Lost'] || 0
                ],
                backgroundColor: ['#3b82f6', '#f59e0b', '#10b981', '#ef4444'],
                borderWidth: 0,
                hoverOffset: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '75%',
            plugins: { legend: { position: 'bottom', labels: { padding: 20 } } }
        }
    });
}

// --- Reports ---
function generateReport() { renderReports(); }

function renderReports() {
    const dateFrom = document.getElementById('filter-date-from').value;
    const dateTo = document.getElementById('filter-date-to').value;
    const statusFilter = document.getElementById('filter-status-report').value;
    
    const tbody = document.getElementById('reports-table-body');
    
    let filtered = leadsData.filter(lead => {
        let ls = lead.status || 'New';
        if(ls === 'جديد') ls = 'New';
        if(ls === 'قيد التفاوض') ls = 'Negotiation';
        if(ls === 'مغلق (نجاح)') ls = 'Closed (Won)';
        if(ls === 'مستبعد (خسارة)') ls = 'Lost';

        if(statusFilter !== 'all' && ls !== statusFilter) return false;
        
        let contactDateStr = lead.firstContactDate ? lead.firstContactDate.split('T')[0] : null;
        if(dateFrom && contactDateStr && contactDateStr < dateFrom) return false;
        if(dateTo && contactDateStr && contactDateStr > dateTo) return false;
        
        return true;
    });
    
    let totalVal = 0;
    
    tbody.innerHTML = filtered.map((l, i) => {
        let ls = l.status || 'New';
        if(ls === 'جديد') ls = 'New';
        if(ls === 'قيد التفاوض') ls = 'Negotiation';
        if(ls === 'مغلق (نجاح)') ls = 'Closed (Won)';
        if(ls === 'مستبعد (خسارة)') ls = 'Lost';
        
        const isClosed = ls === 'Closed (Won)';
        if(isClosed) totalVal += Number(l.value || 0);
        
        const cColor = statusColors[ls] || 'bg-slate-500/10 text-slate-500 border-slate-500/20';
        const dateStr = l.firstContactDate ? new Date(l.firstContactDate).toLocaleDateString() : '-';
        
        return `
        <tr>
            <td class="font-bold text-slate-400">#${i + 1000}</td>
            <td class="font-bold">${escapeHtml(l.company)}</td>
            <td>${escapeHtml(l.assignedEmployee)}</td>
            <td>${dateStr}</td>
            <td><span class="chip border ${cColor}">${escapeHtml(ls)}</span></td>
            <td class="font-bold ${isClosed ? 'text-emerald-500' : ''}">${escapeHtml(l.value || 0)} ${escapeHtml(l.currency)}</td>
        </tr>
    `}).join('');
    
    if(filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center py-10 text-slate-500">No data available for the selected filters.</td></tr>';
    }
    
    document.getElementById('report-total-val').innerText = totalVal.toLocaleString() + ' SAR';
}

function exportToExcel() {
    const table = document.getElementById('reports-table');
    const wb = XLSX.utils.table_to_book(table, {sheet: "Sales_Report"});
    XLSX.writeFile(wb, "Sales_CRM_Report.xlsx");
}

function exportToPDF() {
    const element = document.getElementById('reports-table');
    const opt = {
        margin:       10,
        filename:     'Sales_CRM_Report.pdf',
        image:        { type: 'jpeg', quality: 0.98 },
        html2canvas:  { scale: 2 },
        jsPDF:        { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };
    html2pdf().set(opt).from(element).save();
}
