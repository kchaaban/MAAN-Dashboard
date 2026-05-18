const API_BASE = '/api';

document.addEventListener('DOMContentLoaded', () => {
    // Hide dashboard initially
    document.querySelector('.dashboard-container').style.display = 'none';

    // Create Login Modal
    const loginHtml = `
        <div id="loginModal" style="position:fixed; top:0; left:0; width:100%; height:100%; background:#0b1220; display:flex; align-items:center; justify-content:center; z-index:9999; flex-direction:column;">
            <div style="background:#1e293b; padding:40px; border-radius:12px; box-shadow:0 10px 25px rgba(0,0,0,0.5); width:320px; text-align:center;">
                <h2 style="color:white; margin-top:0; font-family: 'IBM Plex Sans Arabic', sans-serif;">تسجيل الدخول</h2>
                <p style="color:#94a3b8; font-size:14px; margin-bottom:24px;">RCMC Operations Platform</p>
                <form id="loginForm" style="display:flex; flex-direction:column; gap:16px;">
                    <input type="text" id="username" placeholder="اسم المستخدم" style="padding:12px; border-radius:6px; border:1px solid #334155; background:#0f172a; color:white;" required>
                    <input type="password" id="password" placeholder="كلمة المرور" style="padding:12px; border-radius:6px; border:1px solid #334155; background:#0f172a; color:white;" required>
                    <button type="submit" style="padding:12px; border-radius:6px; border:none; background:#3b82f6; color:white; font-weight:bold; cursor:pointer;">دخول</button>
                    <div id="loginError" style="color:#ef4444; font-size:14px; display:none;">بيانات الدخول غير صحيحة</div>
                </form>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', loginHtml);

    document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        const errorDiv = document.getElementById('loginError');
        
        try {
            const res = await fetch(`${API_BASE}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });

            if (res.ok) {
                const data = await res.json();
                localStorage.setItem('maan_token', data.token);
                localStorage.setItem('maan_role', data.role);
                document.getElementById('loginModal').style.display = 'none';
                loadSecureDataAndStart(data.token);
            } else {
                errorDiv.style.display = 'block';
            }
        } catch (err) {
            errorDiv.innerText = 'خطأ في الاتصال بالخادم';
            errorDiv.style.display = 'block';
        }
    });

    // Check if already logged in
    const token = localStorage.getItem('maan_token');
    if (token) {
        document.getElementById('loginModal').style.display = 'none';
        loadSecureDataAndStart(token);
    }
});

async function loadSecureDataAndStart(token) {
    // Show a loading indicator
    const loadingHtml = `
        <div id="loadingModal" style="position:fixed; top:0; left:0; width:100%; height:100%; background:#0b1220; display:flex; align-items:center; justify-content:center; z-index:9998; color:white; font-size:24px;">
            جاري تحميل البيانات الآمنة...
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', loadingHtml);

    try {
        const filesToLoad = ['data.js', 'assign_camps.js', 'assign_residences.js', 'service_companies.js'];
        
        for (const file of filesToLoad) {
            const res = await fetch(`${API_BASE}/data/${file}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            
            if (res.status === 401 || res.status === 403) {
                localStorage.removeItem('maan_token');
                window.location.reload();
                return;
            }

            const code = await res.text();
            
            // Inject script securely
            await new Promise((resolve, reject) => {
                const blob = new Blob([code], { type: 'application/javascript' });
                const script = document.createElement('script');
                script.src = URL.createObjectURL(blob);
                script.onload = resolve;
                script.onerror = reject;
                document.body.appendChild(script);
            });
        }

        // All secure data loaded, now load app.js
        const appScript = document.createElement('script');
        appScript.src = 'app.js';
        appScript.onload = () => {
            document.getElementById('loadingModal').remove();
            document.querySelector('.dashboard-container').style.display = 'flex';
        };
        document.body.appendChild(appScript);

    } catch (err) {
        console.error('Failed to load secure data:', err);
        alert('فشل في تحميل البيانات الآمنة. يرجى تسجيل الدخول مرة أخرى.');
        localStorage.removeItem('maan_token');
        window.location.reload();
    }
}
