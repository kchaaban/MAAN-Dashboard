const API_BASE = '/maan-dashboard/api';

function createLoginStyles() {
    const style = document.createElement('style');
    style.id = 'loginPageStyles';
    style.textContent = `
        #loginModal {
            position: fixed;
            inset: 0;
            z-index: 9999;
            direction: rtl;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            font-family: 'IBM Plex Sans Arabic', sans-serif;
            color: #fff;
            background: #fff;
        }

        .login-phone-bar {
            position: relative;
            flex: 0 0 clamp(64px, 11vh, 102px);
            height: clamp(64px, 11vh, 102px);
            background: #fff;
            color: #3f3f46;
            direction: ltr;
            font-family: Arial, Helvetica, sans-serif;
            font-size: 1.35rem;
            font-weight: 700;
        }

        .login-phone-time {
            position: absolute;
            top: 0.2rem;
            left: 0.9rem;
        }

        .login-phone-notch {
            position: absolute;
            top: 1.05rem;
            left: 50%;
            width: 8.3rem;
            height: 0.45rem;
            border-radius: 999px;
            background: #111;
            transform: translateX(-50%);
        }

        .login-phone-icons {
            position: absolute;
            top: 0.25rem;
            right: 1rem;
            display: flex;
            align-items: center;
            gap: 0.45rem;
            font-size: 1.15rem;
        }

        .login-phone-language {
            position: absolute;
            right: 1.05rem;
            bottom: 0.25rem;
            width: 1.45rem;
            height: 1.45rem;
            border: 2px solid #333;
            border-radius: 0.28rem;
            display: grid;
            place-items: center;
            font-size: 0.78rem;
            line-height: 1;
        }

        .login-shell {
            position: relative;
            width: 100%;
            flex: 1 1 auto;
            min-height: 0;
            background-image: linear-gradient(180deg, rgba(0, 91, 52, 0.55) 0%, rgba(0, 91, 52, 0.66) 44%, rgba(0, 101, 58, 0.93) 100%), url('bus-image.png');
            background-size: cover;
            background-position: center top;
            background-repeat: no-repeat;
        }

        .login-shell::before {
            content: '';
            position: absolute;
            inset: 0;
            background: linear-gradient(90deg, rgba(0, 83, 47, 0.18) 0%, rgba(0, 65, 44, 0.22) 46%, rgba(0, 55, 36, 0.54) 100%);
            pointer-events: none;
        }

        .login-shell::after {
            content: '';
            position: absolute;
            inset: 0;
            background: linear-gradient(180deg, rgba(8, 20, 14, 0.02) 0%, rgba(8, 20, 14, 0.04) 42%, rgba(0, 92, 52, 0.42) 100%);
            pointer-events: none;
        }

        .login-brand-bar,
        .login-main,
        .login-bottom-strip {
            position: relative;
            z-index: 1;
        }

        .login-brand-bar {
            position: absolute;
            top: 3.1rem;
            left: 10.6vw;
            display: flex;
            flex-direction: row-reverse;
            justify-content: flex-start;
            align-items: center;
            gap: 1.55rem;
            padding: 0;
        }

        .login-brand-block {
            display: flex;
            align-items: center;
            gap: 0.9rem;
            padding-left: 1.1rem;
            border-left: 1px solid rgba(255, 255, 255, 0.35);
        }

        .login-brand-block img {
            height: 3.75rem;
            width: auto;
            object-fit: contain;
            filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.18));
        }

        .login-brand-copy {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 0.15rem;
            color: rgba(255, 255, 255, 0.98);
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.24);
            line-height: 1.06;
        }

        .login-brand-copy .arabic {
            font-size: 1.08rem;
            font-weight: 700;
        }

        .login-brand-copy .english {
            font-size: 0.76rem;
            letter-spacing: 0;
            opacity: 0.9;
        }

        .login-main {
            position: absolute;
            inset: 0;
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(430px, 39vw);
            align-items: center;
            gap: 3.7rem;
            padding: 7.5rem 8vw 3.65rem 8vw;
        }

        .login-hero-copy {
            align-self: end;
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            justify-content: flex-end;
            gap: 0.55rem;
            padding: 0 0 1.7rem 0;
            max-width: 52rem;
            text-shadow: 0 3px 18px rgba(0, 0, 0, 0.34);
        }

        .login-hero-title {
            display: inline-flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 0.35rem;
            font-size: clamp(3.85rem, 7.25vw, 6.75rem);
            font-weight: 800;
            line-height: 0.92;
            letter-spacing: 0;
            color: #fff;
        }

        .login-hero-title span {
            display: inline-block;
            padding: 0.06rem 0.55rem 0.34rem;
            background: linear-gradient(180deg, #76c147 0%, #63b83a 100%);
            color: #fff;
            border-radius: 0.12rem;
        }

        .login-hero-year {
            display: inline-flex;
            align-items: center;
            gap: 0.75rem;
            font-size: clamp(1.5rem, 2.8vw, 2.35rem);
            font-weight: 400;
            line-height: 1;
            color: rgba(255, 255, 255, 0.98);
        }

        .login-hero-year::before,
        .login-hero-year::after {
            content: '';
            width: 4.2rem;
            height: 1px;
            background: rgba(255, 255, 255, 0.72);
        }

        .login-bottom-strip {
            position: relative;
            display: flex;
            justify-content: flex-start;
            align-items: flex-end;
            width: min(100%, 29.4rem);
            padding: 6.1rem 0 0.25rem;
        }

        .login-bottom-strip::before {
            content: '';
            position: absolute;
            left: 0;
            right: 0;
            top: 5.55rem;
            height: 2px;
            background: rgba(214, 184, 104, 0.88);
        }

        .login-bottom-strip::after {
            content: 'المشغل (تحالف)';
            position: absolute;
            top: 5.18rem;
            left: 50%;
            transform: translateX(-50%);
            padding: 0.18rem 1.05rem 0.22rem;
            border-radius: 999px;
            background: #c4a150;
            color: #fff;
            font-size: 0.72rem;
            font-weight: 800;
            line-height: 1;
            white-space: nowrap;
        }

        .login-partner-strip {
            position: relative;
            z-index: 1;
            display: block;
            width: 100%;
            height: auto;
            opacity: 0.98;
        }

        .login-form-panel {
            justify-self: end;
            width: min(100%, 39vw);
            min-width: 390px;
            min-height: min(74vh, 42.5rem);
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 3.2rem 4.4vw;
            margin-top: 2.05rem;
            border-radius: 54px;
            background: linear-gradient(180deg, rgba(0, 67, 42, 0.55) 0%, rgba(0, 51, 32, 0.78) 100%);
            backdrop-filter: blur(8px);
            box-shadow: 0 20px 48px rgba(0, 0, 0, 0.16);
        }

        .login-form-card {
            width: 100%;
            max-width: 28rem;
            text-align: center;
        }

        .login-form-card h2 {
            margin: 0 0 1.65rem;
            color: #fff;
            font-size: clamp(1.9rem, 2.2vw, 2.65rem);
            font-weight: 600;
            line-height: 1.12;
        }

        .login-form-card .login-subtitle {
            display: none;
            margin: 0 0 1.7rem;
            color: rgba(255, 255, 255, 0.8);
            font-size: 0.98rem;
            line-height: 1.55;
        }

        #loginForm {
            display: flex;
            flex-direction: column;
            gap: 0.95rem;
        }

        .login-input {
            width: 100%;
            height: 3.35rem;
            padding: 0 1.15rem;
            border: none;
            border-radius: 10px;
            background: #ffffff;
            color: #122033;
            font: inherit;
            font-size: 1rem;
            outline: none;
            box-shadow: 0 8px 20px rgba(0, 0, 0, 0.12);
        }

        .login-input::placeholder {
            color: #97a2b5;
        }

        .login-input:focus {
            box-shadow: 0 0 0 3px rgba(118, 193, 71, 0.22), 0 8px 20px rgba(0, 0, 0, 0.12);
        }

        .login-button {
            height: 3.45rem;
            border: none;
            border-radius: 10px;
            background: linear-gradient(180deg, #d1b15f 0%, #bf9d4d 100%);
            color: #fff;
            font: inherit;
            font-size: 1.12rem;
            font-weight: 700;
            cursor: pointer;
            box-shadow: 0 12px 22px rgba(125, 93, 31, 0.24);
            transition: transform 0.18s ease, filter 0.18s ease;
        }

        .login-button:hover,
        .login-button:focus-visible {
            transform: translateY(-1px);
            filter: brightness(1.03);
        }

        .login-note {
            margin-top: 1.1rem;
            color: rgba(255, 255, 255, 0.92);
            font-size: 0.94rem;
            line-height: 1.5;
        }

        #loginError {
            color: #fecaca;
            font-size: 0.95rem;
            display: none;
            text-align: center;
            margin-top: 0.1rem;
        }

        #loadingModal {
            position: fixed;
            inset: 0;
            background: rgba(8, 15, 26, 0.95);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 9998;
            color: white;
            font-size: 1.5rem;
            text-align: center;
            padding: 2rem;
        }

        @media (max-width: 1200px) {
            .login-main {
                grid-template-columns: minmax(0, 1fr) minmax(330px, 40vw);
                padding-top: 6.3rem;
                padding-inline: 4vw;
            }

            .login-hero-title {
                font-size: clamp(2.9rem, 6vw, 5.3rem);
            }
        }

        @media (max-width: 900px) {
            .login-main {
                position: relative;
                grid-template-columns: 1fr;
                padding: 1.1rem 1rem 1.25rem;
                gap: 1.25rem;
            }

            .login-brand-bar {
                padding: 1rem 1rem 0;
            }

            .login-form-panel {
                justify-self: stretch;
                width: 100%;
                min-width: 0;
                min-height: auto;
                margin-top: 0;
                padding: 1.5rem 1.25rem;
                border-radius: 28px;
            }

            .login-hero-copy {
                align-self: start;
                padding: 8rem 0.2rem 0.8rem;
            }

            .login-bottom-strip {
                padding: 0 0.2rem 0.25rem;
            }
        }

        @media (max-width: 640px) {
            .login-brand-bar {
                flex-direction: column;
                align-items: flex-end;
                gap: 0.7rem;
            }

            .login-brand-block {
                padding-left: 0;
                border-left: none;
            }

            .login-brand-block img {
                height: 2.8rem;
            }

            .login-hero-copy {
                padding-top: 6.8rem;
            }

            .login-hero-title {
                font-size: clamp(2.35rem, 11vw, 4rem);
            }

            .login-hero-year {
                font-size: clamp(1.05rem, 4.8vw, 1.6rem);
            }

            .login-form-panel {
                padding: 1.2rem 1rem;
            }
        }
    `;
    return style;
}

function createLoginHtml() {
    return `
        <div id="loginModal" aria-label="تسجيل الدخول">
            <div class="login-phone-bar" aria-hidden="true">
                <span class="login-phone-time">4:36</span>
                <span class="login-phone-notch"></span>
                <span class="login-phone-icons">◆ ▌</span>
                <span class="login-phone-language">文</span>
            </div>
            <div class="login-shell">
                <div class="login-brand-bar">
                    <div class="login-brand-block">
                        <div class="login-brand-copy">
                            <div class="arabic">المركز العام للنقل</div>
                            <div class="english">GENERAL TRANSPORT CENTER</div>
                        </div>
                        <img src="gtc-logo.jpeg" alt="GTC">
                    </div>
                    <img src="rcmc-logo.jpeg" alt="RCMC" style="height:3.55rem; width:auto; object-fit:contain; filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.18));">
                </div>

                <div class="login-main">
                    <div>
                        <div class="login-hero-copy">
                            <div class="login-hero-title">الإركاب <span>الذكي</span></div>
                            <div class="login-hero-year">حج 1447هـ</div>
                        </div>
                        <div class="login-bottom-strip">
                            <img class="login-partner-strip" src="alliance-logo.png" alt="شعارات تحالف المشغلين">
                        </div>
                    </div>

                    <div class="login-form-panel">
                        <div class="login-form-card">
                            <h2>تسجيل الدخول</h2>
                            <p class="login-subtitle">الرجاء إدخال اسم المستخدم وكلمة المرور للوصول إلى لوحة المتابعة.</p>
                            <form id="loginForm">
                                <input class="login-input" type="text" id="username" placeholder="اسم المستخدم" autocomplete="username" required>
                                <input class="login-input" type="password" id="password" placeholder="كلمة المرور" autocomplete="current-password" required>
                                <button class="login-button" type="submit">الدخول</button>
                                <div id="loginError">بيانات الدخول غير صحيحة</div>
                            </form>
                            <div class="login-note">عند الضغط على تسجيل الدخول فأنت توافق على سياسة الخصوصية.</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

document.addEventListener('DOMContentLoaded', () => {
    const dashboardContainer = document.querySelector('.dashboard-container');
    if (dashboardContainer) {
        dashboardContainer.style.display = 'none';
    }

    document.head.appendChild(createLoginStyles());
    document.body.insertAdjacentHTML('beforeend', createLoginHtml());

    document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        const errorDiv = document.getElementById('loginError');

        try {
            const res = await fetch(API_BASE + '/login', {
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

    const token = localStorage.getItem('maan_token');
    if (token) {
        document.getElementById('loginModal').style.display = 'none';
        loadSecureDataAndStart(token);
    }

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            localStorage.removeItem('maan_token');
            localStorage.removeItem('maan_role');
            window.location.reload();
        });
    }
});

function loadSecureDataAndStart(token) {
    // Wait for CSV_DATA to be defined (data.js is large, might take time)
    const maxWaitTime = 30000; // 30 seconds
    const startTime = Date.now();

    const checkDataAndLoad = () => {
        console.log('Checking for CSV_DATA...', typeof window.CSV_DATA, Date.now() - startTime + 'ms');
        if (typeof CSV_DATA !== 'undefined') {
            console.log('✓ CSV_DATA found, size:', CSV_DATA.length);
            // Data is loaded, show dashboard and app
            const container = document.querySelector('.dashboard-container');
            if (container) {
                container.style.display = 'flex';
            }

            // Load app.js
            const appScript = document.createElement('script');
            appScript.src = 'app.js';
            appScript.onload = () => {
                console.log('app.js loaded, calling initializeDashboardApp');
                // DOMContentLoaded won't fire since page is already loaded
                // So we call the init function directly
                if (typeof initializeDashboardApp === 'function') {
                    initializeDashboardApp();
                }
            };
            appScript.onerror = () => {
                alert('تعذر تحميل التطبيق. يرجى تحديث الصفحة.');
            };
            document.body.appendChild(appScript);
        } else if (Date.now() - startTime < maxWaitTime) {
            // Data not ready yet, wait a bit more
            setTimeout(checkDataAndLoad, 100);
        } else {
            // Timeout waiting for data
            alert('فشل تحميل بيانات التطبيق. يرجى تحديث الصفحة.');
        }
    };

    checkDataAndLoad();
}
