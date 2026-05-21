// Global State
let rawData = [];
let filteredData = [];
let contextFilteredData = [];
let planTypeBaseData = [];
let map;
let routeLayerGroup;
let periodChartInstance = null;
let transportChartInstances = [];
let entranceChartInstance = null;
let pathChartInstance = null;
let districtChartInstance = null;
let residenceAssignmentChartInstances = [];
let completionSummaryChartInstances = [];
let geojsonLookup = {};
let selectedPlanId = null;
let selectedEntranceName = null;
let selectedPathName = null;
let selectedDistrict = null;
let districtsLayerGroup;
let lightMapLayer = null;
let darkMapLayer = null;
let dashboardFrameId = null;
let assignmentTotalsByCenter = new Map();
let assignmentTotalsByNumber = new Map();
let residenceAssignmentKeys = new Set();
let residenceAssignmentRecords = [];
let campAssignmentRecords = [];
let campAssignmentStats = null;
let assignCampRows = [];
let assignmentTotalsFromCamps = { companyMetrics: new Map(), centerMetrics: new Map() };
let selectedServiceCompanies = new Set();
let selectedServiceCenters = new Set();
let selectedResidenceMixFilter = 'all';
const entityTableState = {
    company: { search: '', sortKey: 'completion', sortDirection: 'desc' },
    center: { search: '', sortKey: 'completion', sortDirection: 'desc' }
};
let selectedPlanTypes = new Set(['تروية']);
let serviceCompaniesCatalog = [];
let serviceCompanyNameByKey = new Map();
let serviceCenterNamesByKey = new Map();
let plansCsvLoadSequence = 0;
let activePlansCsvSource = '';
let dashboardResizeFrameId = null;
const TOP_RING_CANVAS_SIZE = 52;
const RESIDENCE_RING_CANVAS_SIZE = TOP_RING_CANVAS_SIZE;
const TRANSPORT_RING_CANVAS_SIZE = TOP_RING_CANVAS_SIZE;

const MAP_RENDER_LIMIT = 300;
const PLAN_LIST_LIMIT = 50;
const MAP_FIT_MAX_ZOOM = 16;
const MAP_LABEL_MIN_ZOOM = 15;
const ASSIGNMENT_RENDER_LIMIT = 350;
const MAP_DETAIL_LABEL_LIMIT = 18;
const SIDEBAR_WIDTH_STORAGE_KEY = 'dashboard-sidebar-width';
const RIGHT_PANEL_WIDTH_STORAGE_KEY = 'dashboard-right-panel-width';
const CHART_POPOUT_WINDOW_FEATURES = 'noopener,noreferrer,width=1200,height=760';
const AUTH_TOKEN_STORAGE_KEY = 'maan-dashboard-auth-token';
const AUTH_ROLE_STORAGE_KEY = 'maan-dashboard-auth-role';
const THEME_STORAGE_KEY = 'dashboard-theme';
const DISTRICT_COLOR_PALETTE = [
    "#2A9D90",
    "#4EC9B9",
    "#EBC468",
    "#C25858",
    "#791C2A",
    "#7D7150",
    "#A88047",
    "#1D5751",
    "#791C2A",
    "#CAAB79"
];

// Helper to normalize Arabic text for matching (e.g., 'حى' to 'حي', 'ه' to 'ة')
function normalizeArabic(text) {
    if (!text) return '';
    return text.trim()
        .replace(/ى/g, 'ي')
        .replace(/ه(?=\s|$)/g, 'ة')
        .replace(/أ/g, 'ا')
        .replace(/إ/g, 'ا');
}

function getDistrictNameFromFeature(feature) {
    return feature?.properties?.Discription_AR
        || feature?.properties?.discription
        || feature?.properties?.Name
        || "";
}

function hashString(value) {
    return String(value || "").split("").reduce((hash, char) => {
        return ((hash << 5) - hash) + char.charCodeAt(0);
    }, 0);
}

function getDistrictBaseColor(districtName) {
    const index = Math.abs(hashString(normalizeArabic(districtName))) % DISTRICT_COLOR_PALETTE.length;
    return DISTRICT_COLOR_PALETTE[index];
}

function buildDistrictMapStats(rows) {
    const stats = new Map();
    let maxPilgrims = 0;

    rows.forEach(row => {
        const districtName = row["start_point_district"];
        if (!districtName) return;

        const key = normalizeArabic(districtName);
        const current = stats.get(key) || {
            name: districtName,
            pilgrims: 0,
            plans: 0
        };

        current.pilgrims += toNumber(row["number_of_haj"]);
        current.plans += 1;
        stats.set(key, current);
        maxPilgrims = Math.max(maxPilgrims, current.pilgrims);
    });

    return { stats, maxPilgrims };
}

function getDistrictPolygonStyle(districtName, districtStats, maxPilgrims) {
    const isSelected = selectedDistrict && normalizeArabic(selectedDistrict) === normalizeArabic(districtName);
    const color = getDistrictBaseColor(districtName);
    const intensity = maxPilgrims > 0 ? Math.min(1, districtStats.pilgrims / maxPilgrims) : 0;

    return {
        color,
        weight: isSelected ? 4 : 1.6,
        opacity: isSelected ? 0.95 : 0.78,
        fillColor: color,
        fillOpacity: isSelected ? 0.58 : 0.22 + (intensity * 0.24),
        dashArray: isSelected ? null : "5 4",
        className: isSelected ? "district-polygon district-polygon-selected" : "district-polygon"
    };
}

// Parse camp label to extract numerator and denominator (e.g., "1/608" → {num: 1, denom: 608})
function parseCampLabel(label) {
    const safeLabel = String(label || '').trim();
    if (!safeLabel || !safeLabel.includes('/')) return null;
    const parts = safeLabel.split('/');
    return {
        num: String(parts[0] || '').trim(),
        denom: String(parts[1] || '').trim()
    };
}

function calculateCampAssignmentStats(rows) {
    const campNumerators = new Set();
    const campDenominators = new Set();
    const uniqueCampLabels = new Set();
    const serviceCenters = new Set();
    const allocatedByAssignment = new Map();
    let totalCampAssignments = 0;

    rows.forEach(d => {
        const campLabel = d['camp_label'];
        if (campLabel) {
            uniqueCampLabels.add(String(campLabel).trim());
            const parsed = parseCampLabel(campLabel);
            if (parsed && parsed.num && parsed.denom) {
                campNumerators.add(parsed.num);
                campDenominators.add(parsed.denom);
                totalCampAssignments++;
            }
        }

        const centerNumber = d['office_number'] ?? d['owner_office_number'];
        if (centerNumber !== undefined && centerNumber !== null && String(centerNumber).trim()) {
            const company = d['service_company_name'] ?? d['owner_company_name'] ?? '';
            serviceCenters.add(centerKey(company, centerNumber));
        }

        const assignmentKey = getAssignmentRecordKey(d);
        if (assignmentKey && !assignmentKey.endsWith('|')) {
            allocatedByAssignment.set(
                assignmentKey,
                Math.max(allocatedByAssignment.get(assignmentKey) || 0, getAllocatedPilgrims(d))
            );
        }
    });

    const totalPilgrims = Array.from(allocatedByAssignment.values()).reduce((sum, value) => sum + value, 0);

    return {
        numeratorCount: campNumerators.size,
        denominatorCount: campDenominators.size,
        totalAssignments: totalCampAssignments,
        uniqueCampCount: uniqueCampLabels.size,
        serviceCenterCount: serviceCenters.size,
        totalPilgrims,
        allNumerators: Array.from(campNumerators).sort(),
        allDenominators: Array.from(campDenominators).sort()
    };
}

// Count unique camps from assign_camps.js for the selected company/service center
// Includes all camp label formats (numeric like 1/204 and non-numeric like C/206)
function getCampCountFromAssignCamps() {
    const { company, owner } = getSelectedCompanyAndOwner();
    const camps = new Set();

    // Count unique camps from assign_camps data
    assignCampRows.forEach(row => {
        const campLabel = row['camp_label'];
        if (campLabel && String(campLabel).trim()) {
            const companyName = row['service_company_name'] ?? '';
            const centerNumber = row['office_number'] ?? '';

            // If no company/center filter selected, count all
            // Otherwise, only count those matching the filter
            if (company.size === 0 && owner.size === 0) {
                // No filter: count all camps (including C/206 and other formats)
                camps.add(String(campLabel).trim());
            } else {
                // Filter applied: only count matching camps
                if (matchesCompanyOwnerFilters(companyName, centerNumber, company, owner)) {
                    camps.add(String(campLabel).trim());
                }
            }
        }
    });

    return camps.size;
}

// Count unique service centers from assign_camps.js for the selected company/service center
function getServiceCenterCountFromAssignCamps() {
    const { company, owner } = getSelectedCompanyAndOwner();
    const serviceCenters = new Set();

    // Count unique service centers from assign_camps data
    assignCampRows.forEach(row => {
        const centerNumber = row['office_number'] ?? row['service_center_number'];
        if (centerNumber !== undefined && centerNumber !== null && String(centerNumber).trim()) {
            const companyName = row['service_company_name'] ?? '';

            // If no company/center filter selected, count all
            // Otherwise, only count those matching the filter
            if (company.size === 0 && owner.size === 0) {
                // No filter: count all service centers
                serviceCenters.add(centerKey(companyName, centerNumber));
            } else {
                // Filter applied: only count matching centers
                if (matchesCompanyOwnerFilters(companyName, centerNumber, company, owner)) {
                    serviceCenters.add(centerKey(companyName, centerNumber));
                }
            }
        }
    });

    return serviceCenters.size;
}

// Calculate assignment statistics from the current filters. For the Tarwiya KPI,
// the denominator is the Tarwiya movement total: Tarwiya + Taseed Tarwiya
// (uses company filters if selected, otherwise all companies).
function getCampAssignmentStats() {
    const { company, owner } = getSelectedCompanyAndOwner();
    const hasCompanySelection = company.size > 0 || owner.size > 0;

    // Filtered rows for assignment stats (apply company/owner filters)
    const filteredRows = planTypeBaseData.filter(row => (
        isTarwiyaKpiTotalPlanType(row)
        && matchesCompanyOwnerFilters(
            row['owner_company_name'],
            row['owner_office_number'],
            company,
            owner
        )
    ));

    // Total rows: apply filters if company is selected, otherwise use all
    const totalRows = hasCompanySelection
        ? filteredRows  // Use filtered rows if company/center selected
        : planTypeBaseData.filter(row => isTarwiyaKpiTotalPlanType(row));  // Use all Tarwiya/Taseed if no selection

    const stats = calculateCampAssignmentStats(filteredRows);

    // Get denominator from assign_camps.js instead of from CSV
    const assignCampsServiceCenterCount = getServiceCenterCountFromAssignCamps();

    return {
        ...stats,
        serviceCenterCount: assignCampsServiceCenterCount,  // Changed: now from assign_camps.js
        totalPilgrims: calculateKpiTotalPilgrims(totalRows)
    };
}


function getLoginApiPath() {
    return window.location.pathname.startsWith('/maan-dashboard')
        ? '/maan-dashboard/api/login'
        : '/maan-dashboard/api/login';
}

function setCookieValue(key, value, maxAgeSeconds = 60 * 60 * 24 * 30) {
    document.cookie = encodeURIComponent(key) + "=" + encodeURIComponent(value) + "; path=/; max-age=" + maxAgeSeconds + "; SameSite=Lax";
}

function getCookieValue(key) {
    const encodedKey = encodeURIComponent(key) + '=';
    const cookieParts = document.cookie ? document.cookie.split('; ') : [];
    for (const part of cookieParts) {
        if (part.startsWith(encodedKey)) {
            return decodeURIComponent(part.slice(encodedKey.length));
        }
    }
    return '';
}

function removeCookieValue(key) {
    document.cookie = encodeURIComponent(key) + "=; path=/; max-age=0; SameSite=Lax";
}

function setPersistentValue(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch (error) {
        // Ignore storage exceptions and continue with cookie fallback.
    }
    setCookieValue(key, value);
}

function getPersistentValue(key) {
    try {
        const value = localStorage.getItem(key);
        if (value !== null && value !== undefined) return value;
    } catch (error) {
        // Ignore storage exceptions and continue with cookie fallback.
    }
    return getCookieValue(key);
}

function removePersistentValue(key) {
    try {
        localStorage.removeItem(key);
    } catch (error) {
        // Ignore storage exceptions and continue with cookie fallback.
    }
    removeCookieValue(key);
}

function showLoginScreen(message = '') {
    document.body.classList.add('auth-required');
    document.body.classList.remove('authenticated');
    const loginScreen = document.getElementById('loginScreen');
    const dashboardApp = document.getElementById('dashboardApp');
    const loginError = document.getElementById('loginError');

    if (loginScreen) loginScreen.hidden = false;
    if (dashboardApp) dashboardApp.hidden = true;
    if (loginError) {
        loginError.textContent = message;
        loginError.hidden = !message;
    }
}

function showDashboard(role = '') {
    document.body.classList.remove('auth-required');
    document.body.classList.add('authenticated');
    const loginScreen = document.getElementById('loginScreen');
    const dashboardApp = document.getElementById('dashboardApp');
    const roleLabel = document.getElementById('userRoleLabel');

    if (loginScreen) loginScreen.hidden = true;
    if (dashboardApp) dashboardApp.hidden = false;
    if (roleLabel) roleLabel.textContent = role || 'المشرف';
}

function logout() {
    removePersistentValue(AUTH_TOKEN_STORAGE_KEY);
    removePersistentValue(AUTH_ROLE_STORAGE_KEY);
    window.location.reload();
}

async function handleLoginSubmit(event) {
    event.preventDefault();
    const usernameInput = document.getElementById('loginUsername');
    const passwordInput = document.getElementById('loginPassword');
    const submitBtn = document.getElementById('loginSubmitBtn');
    const loginError = document.getElementById('loginError');
    const username = usernameInput?.value.trim() || '';
    const password = passwordInput?.value || '';

    if (loginError) loginError.hidden = true;
    if (submitBtn) submitBtn.disabled = true;

    try {
        const response = await fetch(getLoginApiPath(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        if (!response.ok) throw new Error('login-failed');
        const payload = await response.json();
        const authToken = String(payload.token || payload.accessToken || payload.jwt || "authenticated");
        const authRole = String(payload.role || payload.userRole || "المشرف");
        setPersistentValue(AUTH_TOKEN_STORAGE_KEY, authToken);
        setPersistentValue(AUTH_ROLE_STORAGE_KEY, authRole);
        showDashboard(authRole);
        initializeDashboardApp();
    } catch (error) {
        if (loginError) {
            loginError.textContent = 'بيانات الدخول غير صحيحة';
            loginError.hidden = false;
        }
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
}

let dashboardInitialized = false;

async function initializeDashboardApp() {
    if (dashboardInitialized) return;
    dashboardInitialized = true;
    initResizablePanels();
    initEntityTableColumnAutosize();
    initChartViewer();
    initTheme();
    initMap();

    // Restore cached CSV data if available (persistent across page refreshes)
    try {
        const cachedData = await getCachedPlansCsv();
        if (cachedData && cachedData.csvText) {
            window.CSV_DATA = cachedData.csvText;
            console.log('Restored cached CSV data from:', cachedData.source || 'unknown');
            // Store the source to indicate this is not the default data.js
            window.PLANS_CSV_SOURCE = cachedData.source || 'cached upload';
        }
    } catch (error) {
        console.warn('Could not restore cached CSV data:', error);
        // Continue with default data.js CSV
    }

    loadData();
    setupEventListeners();
}

// Initialize Application
document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    document.getElementById('loginForm')?.addEventListener('submit', handleLoginSubmit);
    document.getElementById('logoutBtn')?.addEventListener('click', logout);

    const token = getPersistentValue(AUTH_TOKEN_STORAGE_KEY);
    const role = getPersistentValue(AUTH_ROLE_STORAGE_KEY);
    if (token) {
        showDashboard(role);
        await initializeDashboardApp();
    } else {
        showLoginScreen();
    }
});

function getCellContentWidth(cell) {
    if (!cell) return 0;

    const nested = cell.querySelector('strong, span, .completion-badge');
    const contentWidth = nested ? nested.scrollWidth : cell.scrollWidth;
    const style = window.getComputedStyle(cell);
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    return Math.ceil(contentWidth + padding + 18);
}

function fitEntityTableColumn(table, columnIndex) {
    if (!table || columnIndex < 0) return;

    let colgroup = table.querySelector('colgroup');
    if (!colgroup) {
        colgroup = document.createElement('colgroup');
        const headers = Array.from(table.querySelectorAll('thead th'));
        const tableWidth = table.getBoundingClientRect().width;
        headers.forEach(header => {
            const col = document.createElement('col');
            col.style.width = Math.max(header.getBoundingClientRect().width || (tableWidth / headers.length), 48) + 'px';
            colgroup.appendChild(col);
        });
        table.prepend(colgroup);
    }

    const columns = Array.from(colgroup.children);
    const selector = ':nth-child(' + (columnIndex + 1) + ')';
    const cells = [
        ...table.querySelectorAll('thead tr > *' + selector),
        ...table.querySelectorAll('tbody tr > *' + selector)
    ];
    const nextWidth = Math.max(48, ...cells.map(getCellContentWidth));
    columns[columnIndex].style.width = nextWidth + 'px';

    const totalWidth = columns.reduce((sum, col) => sum + (parseFloat(col.style.width) || 0), 0);
    table.style.width = Math.max(totalWidth, table.parentElement?.clientWidth || 0) + 'px';
}

function initEntityTableColumnAutosize() {
    document.querySelectorAll('.entity-table').forEach(table => {
        table.querySelectorAll('thead th').forEach((header, index) => {
            header.title = 'انقر مرتين لتوسيع العمود';
            header.addEventListener('dblclick', event => {
                event.preventDefault();
                fitEntityTableColumn(table, index);
            });
        });
    });
}

const barValueLabelPlugin = {
    id: 'barValueLabelPlugin',
    afterDatasetsDraw(chart, args, options = {}) {
        const ctx = chart.ctx;
        const color = options.color || getThemeColors().text;
        const fontSize = options.fontSize || 10;

        ctx.save();
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.font = `800 ${fontSize}px Inter, IBM Plex Sans Arabic, sans-serif`;

        chart.data.datasets.forEach((dataset, datasetIndex) => {
            const meta = chart.getDatasetMeta(datasetIndex);
            if (meta.hidden) return;

            meta.data.forEach((element, index) => {
                const value = Number(dataset.data[index]) || 0;
                if (!value) return;

                const position = element.tooltipPosition();
                const y = Math.max(chart.chartArea.top + fontSize + 2, position.y - 4);
                ctx.fillText(value.toLocaleString(), position.x, y);
            });
        });

        ctx.restore();
    }
};

function getClickedXAxisLabel(chart, event) {
    if (!chart?.scales?.x || !chart.chartArea) return null;

    const position = Number.isFinite(event?.x) && Number.isFinite(event?.y)
        ? { x: event.x, y: event.y }
        : Chart.helpers.getRelativePosition(event, chart);
    const xScale = chart.scales.x;
    const axisTop = Math.min(chart.chartArea.bottom, xScale.top || chart.chartArea.bottom) - 10;
    const axisBottom = Math.max(chart.height, xScale.bottom || chart.height);
    const isInAxisZone = position.y >= axisTop && position.y <= axisBottom;
    const isNearXAxis = position.x >= xScale.left - 24 && position.x <= xScale.right + 24;
    if (!isInAxisZone || !isNearXAxis) return null;

    let nearestIndex = -1;
    let nearestDistance = Infinity;
    chart.data.labels.forEach((_, index) => {
        const tickX = xScale.getPixelForTick(index);
        const distance = Math.abs(position.x - tickX);
        if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestIndex = index;
        }
    });

    return chart.data.labels[nearestIndex] || null;
}

function setChartAxisLabelCursor(event, chart) {
    const canvas = chart?.canvas;
    if (!canvas) return;
    canvas.style.cursor = getClickedXAxisLabel(chart, event) ? 'pointer' : 'default';
}

function getChartTitleFromElement(element) {
    if (!element) return 'Chart';

    const cardTitle = element.closest('.chart-card, .sidebar-chart-section, .map-overlay-card')
        ?.querySelector('h3')
        ?.textContent
        ?.trim();
    if (cardTitle) return cardTitle;

    const ringTitle = element.closest('.progress-ring-item, .residence-assignment-ring')
        ?.querySelector('strong')
        ?.textContent
        ?.trim();
    if (ringTitle) return ringTitle;

    return element.id || 'Chart';
}

async function openChartElementInNewPage(element) {
    if (!element) return;

    let imageData = '';
    const isCanvas = element.tagName?.toLowerCase() === 'canvas';
    const isPlotly = element.classList?.contains('plotly-chart');

    if (isPlotly && typeof Plotly !== 'undefined') {
        imageData = await Plotly.toImage(element, { format: 'png', width: 1400, height: 860 });
    } else if (isCanvas) {
        const chart = (typeof Chart !== 'undefined' && Chart.getChart) ? Chart.getChart(element) : null;
        imageData = chart?.toBase64Image?.() || element.toDataURL('image/png');
    } else {
        return;
    }

    const title = getChartTitleFromElement(element);
    const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { margin: 0; font-family: Inter, IBM Plex Sans Arabic, sans-serif; background: #0b1220; color: #e2e8f0; }
    .wrap { min-height: 100vh; display: flex; flex-direction: column; gap: 10px; padding: 18px; box-sizing: border-box; }
    h1 { margin: 0; font-size: 20px; font-weight: 800; }
    .panel { flex: 1; border-radius: 12px; background: #0f172a; border: 1px solid #243249; padding: 14px; display: grid; place-items: center; }
    img { max-width: 100%; max-height: calc(100vh - 120px); object-fit: contain; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>${title}</h1>
    <div class="panel"><img src="${imageData}" alt="${title}" /></div>
  </div>
</body>
</html>`;
    const popup = window.open('', '_blank', CHART_POPOUT_WINDOW_FEATURES);

    if (!popup) {
        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        window.location.href = url;
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        return;
    }

    popup.document.write(html);
    popup.document.close();
}

function ensureChartPopoutButtons() {
    const headings = document.querySelectorAll('.chart-card h3, .sidebar-chart-section h3, .map-overlay-card h3');
    headings.forEach((heading, index) => {
        if (heading.querySelector('.chart-open-btn')) return;

        const section = heading.closest('.chart-card, .sidebar-chart-section, .map-overlay-card');
        const chartElement = section?.querySelector('canvas, .plotly-chart');
        if (!chartElement) return;

        if (!chartElement.id) {
            chartElement.id = `chartCanvas${index + 1}`;
        }

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'chart-open-btn';
        button.setAttribute('aria-label', 'Open chart in new page');
        button.setAttribute('title', 'Open chart in new page');
        button.dataset.chartId = chartElement.id;
        button.innerHTML = '<i class="fa-solid fa-up-right-from-square"></i>';
        heading.appendChild(button);
    });
}

function initChartViewer() {
    ensureChartPopoutButtons();

    document.addEventListener('click', (event) => {
        const button = event.target.closest('.chart-open-btn');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();

        const chartId = button.dataset.chartId;
        const chartElement = chartId ? document.getElementById(chartId) : null;
        openChartElementInNewPage(chartElement);
    });

    // Double click any chart to open it in a dedicated page.
    document.addEventListener('dblclick', (event) => {
        const chartElement = event.target.closest('canvas, .plotly-chart');
        if (!chartElement) return;
        openChartElementInNewPage(chartElement);
    });
}

function resizePlotlyCharts() {
    if (!window.Plotly?.Plots?.resize) return;

    ['periodChart', 'entranceChart', 'pathChart'].forEach(id => {
        const element = document.getElementById(id);
        if (!element) return;
        Plotly.Plots.resize(element);
    });
}

function requestDashboardResize() {
    if (dashboardResizeFrameId) cancelAnimationFrame(dashboardResizeFrameId);

    dashboardResizeFrameId = requestAnimationFrame(() => {
        dashboardResizeFrameId = null;
        if (map) map.invalidateSize();
        resizePlotlyCharts();
    });
}

function initResizablePanels() {
    const root = document.documentElement;
    const sidebar = document.querySelector('.sidebar');
    const rightPanel = document.querySelector('.right-charts-panel');
    const leftHandle = document.getElementById('leftPanelResizeHandle');
    const rightHandle = document.getElementById('rightPanelResizeHandle');

    if (!sidebar || !rightPanel || !leftHandle || !rightHandle) return;

    const savedSidebarWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    const savedRightPanelWidth = Number(localStorage.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY));

    if (Number.isFinite(savedSidebarWidth) && savedSidebarWidth >= 280 && savedSidebarWidth <= 560) {
        root.style.setProperty('--sidebar-width', `${savedSidebarWidth}px`);
    }

    if (Number.isFinite(savedRightPanelWidth) && savedRightPanelWidth >= 320 && savedRightPanelWidth <= 760) {
        root.style.setProperty('--right-panel-width', `${savedRightPanelWidth}px`);
    }

    const scheduleDashboardResize = () => {
        requestDashboardResize();
    };

    const startDrag = ({ handle, panel, minWidth, maxWidth, cssVarName, storageKey }) => (event) => {
        if (window.innerWidth <= 1100) return;
        event.preventDefault();

        const startX = event.clientX;
        const startWidth = panel.getBoundingClientRect().width;
        const handleRect = handle.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const handleOnRightEdge = handleRect.left >= (panelRect.right - 4);
        const directionFactor = handleOnRightEdge ? 1 : -1;

        handle.classList.add('is-dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        const onMove = (moveEvent) => {
            const delta = moveEvent.clientX - startX;
            const nextWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + (delta * directionFactor)));
            root.style.setProperty(cssVarName, `${Math.round(nextWidth)}px`);
            scheduleDashboardResize();
        };

        const onUp = () => {
            const finalWidth = Math.round(panel.getBoundingClientRect().width);
            localStorage.setItem(storageKey, String(finalWidth));
            handle.classList.remove('is-dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            scheduleDashboardResize();
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    };

    leftHandle.addEventListener('mousedown', startDrag({
        handle: leftHandle,
        panel: sidebar,
        minWidth: 280,
        maxWidth: 560,
        cssVarName: '--sidebar-width',
        storageKey: SIDEBAR_WIDTH_STORAGE_KEY
    }));

    rightHandle.addEventListener('mousedown', startDrag({
        handle: rightHandle,
        panel: rightPanel,
        minWidth: 320,
        maxWidth: 760,
        cssVarName: '--right-panel-width',
        storageKey: RIGHT_PANEL_WIDTH_STORAGE_KEY
    }));

    const addKeyboardResize = (handle, cssVarName, storageKey, minWidth, maxWidth, step = 16) => {
        handle.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();

            const current = parseFloat(getComputedStyle(root).getPropertyValue(cssVarName)) || minWidth;
            const delta = event.key === 'ArrowLeft' ? -step : step;
            const next = Math.max(minWidth, Math.min(maxWidth, current + delta));
            root.style.setProperty(cssVarName, `${Math.round(next)}px`);
            localStorage.setItem(storageKey, String(Math.round(next)));
            scheduleDashboardResize();
        });
    };

    addKeyboardResize(leftHandle, '--sidebar-width', SIDEBAR_WIDTH_STORAGE_KEY, 280, 560);
    addKeyboardResize(rightHandle, '--right-panel-width', RIGHT_PANEL_WIDTH_STORAGE_KEY, 320, 760);

    if (typeof ResizeObserver !== 'undefined') {
        const panelResizeObserver = new ResizeObserver(scheduleDashboardResize);
        panelResizeObserver.observe(rightPanel);
    }

    window.addEventListener('resize', scheduleDashboardResize);
}

function initTheme() {
    const savedTheme = getPersistentValue(THEME_STORAGE_KEY) || 'dark';
    applyTheme(savedTheme);
}

function applyTheme(theme) {
    const isDark = theme === 'dark';
    document.body.classList.toggle('dark-mode', isDark);
    document.body.classList.toggle('light-mode', !isDark);
    setPersistentValue(THEME_STORAGE_KEY, isDark ? 'dark' : 'light');

    const chartDefaults = getThemeColors();
    if (window.Chart) {
        Chart.defaults.color = chartDefaults.title;
        Chart.defaults.font.family = "Inter, IBM Plex Sans Arabic, sans-serif";
        Chart.defaults.plugins.legend.labels.color = chartDefaults.title;
        Chart.defaults.plugins.tooltip.titleColor = chartDefaults.title;
        Chart.defaults.plugins.tooltip.bodyColor = chartDefaults.text;
        Chart.defaults.plugins.tooltip.backgroundColor = isDark ? 'rgba(9, 9, 11, 0.96)' : '#ffffff';
        Chart.defaults.plugins.tooltip.borderColor = chartDefaults.border;
        Chart.defaults.plugins.tooltip.borderWidth = 1;
    }

    const themeBtn = document.getElementById('themeToggleBtn');
    if (themeBtn) {
        themeBtn.setAttribute('aria-label', isDark ? 'تفعيل الوضع الفاتح' : 'تفعيل الوضع الداكن');
        themeBtn.innerHTML = isDark ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
    }

    if (map && lightMapLayer && darkMapLayer) {
        if (isDark) {
            if (map.hasLayer(lightMapLayer)) map.removeLayer(lightMapLayer);
            if (!map.hasLayer(darkMapLayer)) darkMapLayer.addTo(map);
        } else {
            if (map.hasLayer(darkMapLayer)) map.removeLayer(darkMapLayer);
            if (!map.hasLayer(lightMapLayer)) lightMapLayer.addTo(map);
        }
    }

    if (rawData.length) updateCharts();
}

function getThemeColors() {
    const styles = getComputedStyle(document.body);
    return {
        title: styles.getPropertyValue('--text-primary').trim() || '#fafafa',
        text: styles.getPropertyValue('--text-secondary').trim() || '#afafaf',
        grid: document.body.classList.contains('dark-mode') ? 'rgba(148, 163, 184, 0.14)' : 'rgba(100, 116, 139, 0.18)',
        border: styles.getPropertyValue('--border-color').trim() || '#e2e8f0'
    };
}

const PLANS_CSV_DB_NAME = 'transport-dashboard-cache';
const PLANS_CSV_STORE_NAME = 'plansCsv';
const PLANS_CSV_CACHE_KEY = 'latest-upload';
const PLANS_CSV_SOURCE_STORAGE_KEY = 'dashboard-active-plans-csv-source';

function openPlansCsvDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(PLANS_CSV_DB_NAME, 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(PLANS_CSV_STORE_NAME);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function getCachedPlansCsv() {
    const db = await openPlansCsvDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(PLANS_CSV_STORE_NAME, 'readonly');
        const request = tx.objectStore(PLANS_CSV_STORE_NAME).get(PLANS_CSV_CACHE_KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
        tx.onerror = () => db.close();
    });
}

async function cachePlansCsv(csvText, source) {
    const db = await openPlansCsvDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(PLANS_CSV_STORE_NAME, 'readwrite');
        const payload = { csvText, source, savedAt: new Date().toISOString() };
        const request = tx.objectStore(PLANS_CSV_STORE_NAME).put(payload, PLANS_CSV_CACHE_KEY);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => {
            localStorage.setItem(PLANS_CSV_SOURCE_STORAGE_KEY, source || 'uploaded CSV');
            db.close();
            resolve();
        };
        tx.onerror = () => {
            const error = tx.error || request.error;
            db.close();
            reject(error);
        };
    });
}

async function clearPlansCsvCache() {
    localStorage.removeItem(PLANS_CSV_SOURCE_STORAGE_KEY);

    try {
        const db = await openPlansCsvDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(PLANS_CSV_STORE_NAME, 'readwrite');
            const request = tx.objectStore(PLANS_CSV_STORE_NAME).delete(PLANS_CSV_CACHE_KEY);
            request.onerror = () => reject(request.error);
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => {
                const error = tx.error || request.error;
                db.close();
                reject(error);
            };
        });
    } catch (error) {
        console.warn('Could not clear plans CSV cache:', error);
    }
}

function debounce(fn, delay = 180) {
    let timeoutId;
    return (...args) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn(...args), delay);
    };
}

function scheduleDashboardUpdate() {
    if (dashboardFrameId) cancelAnimationFrame(dashboardFrameId);
    dashboardFrameId = requestAnimationFrame(() => {
        dashboardFrameId = null;
        updateDashboard();
    });
}

function addToBucket(bucket, key, amount) {
    const safeKey = key || 'غير معروف';
    bucket[safeKey] = (bucket[safeKey] || 0) + amount;
}

function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function getAllocatedPilgrims(row) {
    return toNumber(row['allocated_haj'] ?? row['allocated_hajj'] ?? row['number_of_piligrim'] ?? row['number_of_haj']);
}

function getAssignmentRecordKey(row) {
    const company = row['service_company_name'] ?? row['owner_company_name'] ?? '';
    const centerNumber = row['office_number'] ?? row['owner_office_number'] ?? '';
    const campLabel = row['camp_label'] ?? '';
    return centerKey(company, centerNumber) + '|' + String(campLabel || '').trim();
}

function normalizeTextKey(value) {
    return normalizeArabic(String(value || ''))
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function companyKey(company) {
    return normalizeTextKey(company);
}

function centerNumberValue(centerNumber) {
    return String(centerNumber || '').trim();
}

function centerKey(company, centerNumber) {
    return `${companyKey(company)}|${centerNumberValue(centerNumber)}`;
}

function centerNumberKey(centerNumber) {
    return `*|${centerNumberValue(centerNumber)}`;
}

function normalizeAssignCampRows(rows) {
    return rows.map(row => {
        const transportModeKey = Object.keys(row).find(key => normalizeTextKey(key) === 'transport_mode') || 'transport_mode';
        return {
            camp_label: row['camp_label'] ?? '',
            service_company_name: row['service_company_name'] ?? row['owner_company_name'] ?? '',
            office_number: row['office_number'] ?? row['owner_office_number'] ?? '',
            nationality: row['nationality'] ?? '',
            service_center_name: row['service_center_name'] ?? row['office_number'] ?? '',
            piligrim_type: row['piligrim_type'] ?? '',
            transport_mode: row[transportModeKey] ?? row['transport_mode'] ?? '',
            platform_name: row['platform_name'] ?? '',
            number_of_piligrim: toNumber(row['number_of_piligrim'] ?? row['number_of_pilgrim'] ?? row['number_of_haj'])
        };
    });
}

function buildAssignmentTotalsFromCampRows(rows) {
    const companyMetrics = new Map();
    const centerMetrics = new Map();

    rows.forEach(row => {
        const company = row.service_company_name;
        const centerNumber = row.office_number;
        const serviceCenterName = row.service_center_name;
        const pilgrims = toNumber(row.number_of_piligrim);
        const companyEntry = ensureCompanyMetricsEntry(companyMetrics, company);
        const centerEntry = ensureCenterMetricsEntry(centerMetrics, company, centerNumber, serviceCenterName);
        const residenceKey = normalizeTextKey(row.nationality);

        companyEntry.totalPilgrims += pilgrims;
        centerEntry.totalPilgrims += pilgrims;

        if (residenceKey) {
            companyEntry.totalResidenceKeys.add(residenceKey);
            centerEntry.totalResidenceKeys.add(residenceKey);
        }
    });

    return { companyMetrics, centerMetrics };
}

function loadAssignCampTotals() {
    if (typeof ASSIGN_CAMPS_DATA === 'undefined' || !window.Papa) {
        assignCampRows = [];
        assignmentTotalsFromCamps = { companyMetrics: new Map(), centerMetrics: new Map() };
        return;
    }

    const parsed = Papa.parse(ASSIGN_CAMPS_DATA, {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true
    });
    assignCampRows = normalizeAssignCampRows(parsed.data || []);
    assignmentTotalsFromCamps = buildAssignmentTotalsFromCampRows(assignCampRows);
}

function normalizeResidenceAssignmentRows(rows) {
    return rows.map(row => ({
        licenseNumber: String(row['License Number'] || row['license_number'] || '').trim(),
        residenceName: String(row['Name'] || row['name'] || '').trim(),
        pilgrimsCount: toNumber(row['Pilgrims_count'] || row['pilgrims_count']),
        serviceCompany: String(row['Service_company'] || row['service_company'] || '').trim(),
        serviceCenterName: String(row['Service_center_name'] || row['service_center_name'] || '').trim(),
        serviceCenterNumber: String(row['Service_center_number'] || row['service_center_number'] || '').trim(),
        tarwiyahCount: toNumber(row['Tarwiyah_count'] || row['tarwiyah_count']),
        taseedCount: toNumber(row['Taseed_count'] || row['taseed_count'])
    }));
}

let residenceAssignmentRows = [];

function loadResidenceAssignments() {
    if (typeof ASSIGN_RESIDENCES_DATA === 'undefined' || !window.Papa) {
        residenceAssignmentRows = [];
        return;
    }

    const parsed = Papa.parse(ASSIGN_RESIDENCES_DATA, {
        header: true,
        dynamicTyping: false,
        skipEmptyLines: true
    });
    residenceAssignmentRows = normalizeResidenceAssignmentRows(parsed.data || []);
    console.info('Loaded residence assignments:', residenceAssignmentRows.length, 'records');
}

function getAssignmentTotalsForDisplay(totalRows = []) {
    return collectAssignmentMetrics(totalRows);
}

function normalizeSelectionFilter(filter) {
    if (filter instanceof Set) return filter;
    if (!filter || filter === 'all') return new Set();
    return new Set([filter]);
}

function getSelectedCompanyAndOwner() {
    return {
        company: selectedServiceCompanies,
        owner: selectedServiceCenters
    };
}

function matchesCompanyOwnerFilters(rowCompany, rowOwner, companyFilter = selectedServiceCompanies, ownerFilter = selectedServiceCenters) {
    const companyFilterSet = normalizeSelectionFilter(companyFilter);
    const ownerFilterSet = normalizeSelectionFilter(ownerFilter);
    if (companyFilterSet.size && !companyFilterSet.has(companyKey(rowCompany))) return false;
    if (ownerFilterSet.size && !ownerFilterSet.has(centerKey(rowCompany, rowOwner))) return false;
    return true;
}

function hasServiceEntitySelection() {
    return selectedServiceCompanies.size > 0 || selectedServiceCenters.size > 0;
}

function getCompanyDisplayName(company) {
    return String(company || '').trim() || 'غير معروف';
}

function getCenterDisplayName(company, centerNumber, fallbackName = '') {
    return String(fallbackName || serviceCenterNamesByKey.get(centerKey(company, centerNumber)) || centerNumberValue(centerNumber) || 'بدون مركز').trim();
}

function getResidenceRecordKey(row) {
    const license = String(row['License Number'] || row.licenseNumber || '').trim();
    const name = normalizeTextKey(row['Name'] || row.residenceName);
    return license + '|' + name;
}

function addAssignmentTotal(map, key, row, planTypeCode = '') {
    if (key.endsWith('|')) return;

    const assignmentKey = getAssignmentRecordKey(row);
    const allocated = getAllocatedPilgrims(row);
    const current = map.get(key) || {
        total: 0,
        byPlanType: new Map(),
        assignments: new Map(),
        assignmentsByPlanType: new Map()
    };

    const previous = current.assignments.get(assignmentKey) || 0;
    if (allocated > previous) {
        current.total += allocated - previous;
        current.assignments.set(assignmentKey, allocated);
    }

    if (planTypeCode) {
        const typedKey = planTypeCode + '|' + assignmentKey;
        const previousTyped = current.assignmentsByPlanType.get(typedKey) || 0;
        if (allocated > previousTyped) {
            current.byPlanType.set(planTypeCode, (current.byPlanType.get(planTypeCode) || 0) + allocated - previousTyped);
            current.assignmentsByPlanType.set(typedKey, allocated);
        }
    }

    map.set(key, current);
}

function getResidenceNameFromPlan(row) {
    return String(
        (row['start_point_type'] === 'residence' && row['start_point_name'])
        || (row['end_point_type'] === 'residence' && row['end_point_name'])
        || ''
    ).trim();
}

function getPlanResidenceKey(row) {
    const residenceName = getResidenceNameFromPlan(row);
    return residenceName ? normalizeTextKey(residenceName) : '';
}

function getPlanServiceCenterName(row) {
    return String(row['owner_office_number'] || '').trim();
}

function buildDerivedDataSources(rows) {
    assignmentTotalsByCenter = new Map();
    assignmentTotalsByNumber = new Map();
    campAssignmentRecords = [];
    campAssignmentStats = null;
    residenceAssignmentKeys = new Set();
    residenceAssignmentRecords = [];
    serviceCompaniesCatalog = [];
    serviceCompanyNameByKey = new Map();
    serviceCenterNamesByKey = new Map();
    const companyKeys = new Set();
    const residenceRowsByKey = new Map();

    rows.forEach(row => {
        const company = row['owner_company_name'];
        const centerNumber = row['owner_office_number'];
        const centerName = getPlanServiceCenterName(row);
        const key = centerKey(company, centerNumber);
        const planTypeCode = String(row['plan_type_code'] || row['plan_type_name'] || '').trim();
        const planTypeText = normalizeTextKey(String(row['plan_type_code'] || '') + ' ' + String(row['plan_type_name'] || ''));
        const residenceName = getResidenceNameFromPlan(row);
        const residenceKey = getPlanResidenceKey(row);
        const plannedPilgrims = toNumber(row['number_of_haj']);
        const allocatedPilgrims = getAllocatedPilgrims(row);

        if (company) {
            const key = companyKey(company);
            if (!companyKeys.has(key)) {
                companyKeys.add(key);
                serviceCompanyNameByKey.set(key, getCompanyDisplayName(company));
                serviceCompaniesCatalog.push({ id: key, key, name: getCompanyDisplayName(company), logo: '' });
            }
        }

        if (centerNumber) {
            if (centerName) serviceCenterNamesByKey.set(key, centerName);
            campAssignmentRecords.push({
                company,
                centerNumber,
                centerKey: key,
                campLabel: String(row['camp_label'] || '').trim(),
                assignmentKey: getAssignmentRecordKey(row),
                pilgrims: allocatedPilgrims,
                serviceCenterName: centerName
            });
            addAssignmentTotal(assignmentTotalsByCenter, key, row, planTypeCode);
            addAssignmentTotal(assignmentTotalsByNumber, centerNumberKey(centerNumber), row, planTypeCode);
        }

        if (residenceKey && centerNumber) {
            const aggregateKey = key + '|' + residenceKey;
            const current = residenceRowsByKey.get(aggregateKey) || {
                company,
                centerNumber,
                centerKey: key,
                residenceKey,
                pilgrims: 0,
                tarwiyahCount: 0,
                taseedCount: 0,
                residenceName,
                serviceCenterName: centerName
            };

            current.pilgrims += plannedPilgrims;
            if (planTypeText.includes('tarwia') || planTypeText.includes('تروية')) current.tarwiyahCount += plannedPilgrims;
            if (planTypeText.includes('taseed') || planTypeText.includes('تصعيد')) current.taseedCount += plannedPilgrims;
            residenceRowsByKey.set(aggregateKey, current);
            residenceAssignmentKeys.add(key);
        }
    });

    residenceAssignmentRecords = Array.from(residenceRowsByKey.values());
    campAssignmentStats = calculateCampAssignmentStats(rows);
}

function getResidenceAssignmentCoverage() {
    const { company, owner } = getSelectedCompanyAndOwner();
    const campCenterKeys = new Set();
    const residenceCenterKeys = new Set();

    campAssignmentRecords.forEach(row => {
        if (!matchesCompanyOwnerFilters(row.company, row.centerNumber, company, owner)) return;
        campCenterKeys.add(centerKey(row.company, row.centerNumber));
    });

    residenceAssignmentRecords.forEach(row => {
        if (!row.residenceKey) return;
        if (!matchesCompanyOwnerFilters(row.company, row.centerNumber, company, owner)) return;
        residenceCenterKeys.add(centerKey(row.company, row.centerNumber));
    });

    const assigned = Array.from(campCenterKeys).filter(key => residenceCenterKeys.has(key)).length;
    const total = campCenterKeys.size;

    return {
        assigned,
        missing: Math.max(total - assigned, 0),
        total
    };
}

function getResidenceAssignmentStats() {
    const { company, owner } = getSelectedCompanyAndOwner();
    const plannedResidences = new Set();
    const totalAssignedResidences = new Set();

    // Count residences from PLANS (residenceAssignmentRecords) for selected company
    residenceAssignmentRecords.forEach(row => {
        if (!matchesCompanyOwnerFilters(row.company, row.centerNumber, company, owner)) return;
        if (row.residenceName) {
            plannedResidences.add(row.residenceName);
        }
    });

    // Count residences from ASSIGNMENT DATA (residenceAssignmentRows) for selected company
    residenceAssignmentRows.forEach(row => {
        // Apply company/center filters
        if (company.size && !company.has(companyKey(row.serviceCompany))) return;
        if (owner.size && !owner.has(centerKey(row.serviceCompany, row.serviceCenterNumber))) return;

        const residenceKey = row.licenseNumber ? `${row.licenseNumber}|${row.residenceName}` : row.residenceName;
        if (residenceKey) {
            totalAssignedResidences.add(residenceKey);
        }
    });

    return {
        totalResidences: plannedResidences.size,
        totalAssigned: totalAssignedResidences.size
    };
}

function getTotalResidencesFromRawData() {
    // Count all unique residences from assignment data
    const uniqueResidences = new Set();

    residenceAssignmentRows.forEach(row => {
        const residenceKey = row.licenseNumber ? `${row.licenseNumber}|${row.residenceName}` : row.residenceName;
        if (residenceKey) {
            uniqueResidences.add(residenceKey);
        }
    });

    return uniqueResidences.size;
}

function getResidenceMixStats() {
    const { company, owner } = getSelectedCompanyAndOwner();
    const residencesByKey = new Map();

    residenceAssignmentRecords.forEach(row => {
        if (!row.residenceKey) return;
        if (!matchesCompanyOwnerFilters(row.company, row.centerNumber, company, owner)) return;

        const current = residencesByKey.get(row.residenceKey) || { tarwiyah: 0, taseed: 0 };
        current.tarwiyah += toNumber(row.tarwiyahCount);
        current.taseed += toNumber(row.taseedCount);
        residencesByKey.set(row.residenceKey, current);
    });

    let tarwiyahOnly = 0;
    let directTaseedOnly = 0;
    let mixed = 0;

    residencesByKey.forEach(item => {
        const hasTarwiyah = item.tarwiyah > 0;
        const hasTaseed = item.taseed > 0;

        if (hasTarwiyah && hasTaseed) mixed++;
        else if (hasTarwiyah) tarwiyahOnly++;
        else if (hasTaseed) directTaseedOnly++;
    });

    const total = residencesByKey.size;
    return { total, tarwiyahOnly, directTaseedOnly, mixed };
}

function getResidenceMixNameSets() {
    const { company, owner } = getSelectedCompanyAndOwner();
    const sets = {
        tarwiyah: new Set(),
        direct: new Set(),
        mixed: new Set()
    };
    const residenceMap = new Map();

    residenceAssignmentRecords.forEach(row => {
        if (!matchesCompanyOwnerFilters(row.company, row.centerNumber, company, owner)) return;
        if (!row.residenceName) return;
        const nameKey = normalizeTextKey(row.residenceName);
        if (!nameKey) return;

        const current = residenceMap.get(nameKey) || { tarwiyah: 0, taseed: 0 };
        current.tarwiyah += toNumber(row.tarwiyahCount);
        current.taseed += toNumber(row.taseedCount);
        residenceMap.set(nameKey, current);
    });

    residenceMap.forEach((item, nameKey) => {
        const hasTarwiyah = item.tarwiyah > 0;
        const hasTaseed = item.taseed > 0;
        if (hasTarwiyah && hasTaseed) sets.mixed.add(nameKey);
        else if (hasTarwiyah) sets.tarwiyah.add(nameKey);
        else if (hasTaseed) sets.direct.add(nameKey);
    });

    return sets;
}

function getAssignmentTotalForPlan(row) {
    const company = row['owner_company_name'];
    const centerNumber = row['owner_office_number'];
    return assignmentTotalsByCenter.get(centerKey(company, centerNumber))
        || assignmentTotalsByNumber.get(centerNumberKey(centerNumber))
        || null;
}

function getPlanTypeTarget(planTypeCode, assignment) {
    if (!assignment) return 0;
    return assignment.byPlanType?.get(planTypeCode) || assignment.total;
}

// Load CSV Data
function loadData() {
    if (typeof CSV_DATA === 'undefined') {
        alert("CSV_DATA is not defined. Ensure data.js is loaded.");
        return;
    }

    // GeoJSON data removed - using only core data files (assign_camps, assign_residences, data.js)


    loadAssignCampTotals();
    loadResidenceAssignments();

    const loadId = ++plansCsvLoadSequence;
    parsePlansCsv(CSV_DATA, {
        loadId,
        source: typeof PLANS_CSV_SOURCE !== 'undefined' ? PLANS_CSV_SOURCE : 'data.js'
    });

}

function applyPlansRows(rows, source = '') {
    rawData = normalizePlanRows(rows);
    buildDerivedDataSources(rawData);
    planTypeBaseData = [...rawData];
    contextFilteredData = rawData.filter(row => !selectedPlanTypes.size || selectedPlanTypes.has(row['plan_type_name']));
    filteredData = [...contextFilteredData];
    activePlansCsvSource = source;
    console.info('Loaded plans CSV:', source || 'unknown', rawData.length, 'rows');
    resetSelections();

    populateFilters();
    scheduleDashboardUpdate();
}

function parsePlansCsv(csvTextOrFile, { loadId = ++plansCsvLoadSequence, source = '' } = {}) {
    Papa.parse(csvTextOrFile, {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
        complete: function (results) {
            if (loadId !== plansCsvLoadSequence) return;
            applyPlansRows(results.data, source);
        },
        error: function (error) {
            if (loadId !== plansCsvLoadSequence) return;
            console.error("Error parsing CSV:", error);
            alert("Could not parse data.");
        }
    });
}

function normalizePlanRows(rows) {
    return rows.map(row => ({
        ...row,
        plan_id: row['plan_id'] ?? row['ID'],
        camp_label: row['camp_label'] ?? row['End point name'],
        number_of_buses: row['number_of_buses'] ?? row['Number of buses'],
        number_of_haj: row['number_of_haj'] ?? row['Number of haj'],
        period: row['period'] ?? row['Period'],
        timing_start_at: row['timing_start_at'] ?? row['Start time'],
        timing_end_at: row['timing_end_at'] ?? row['End time'],
        plan_type_name: row['plan_type_name'] ?? row['Plan type'],
        plan_type_code: row['plan_type_code'] ?? row['Plan type code'],
        transport_type_name: row['transport_type_name'] ?? row['Transport type'],
        entrance_name: row['entrance_name'] ?? row['Entrance'],
        entrance_asm_code: row['entrance_asm_code'] ?? row['Entrance code'],
        path_name: row['path_name'] ?? row['Path'],
        path_geom: row['path_geom'] ?? row['Path GIS'],
        start_point_type: row['start_point_type'] ?? row['Start point type'],
        start_point_name: row['start_point_name'] ?? row['Start point name'],
        end_point_type: row['end_point_type'] ?? row['End point type'],
        end_point_name: row['end_point_name'] ?? row['End point name'],
        owner_company_name: row['owner_company_name'] ?? row['Company'],
        owner_office_number: row['owner_office_number'] ?? row['Owner'],
        get_type_parking: row['get_type_parking'] ?? row['Get parking type'],
        get_parking_name: row['get_parking_name'] ?? row['Get parking'],
        set_type_parking: row['set_type_parking'] ?? row['Set parking type'],
        set_parking_name: row['set_parking_name'] ?? row['Set parking']
    }));
}

function resetSelections() {
    selectedPlanId = null;
    selectedEntranceName = null;
    selectedPathName = null;
    selectedDistrict = null;
    selectedResidenceMixFilter = 'all';
}

// Parse geometry (JSON or WKT)
function parseGeom(str) {
    if (!str || typeof str !== 'string') return null;
    str = str.trim();
    if (str.startsWith('{')) {
        try { return JSON.parse(str); } catch (e) { return null; }
    }

    // Simple WKT parser
    if (str.startsWith('LINESTRING')) {
        let coordsStr = str.replace('LINESTRING', '').replace(/\(/g, '').replace(/\)/g, '').trim();
        if (!coordsStr) return null;
        let coords = coordsStr.split(',').map(pair => {
            let [lng, lat] = pair.trim().split(/\s+/).map(Number);
            return [lng, lat];
        }).filter(coord => !isNaN(coord[0]) && !isNaN(coord[1]));
        return { type: 'LineString', coordinates: coords };
    }
    if (str.startsWith('POLYGON')) {
        let coordsStr = str.replace('POLYGON', '').replace(/\(/g, '').replace(/\)/g, '').trim();
        if (!coordsStr) return null;
        let coords = [coordsStr.split(',').map(pair => {
            let [lng, lat] = pair.trim().split(/\s+/).map(Number);
            return [lng, lat];
        }).filter(coord => !isNaN(coord[0]) && !isNaN(coord[1]))];
        return { type: 'Polygon', coordinates: coords };
    }
    if (str.startsWith('MULTIPOLYGON')) {
        let coordsStr = str.replace('MULTIPOLYGON', '').replace(/\(/g, '').replace(/\)/g, '').trim();
        if (!coordsStr) return null;
        let coords = [[coordsStr.split(',').map(pair => {
            let [lng, lat] = pair.trim().split(/\s+/).map(Number);
            return [lng, lat];
        }).filter(coord => !isNaN(coord[0]) && !isNaN(coord[1]))]];
        return { type: 'MultiPolygon', coordinates: coords };
    }
    if (str.startsWith('POINT')) {
        let coordsStr = str.replace('POINT', '').replace(/\(/g, '').replace(/\)/g, '').trim();
        if (!coordsStr) return null;
        let [lng, lat] = coordsStr.split(/\s+/).map(Number);
        if (isNaN(lng) || isNaN(lat)) return null;
        return { type: 'Point', coordinates: [lng, lat] };
    }
    return null;
}

function getRowGeojsons(row) {
    const geojsonsToRender = [];
    const planTypeCode = row['plan_type_code'];

    let targetBaseName = null;
    if (planTypeCode === 'tarwia') targetBaseName = 'ASMMIN';
    else if (planTypeCode === 'taseed_tarwia') targetBaseName = 'MINARF';
    else if (planTypeCode === 'efada') targetBaseName = 'ARFMUZ';
    else if (planTypeCode === 'nafra') targetBaseName = 'MINARF';

    if (row['internal_path']) {
        const internalGeojson = parseGeom(row['internal_path']);
        if (internalGeojson && internalGeojson.coordinates) geojsonsToRender.push({ geojson: internalGeojson, type: 'internal' });
    } else if (targetBaseName && geojsonLookup[targetBaseName]) {
        const feature = geojsonLookup[targetBaseName][row['camp_label']];
        if (feature && feature.geometry) geojsonsToRender.push({ geojson: feature.geometry, type: 'internal' });
    }

    if (row['path_geom']) {
        const externalGeojson = parseGeom(row['path_geom']);
        if (externalGeojson && externalGeojson.coordinates) geojsonsToRender.push({ geojson: externalGeojson, type: 'external' });
    }

    if (row['entrance_polygon']) {
        const entranceGeojson = parseGeom(row['entrance_polygon']);
        if (entranceGeojson && entranceGeojson.coordinates) geojsonsToRender.push({ geojson: entranceGeojson, type: 'entrance' });
    }

    const isResidence = row['start_point_type'] === 'residence';
    const startGeom = row['start_geom'] || row['start_point_geom'];
    if (startGeom) {
        const startGeojson = parseGeom(startGeom);
        if (startGeojson && startGeojson.coordinates) geojsonsToRender.push({ geojson: startGeojson, type: 'start', isResidence });
    }

    const endGeom = row['end_geom'] || row['end_point_geom'];
    if (endGeom) {
        const endGeojson = parseGeom(endGeom);
        if (endGeojson && endGeojson.coordinates) geojsonsToRender.push({ geojson: endGeojson, type: 'end' });
    }

    return geojsonsToRender;
}

function extendBoundsFromLngLat(bounds, coord) {
    if (!Array.isArray(coord) || coord.length < 2) return;
    const lng = Number(coord[0]);
    const lat = Number(coord[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    bounds.extend([lat, lng]);
}

function extendBoundsFromCoordinates(bounds, coordinates) {
    if (!Array.isArray(coordinates)) return;
    if (typeof coordinates[0] === 'number') {
        extendBoundsFromLngLat(bounds, coordinates);
        return;
    }
    coordinates.forEach(item => extendBoundsFromCoordinates(bounds, item));
}

function extendBoundsFromGeojson(bounds, geojson) {
    if (!geojson || !geojson.coordinates) return;
    extendBoundsFromCoordinates(bounds, geojson.coordinates);
}

function getPointLabel(row, item) {
    if (item.type === 'start') return String(row['start_point_name'] || '').trim();
    if (item.type === 'end') return String(row['end_point_name'] || '').trim();
    if (item.type === 'entrance') return String(row['entrance_name'] || row['entrance_asm_code'] || '').trim();
    return '';
}

function getAreaLabel(row, item) {
    if (item.type === 'internal') return String(row['path_name'] || row['camp_label'] || '').trim();
    if (item.type === 'entrance') return String(row['entrance_name'] || row['entrance_asm_code'] || '').trim();
    if (item.type === 'end') return String(row['end_point_name'] || '').trim();
    if (item.type === 'start') return String(row['start_point_name'] || '').trim();
    return '';
}

function getMidpointLatLng(latlngs) {
    if (!Array.isArray(latlngs) || !latlngs.length) return null;
    return latlngs[Math.floor(latlngs.length / 2)] || null;
}

function centerOfPolygon(latlngs) {
    if (!Array.isArray(latlngs) || !latlngs.length) return null;
    let sumLat = 0;
    let sumLng = 0;
    latlngs.forEach(([lat, lng]) => {
        sumLat += lat;
        sumLng += lng;
    });
    return [sumLat / latlngs.length, sumLng / latlngs.length];
}

function getRepresentativeLatLngFromGeojson(geojson) {
    if (!geojson || !geojson.coordinates) return null;

    if (geojson.type === 'Point') {
        return [geojson.coordinates[1], geojson.coordinates[0]];
    }

    if (geojson.type === 'LineString' && geojson.coordinates.length) {
        const coord = geojson.coordinates[0];
        return [coord[1], coord[0]];
    }

    if (geojson.type === 'Polygon' || geojson.type === 'MultiPolygon') {
        const coords = geojson.type === 'Polygon' ? geojson.coordinates[0] : geojson.coordinates[0][0];
        return centerOfPolygon(coords.map(coord => [coord[1], coord[0]]));
    }

    return null;
}

function getRowAnchorLatLng(row, type) {
    const geomText = type === 'start'
        ? (row['start_geom'] || row['start_point_geom'])
        : (row['end_geom'] || row['end_point_geom']);
    return getRepresentativeLatLngFromGeojson(parseGeom(geomText));
}

function getLatLngDistance(a, b) {
    if (!a || !b) return Infinity;
    if (map) return map.distance(L.latLng(a[0], a[1]), L.latLng(b[0], b[1]));
    const dx = a[1] - b[1];
    const dy = a[0] - b[0];
    return Math.sqrt((dx * dx) + (dy * dy));
}

function orientLatLngsForRoute(latlngs, row, item) {
    if (!Array.isArray(latlngs) || latlngs.length < 2 || !row) return latlngs;

    const first = latlngs[0];
    const last = latlngs[latlngs.length - 1];
    const startAnchor = getRowAnchorLatLng(row, 'start');
    const endAnchor = getRowAnchorLatLng(row, 'end');
    const thresholdMeters = item?.type === 'internal' ? 1 : 6;

    if (startAnchor && endAnchor) {
        const forwardScore = getLatLngDistance(first, startAnchor) + getLatLngDistance(last, endAnchor);
        const reverseScore = getLatLngDistance(last, startAnchor) + getLatLngDistance(first, endAnchor);
        return reverseScore + thresholdMeters < forwardScore ? [...latlngs].reverse() : latlngs;
    }

    if (startAnchor) {
        return getLatLngDistance(last, startAnchor) + thresholdMeters < getLatLngDistance(first, startAnchor)
            ? [...latlngs].reverse()
            : latlngs;
    }

    if (endAnchor) {
        return getLatLngDistance(first, endAnchor) + thresholdMeters < getLatLngDistance(last, endAnchor)
            ? [...latlngs].reverse()
            : latlngs;
    }

    return latlngs;
}

function getLineLatLngsFromGeojson(geojson) {
    if (!geojson || !geojson.coordinates) return [];
    const coords = geojson.type === 'LineString'
        ? geojson.coordinates
        : (geojson.type === 'MultiLineString' ? geojson.coordinates[0] : []);
    return coords.map(coord => [coord[1], coord[0]])
        .filter(coord => Number.isFinite(coord[0]) && Number.isFinite(coord[1]));
}

function orientConnectedRouteSegments(row, lineItems) {
    const segments = lineItems
        .map(item => ({ ...item, latlngs: getLineLatLngsFromGeojson(item.geojson) }))
        .filter(item => item.latlngs.length >= 2);

    if (segments.length < 2) {
        return segments.map(item => ({ ...item, latlngs: orientLatLngsForRoute(item.latlngs, row, item) }));
    }

    const startAnchor = getRowAnchorLatLng(row, 'start');
    const endAnchor = getRowAnchorLatLng(row, 'end');
    if (!startAnchor || !endAnchor) {
        return segments.map(item => ({ ...item, latlngs: orientLatLngsForRoute(item.latlngs, row, item) }));
    }

    const permutations = segments.length === 2
        ? [[segments[0], segments[1]], [segments[1], segments[0]]]
        : [segments];
    let best = null;

    permutations.forEach(order => {
        const orientationCount = 1 << order.length;
        for (let mask = 0; mask < orientationCount; mask++) {
            const oriented = order.map((item, index) => ({
                ...item,
                latlngs: (mask & (1 << index)) ? [...item.latlngs].reverse() : [...item.latlngs]
            }));
            let score = getLatLngDistance(startAnchor, oriented[0].latlngs[0]);
            for (let index = 0; index < oriented.length - 1; index++) {
                score += getLatLngDistance(
                    oriented[index].latlngs[oriented[index].latlngs.length - 1],
                    oriented[index + 1].latlngs[0]
                );
            }
            score += getLatLngDistance(oriented[oriented.length - 1].latlngs.at(-1), endAnchor);

            if (!best || score < best.score) best = { score, oriented };
        }
    });

    return best?.oriented || segments;
}

function getRouteFlowSamples(latlngs) {
    if (!map || !Array.isArray(latlngs) || latlngs.length < 2) return [];

    const points = latlngs.map(latlng => map.latLngToLayerPoint(L.latLng(latlng[0], latlng[1])));
    const segmentLengths = [];
    let totalLength = 0;

    for (let i = 0; i < points.length - 1; i++) {
        const length = points[i].distanceTo(points[i + 1]);
        segmentLengths.push(length);
        totalLength += length;
    }

    if (totalLength < 24) return [];

    const sampleCount = Math.max(1, Math.min(5, Math.floor(totalLength / 150) + 1));
    const startRatio = sampleCount === 1 ? 0.5 : 0.2;
    const endRatio = sampleCount === 1 ? 0.5 : 0.86;
    const samples = [];

    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
        const ratio = sampleCount === 1
            ? 0.5
            : startRatio + ((endRatio - startRatio) * (sampleIndex / (sampleCount - 1)));
        let targetDistance = totalLength * ratio;

        for (let i = 0; i < segmentLengths.length; i++) {
            const segmentLength = segmentLengths[i];
            if (targetDistance > segmentLength) {
                targetDistance -= segmentLength;
                continue;
            }

            if (segmentLength < 1) break;

            const start = points[i];
            const end = points[i + 1];
            const segmentRatio = targetDistance / segmentLength;
            const point = L.point(
                start.x + ((end.x - start.x) * segmentRatio),
                start.y + ((end.y - start.y) * segmentRatio)
            );
            const angle = Math.atan2(end.y - start.y, end.x - start.x) * (180 / Math.PI);
            samples.push({ latlng: map.layerPointToLatLng(point), angle });
            break;
        }
    }

    return samples;
}

function addMapLabel(latlng, text, className = 'map-point-label', direction = 'top') {
    if (!latlng || !text) return;
    const icon = L.divIcon({
        className: `map-static-label ${className}`,
        html: `<span>${text}</span>`,
        iconSize: null
    });

    const marker = L.marker(latlng, {
        icon,
        interactive: false,
        keyboard: false,
        zIndexOffset: 200
    }).addTo(routeLayerGroup);

    if (direction === 'top') {
        const element = marker.getElement?.();
        if (element) element.classList.add('label-top');
    }
}

function addRouteConnector(fromLatLng, toLatLng) {
    if (!fromLatLng || !toLatLng) return;
    const gapMeters = getLatLngDistance(fromLatLng, toLatLng);
    if (!Number.isFinite(gapMeters) || gapMeters < 12 || gapMeters > 5000) return;

    const latlngs = [fromLatLng, toLatLng];
    L.polyline(latlngs, {
        color: '#ffffff',
        weight: 7,
        opacity: 0.82,
        dashArray: '8 10',
        className: 'route-line-halo route-connector-line'
    }).addTo(routeLayerGroup);

    L.polyline(latlngs, {
        color: '#EBC468',
        weight: 3,
        opacity: 0.92,
        dashArray: '8 10',
        className: 'route-line route-connector-line'
    }).addTo(routeLayerGroup);

    addDirectionalArrows(latlngs, '#EBC468');
}

function addDirectionalArrows(latlngs, color) {
    getRouteFlowSamples(latlngs).forEach((sample, index) => {
        const arrowIcon = L.divIcon({
            className: 'map-arrow-marker',
            html: `<span class="map-flow-arrow" style="--arrow-color: ${color}; --arrow-angle: ${sample.angle}deg; --arrow-delay: ${index * 0.18}s;">
                <svg viewBox="0 0 34 18" aria-hidden="true" focusable="false">
                    <path class="map-flow-arrow-line" d="M3 9H24"></path>
                    <path class="map-flow-arrow-head" d="M18 3L27 9L18 15"></path>
                </svg>
            </span>`,
            iconSize: [34, 18],
            iconAnchor: [17, 9]
        });

        L.marker(sample.latlng, {
            icon: arrowIcon,
            interactive: false,
            keyboard: false,
            zIndexOffset: 160
        }).addTo(routeLayerGroup);
    });
}

function fitMapToGeometry(bounds) {
    if (!bounds || !bounds.isValid()) return;
    const padding = window.innerWidth < 700 ? [24, 24] : [44, 44];
    map.invalidateSize();
    map.fitBounds(bounds, {
        padding,
        maxZoom: MAP_FIT_MAX_ZOOM,
        animate: true
    });
}

function getDistrictBoundsByName(districtName) {
    // GeoJSON data removed - district bounds not available
    return null;
}

function focusDistrictOnMap(districtName) {
    const districtBounds = getDistrictBoundsByName(districtName);
    if (!districtBounds) return false;
    fitMapToGeometry(districtBounds);
    return true;
}

function updateMapLabelScale() {
    if (!map) return;
    const container = map.getContainer();
    if (!container) return;

    const zoom = map.getZoom();
    const labelsVisible = zoom >= MAP_LABEL_MIN_ZOOM || selectedServiceCenters.size > 0;
    const scale = Math.max(0.68, Math.min(1, 0.68 + ((zoom - 11) * 0.08)));
    container.style.setProperty('--map-label-scale', scale.toFixed(2));
    container.classList.toggle('map-labels-visible', labelsVisible);
    container.classList.toggle('map-labels-hidden', !labelsVisible);
}

// Map Initialization
function initMap() {
    // Center roughly around Makkah
    map = L.map('map', {
        zoomControl: false // Move to bottom right
    }).setView([21.4225, 39.8262], 13);

    L.control.zoom({
        position: 'bottomright'
    }).addTo(map);

    // Basemaps
    const darkMap = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    });

    const positronMap = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    });

    const streetsMap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    });

    const satelliteMap = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
    });

    lightMapLayer = positronMap;
    darkMapLayer = darkMap;

    if (document.body.classList.contains('dark-mode')) {
        darkMap.addTo(map);
    } else {
        positronMap.addTo(map);
    }

    // Layer control
    const baseMaps = {
        "الوضع الفاتح": positronMap,
        "شوارع": streetsMap,
        "الوضع الداكن": darkMap,
        "قمر صناعي (Satellite)": satelliteMap
    };

    L.control.layers(baseMaps, null, { position: 'topleft' }).addTo(map);

    map.createPane("districtPane");
    map.getPane("districtPane").style.zIndex = 350;

    districtsLayerGroup = L.layerGroup().addTo(map);
    routeLayerGroup = L.layerGroup().addTo(map);
    updateMapLabelScale();

    // Clear selection on map background click
    map.on('click', () => {
        selectedPlanId = null;
        selectedDistrict = null;
        selectedEntranceName = null;
        selectedPathName = null;
        applyFilters();
    });

    map.on('zoomend', updateMapLabelScale);
}

// Populate Filter Dropdowns
function populateFilters() {
    const periods = [...new Set(rawData.map(d => d['period']).filter(Boolean))];
    const transports = [...new Set(rawData.map(d => d['transport_type_name']).filter(Boolean))];
    const planTypes = [...new Set(rawData.map(d => d['plan_type_name']).filter(Boolean))];
    const districts = [...new Set(rawData.map(d => d['start_point_district']).filter(Boolean))];

    const populateSelect = (id, options) => {
        const select = document.getElementById(id);
        const defaultOption = select.querySelector('option[value="all"]');
        select.innerHTML = '';
        if (defaultOption) select.appendChild(defaultOption);
        options.sort().forEach(opt => {
            const el = document.createElement('option');
            el.value = opt;
            el.textContent = opt;
            select.appendChild(el);
        });
        select.value = 'all';
    };

    populateSelect('periodFilter', periods);
    populateSelect('transportFilter', transports);
    populateSelect('planTypeFilter', planTypes);
    populateSelect('districtFilter', districts);
    selectedPlanTypes = new Set(Array.from(selectedPlanTypes).filter(type => planTypes.includes(type)));
    if (!selectedPlanTypes.size && planTypes.includes('تروية')) {
        selectedPlanTypes.add('تروية');
    }
    syncPlanTypeSelectValue();

    renderPlanTypeMenu();
}

function syncPlanTypeSelectValue() {
    const select = document.getElementById('planTypeFilter');
    if (!select) return;
    select.value = selectedPlanTypes.size === 1 ? Array.from(selectedPlanTypes)[0] : 'all';
}

function getActivePlanTypeLabels() {
    return selectedPlanTypes;
}

function renderPlanTypeMenu() {
    const select = document.getElementById('planTypeFilter');
    const menu = document.getElementById('planTypeMenu');
    if (!select || !menu) return;

    const fragment = document.createDocumentFragment();
    Array.from(select.options).forEach(option => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'plan-type-option';
        button.textContent = option.textContent;
        button.dataset.value = option.value;
        button.setAttribute('role', 'tab');
        const isActive = option.value !== 'all' ? selectedPlanTypes.has(option.value) : selectedPlanTypes.size === 0;
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');

        if (isActive) button.classList.add('active');

        button.addEventListener('click', () => {
            if (option.value === 'all') {
                selectedPlanTypes.clear();
            } else {
                const isCurrentlySelected = selectedPlanTypes.has(option.value);
                if (isCurrentlySelected) {
                    selectedPlanTypes.delete(option.value);
                } else {
                    selectedPlanTypes.clear();
                    selectedPlanTypes.add(option.value);
                }
            }
            syncPlanTypeSelectValue();
            selectedPlanId = null;
            selectedEntranceName = null;
            selectedPathName = null;
            selectedDistrict = null;
            updatePlanTypeMenuState();
            applyFilters();
        });

        fragment.appendChild(button);
    });

    menu.replaceChildren(fragment);
}

function updatePlanTypeMenuState() {
    const select = document.getElementById('planTypeFilter');
    const menu = document.getElementById('planTypeMenu');
    if (!select || !menu) return;

    menu.querySelectorAll('.plan-type-option').forEach(button => {
        const value = button.dataset.value;
        const isActive = value !== 'all' ? selectedPlanTypes.has(value) : selectedPlanTypes.size === 0;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
}

// Event Listeners for Filters
function setupEventListeners() {
    const filters = ['periodFilter', 'transportFilter', 'planTypeFilter', 'districtFilter'];
    filters.forEach(id => {
        document.getElementById(id).addEventListener('change', () => {
            selectedPlanId = null;
            selectedEntranceName = null;
            selectedPathName = null;

            if (id === 'districtFilter') {
                const val = document.getElementById(id).value;
                selectedDistrict = (val === 'all') ? null : val;
            } else {
                selectedDistrict = null;
            }

            if (id === 'planTypeFilter') {
                const value = document.getElementById(id).value;
                selectedPlanTypes = value === 'all' ? new Set() : new Set([value]);
                updatePlanTypeMenuState();
            }
            applyFilters();
        });
    });

    const searchInput = document.querySelector('.search-bar input');
    const debouncedSearch = debounce(() => {
        resetSelections();
        applyFilters();
    }, 180);
    searchInput.addEventListener('input', debouncedSearch);

    const companySearch = document.getElementById('serviceCompaniesSearch');
    const centerSearch = document.getElementById('serviceCentersSearch');
    companySearch?.addEventListener('input', debounce(event => {
        entityTableState.company.search = event.target.value;
        renderServiceSummaryTables();
    }, 120));
    centerSearch?.addEventListener('input', debounce(event => {
        entityTableState.center.search = event.target.value;
        renderServiceSummaryTables();
    }, 120));

    document.getElementById('clearCompanySelectionBtn')?.addEventListener('click', () => {
        selectedServiceCompanies.clear();
        applyFilters();
    });
    document.getElementById('clearCenterSelectionBtn')?.addEventListener('click', () => {
        selectedServiceCenters.clear();
        applyFilters();
    });

    // Theme toggle
    const themeBtn = document.getElementById('themeToggleBtn');
    if (themeBtn) {
        themeBtn.addEventListener('click', () => {
            const currentTheme = getPersistentValue(THEME_STORAGE_KEY) || 'dark';
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            applyTheme(newTheme);
            // Redraw charts with new theme
            if (window.Plotly) {
                const isDark = newTheme === 'dark';
                const layout = {
                    paper_bgcolor: isDark ? '#0f172a' : '#ffffff',
                    plot_bgcolor: isDark ? '#1e293b' : '#f5f5f5',
                    font: { color: isDark ? '#cbd5e1' : '#333333' }
                };
                Plotly.restyle('periodChart', {}, layout);
                Plotly.restyle('entranceChart', {}, layout);
                Plotly.restyle('pathChart', {}, layout);
            }
        });
    }

    // CSV File Loader
    const csvFileInput = document.createElement('input');
    csvFileInput.type = 'file';
    csvFileInput.accept = '.csv';
    csvFileInput.style.display = 'none';
    csvFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = async (event) => {
                window.CSV_DATA = event.target.result;
                console.log('CSV file loaded:', file.name, 'Size:', CSV_DATA.length);
                // Cache the uploaded CSV for persistence across page refreshes
                try {
                    await cachePlansCsv(CSV_DATA, file.name);
                    console.log('CSV data cached for persistence');
                } catch (cacheError) {
                    console.warn('Failed to cache CSV data:', cacheError);
                }
                loadData();
            };
            reader.readAsText(file);
        }
    });
    document.body.appendChild(csvFileInput);

    // Add CSV loader button
    const topNavActions = document.querySelector('.top-nav-actions');
    if (topNavActions) {
        const csvBtn = document.createElement('button');
        csvBtn.id = 'csvLoaderBtn';
        csvBtn.className = 'theme-toggle-btn';
        csvBtn.type = 'button';
        csvBtn.title = 'تحميل ملف CSV';
        csvBtn.setAttribute('aria-label', 'تحميل ملف CSV');
        csvBtn.innerHTML = '<i class="fa-solid fa-upload"></i>';
        csvBtn.style.marginRight = '15px';
        csvBtn.addEventListener('click', () => {
            console.log('CSV button clicked');
            csvFileInput.click();
        });
        // Insert before theme button
        const themeBtn = topNavActions.querySelector('.theme-toggle-btn');
        if (themeBtn) {
            themeBtn.parentNode.insertBefore(csvBtn, themeBtn);
        } else {
            topNavActions.appendChild(csvBtn);
        }
        console.log('CSV loader button added');

        // Add Clear Cache button to revert to default data.js
        const clearCacheBtn = document.createElement('button');
        clearCacheBtn.id = 'clearCacheBtn';
        clearCacheBtn.className = 'theme-toggle-btn';
        clearCacheBtn.type = 'button';
        clearCacheBtn.title = 'مسح بيانات CSV المحفوظة والعودة للبيانات الافتراضية';
        clearCacheBtn.setAttribute('aria-label', 'مسح البيانات المحفوظة');
        clearCacheBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        clearCacheBtn.style.marginRight = '15px';
        clearCacheBtn.addEventListener('click', async () => {
            if (confirm('هل تريد مسح بيانات CSV المحفوظة والعودة للبيانات الافتراضية؟')) {
                try {
                    await clearPlansCsvCache();
                    // Reload page to restore default data.js
                    window.location.reload();
                } catch (error) {
                    alert('فشل مسح البيانات المحفوظة');
                    console.error('Failed to clear cache:', error);
                }
            }
        });
        // Insert before CSV button
        csvBtn.parentNode.insertBefore(clearCacheBtn, csvBtn);
        console.log('Clear cache button added');
    } else {
        console.log('top-nav-actions not found');
    }

    document.querySelectorAll('.entity-table thead th[data-sort-key]').forEach(header => {
        header.addEventListener('click', () => {
            const tableType = header.closest('.entity-table')?.dataset.tableType;
            const state = entityTableState[tableType];
            if (!state) return;
            const nextSortKey = header.dataset.sortKey;
            if (state.sortKey === nextSortKey) {
                state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                state.sortKey = nextSortKey;
                state.sortDirection = ['label', 'sublabel', 'centerNumber'].includes(nextSortKey) ? 'asc' : 'desc';
            }
            renderServiceSummaryTables();
        });
    });
}

// Apply Filters
function applyFilters() {
    const period = document.getElementById('periodFilter').value;
    const transport = document.getElementById('transportFilter').value;
    const district = document.getElementById('districtFilter').value;
    const search = document.querySelector('.search-bar input').value.toLowerCase();
    const activePlanTypes = getActivePlanTypeLabels();
    const residenceMixSets = selectedResidenceMixFilter === 'all' ? null : getResidenceMixNameSets();

    const matchesBaseFilters = d => {
        if (selectedPlanId && d['plan_id'] !== selectedPlanId) return false;

        const entrance = d['entrance_name'] || d['entrance_asm_code'] || 'No Entrance';
        if (selectedEntranceName && entrance !== selectedEntranceName) return false;

        const pathName = d['path_name'] || 'No Path';
        if (selectedPathName && pathName !== selectedPathName) return false;

        const districtName = d['start_point_district'] || 'No District';
        if (selectedDistrict && normalizeArabic(districtName) !== normalizeArabic(selectedDistrict)) return false;

        if (period !== 'all' && d['period'] != period) return false;
        if (transport !== 'all' && d['transport_type_name'] !== transport) return false;

        if (selectedResidenceMixFilter !== 'all') {
            const residenceName = getResidenceNameFromPlan(d);
            const residenceNameKey = normalizeTextKey(residenceName);
            if (!residenceNameKey) return false;
            const selectedSet = selectedResidenceMixFilter === 'tarwiyah'
                ? residenceMixSets.tarwiyah
                : (selectedResidenceMixFilter === 'direct' ? residenceMixSets.direct : residenceMixSets.mixed);
            if (!selectedSet.has(residenceNameKey)) return false;
        }

        if (search) {
            const planStr = (d['owner_company_name'] || '') + ' ' + (d['plan_type_name'] || '') + ' ' + (d['start_point_name'] || '');
            if (!planStr.toLowerCase().includes(search)) return false;
        }

        return true;
    };

    planTypeBaseData = rawData.filter(matchesBaseFilters);
    contextFilteredData = planTypeBaseData.filter(d => !activePlanTypes.size || activePlanTypes.has(d['plan_type_name']));

    filteredData = contextFilteredData.filter(d => matchesCompanyOwnerFilters(
        d['owner_company_name'],
        d['owner_office_number']
    ));

    scheduleDashboardUpdate();
}
function ensureCompanyMetricsEntry(map, company) {
    const key = companyKey(company);
    if (!map.has(key)) {
        map.set(key, {
            companyKey: key,
            companyName: getCompanyDisplayName(company),
            plannedPilgrims: 0,
            totalPilgrims: 0,
            planTypeCodes: new Set(),
            plannedResidenceKeys: new Set(),
            totalResidenceKeys: new Set()
        });
    }

    return map.get(key);
}

function ensureCenterMetricsEntry(map, company, centerNumber, centerName = '') {
    const key = centerKey(company, centerNumber);
    if (!map.has(key)) {
        map.set(key, {
            centerKey: key,
            centerNumber: centerNumberValue(centerNumber),
            centerName: getCenterDisplayName(company, centerNumber, centerName),
            companyKey: companyKey(company),
            companyName: getCompanyDisplayName(company),
            plannedPilgrims: 0,
            totalPilgrims: 0,
            planTypeCodes: new Set(),
            plannedResidenceKeys: new Set(),
            totalResidenceKeys: new Set()
        });
    }

    return map.get(key);
}

function collectPlannedMetrics(rows) {
    const companyMetrics = new Map();
    const centerMetrics = new Map();

    rows.forEach(row => {
        const company = row['owner_company_name'];
        const centerNumber = row['owner_office_number'];
        const companyEntry = ensureCompanyMetricsEntry(companyMetrics, company);
        const centerEntry = ensureCenterMetricsEntry(centerMetrics, company, centerNumber);
        const plannedPilgrims = toNumber(row['number_of_haj']);
        const planTypeCode = String(row['plan_type_code'] || row['plan_type_name'] || '').trim();
        const residenceName = String(
            (row['start_point_type'] === 'residence' && row['start_point_name'])
            || (row['end_point_type'] === 'residence' && row['end_point_name'])
            || ''
        ).trim();

        companyEntry.plannedPilgrims += plannedPilgrims;
        centerEntry.plannedPilgrims += plannedPilgrims;
        if (planTypeCode) {
            companyEntry.planTypeCodes.add(planTypeCode);
            centerEntry.planTypeCodes.add(planTypeCode);
        }

        if (residenceName) {
            const residenceKey = normalizeTextKey(residenceName);
            companyEntry.plannedResidenceKeys.add(residenceKey);
            centerEntry.plannedResidenceKeys.add(residenceKey);
        }
    });

    return { companyMetrics, centerMetrics };
}

function collectAssignmentMetrics(rows = null) {
    const companyMetrics = new Map();
    const centerMetrics = new Map();
    const allocatedByCompanyAssignment = new Map();
    const allocatedByCenterAssignment = new Map();
    const sourceRows = Array.isArray(rows) ? rows : null;

    const addAllocatedAssignment = (row) => {
        const company = sourceRows ? row['owner_company_name'] : row.company;
        const centerNumber = sourceRows ? row['owner_office_number'] : row.centerNumber;
        const serviceCenterName = sourceRows ? getPlanServiceCenterName(row) : row.serviceCenterName;
        const assignmentKey = sourceRows
            ? getAssignmentRecordKey(row)
            : (row.assignmentKey || centerKey(row.company, row.centerNumber) + '|' + String(row.campLabel || '').trim());
        const pilgrims = sourceRows ? getAllocatedPilgrims(row) : toNumber(row.pilgrims);
        const companyEntry = ensureCompanyMetricsEntry(companyMetrics, company);
        const centerEntry = ensureCenterMetricsEntry(centerMetrics, company, centerNumber, serviceCenterName);
        const companyAssignmentKey = companyEntry.companyKey + '|' + assignmentKey;
        const centerAssignmentKey = centerEntry.centerKey + '|' + assignmentKey;

        const previousCompany = allocatedByCompanyAssignment.get(companyAssignmentKey) || 0;
        if (pilgrims > previousCompany) {
            companyEntry.totalPilgrims += pilgrims - previousCompany;
            allocatedByCompanyAssignment.set(companyAssignmentKey, pilgrims);
        }

        const previousCenter = allocatedByCenterAssignment.get(centerAssignmentKey) || 0;
        if (pilgrims > previousCenter) {
            centerEntry.totalPilgrims += pilgrims - previousCenter;
            allocatedByCenterAssignment.set(centerAssignmentKey, pilgrims);
        }
    };

    (sourceRows || campAssignmentRecords).forEach(addAllocatedAssignment);

    const addResidenceAssignment = (row) => {
        const company = sourceRows ? row['owner_company_name'] : row.company;
        const centerNumber = sourceRows ? row['owner_office_number'] : row.centerNumber;
        const serviceCenterName = sourceRows ? getPlanServiceCenterName(row) : row.serviceCenterName;
        const residenceName = sourceRows ? getResidenceNameFromPlan(row) : row.residenceName;
        const companyEntry = ensureCompanyMetricsEntry(companyMetrics, company);
        const centerEntry = ensureCenterMetricsEntry(centerMetrics, company, centerNumber, serviceCenterName);

        if (residenceName) {
            companyEntry.totalResidenceKeys.add(residenceName);
            centerEntry.totalResidenceKeys.add(residenceName);
        }
    };

    (sourceRows || residenceAssignmentRecords).forEach(addResidenceAssignment);

    // Also process residence assignment data from CSV
    if (!sourceRows && residenceAssignmentRows.length > 0) {
        residenceAssignmentRows.forEach(row => {
            const company = row.serviceCompany;
            const centerNumber = row.serviceCenterNumber;
            const serviceCenterName = row.serviceCenterName;
            const residenceKey = row.licenseNumber ? `${row.licenseNumber}|${row.residenceName}` : row.residenceName;

            const companyEntry = ensureCompanyMetricsEntry(companyMetrics, company);
            const centerEntry = ensureCenterMetricsEntry(centerMetrics, company, centerNumber, serviceCenterName);

            if (residenceKey) {
                companyEntry.totalResidenceKeys.add(residenceKey);
                centerEntry.totalResidenceKeys.add(residenceKey);
            }
        });
    }

    return { companyMetrics, centerMetrics };
}

function getPlanTypeTargetMultiplier(plannedEntry = null) {
    return 1;
}

function isMainPlanType(row) {
    const code = String(row['plan_type_code'] || '').trim();
    const name = String(row['plan_type_name'] || '').trim();
    return code === 'tarwia'
        || code === 'direct_taseed'
        || name === 'تروية'
        || name === 'تصعيد مباشر';
}

function isTarwiyaKpiTotalPlanType(row) {
    const code = String(row['plan_type_code'] || '').trim();
    const name = String(row['plan_type_name'] || '').trim();
    return code === 'tarwia'
        || code === 'direct_taseed'
        || name === 'تروية'
        || name === 'تصعيد مباشر';
}

function calculateKpiTotalPilgrims(rows) {
    return rows.reduce((sum, row) => sum + toNumber(row['number_of_haj']), 0);
}

function getServiceCompanyPilgrimTotals(rows) {
    const totals = new Map();

    rows.forEach(row => {
        if (!isTarwiyaKpiTotalPlanType(row)) return;
        const company = row['owner_company_name'];
        const key = companyKey(company);
        if (!key) return;

        const current = totals.get(key) || {
            companyKey: key,
            companyName: getCompanyDisplayName(company),
            totalPilgrims: 0
        };
        current.totalPilgrims += toNumber(row['number_of_haj']);
        totals.set(key, current);
    });

    return totals;
}

function calculateCompletionPercentage(plannedPilgrims, totalPilgrims) {
    if (!totalPilgrims) return 0;
    return (plannedPilgrims / totalPilgrims) * 100;
}

function clampCompletionPercentage(value) {
    const safeValue = Number.isFinite(value) ? value : 0;
    return Math.min(Math.max(safeValue, 0), 100);
}

function formatCompletionPercentage(value) {
    const safeValue = clampCompletionPercentage(value);
    return `${safeValue >= 100 ? safeValue.toFixed(0) : safeValue.toFixed(1)}%`;
}

function sortRowsByCompletion(rows) {
    return rows.sort((a, b) => {
        if (b.completion !== a.completion) return b.completion - a.completion;
        if (b.totalPilgrims !== a.totalPilgrims) return b.totalPilgrims - a.totalPilgrims;
        return a.label.localeCompare(b.label, 'ar');
    });
}

function buildServiceCompanyRows(rows, totalRows = rows) {
    const planned = collectPlannedMetrics(rows).companyMetrics;
    const totals = getServiceCompanyPilgrimTotals(totalRows);
    const residences = getAssignmentTotalsForDisplay(totalRows).companyMetrics;
    const companyKeys = new Set();

    serviceCompaniesCatalog.forEach(item => companyKeys.add(item.key));
    planned.forEach((_, key) => companyKeys.add(key));
    totals.forEach((_, key) => companyKeys.add(key));

    return sortRowsByCompletion(Array.from(companyKeys).map(key => {
        const plannedEntry = planned.get(key);
        const totalEntry = totals.get(key);
        const residenceEntry = residences.get(key);
        const label = serviceCompanyNameByKey.get(key)
            || plannedEntry?.companyName
            || totalEntry?.companyName
            || residenceEntry?.companyName
            || 'غير معروف';
        const plannedPilgrims = plannedEntry?.plannedPilgrims || 0;
        const totalPilgrims = totalEntry?.totalPilgrims || 0;
        const completionTargetPilgrims = totalPilgrims * getPlanTypeTargetMultiplier(plannedEntry);

        return {
            type: 'company',
            companyKey: key,
            label,
            totalPilgrims,
            residences: residenceEntry?.totalResidenceKeys.size || 0,
            completion: calculateCompletionPercentage(plannedPilgrims, completionTargetPilgrims)
        };
    }));
}

function buildServiceCenterRows(rows, totalRows = rows) {
    const planned = collectPlannedMetrics(rows).centerMetrics;
    const totals = getAssignmentTotalsForDisplay(totalRows).centerMetrics;
    const rowsByCenter = [];
    const centerKeys = new Set();

    planned.forEach((entry, key) => {
        if (selectedServiceCompanies.size && !selectedServiceCompanies.has(entry.companyKey)) return;
        centerKeys.add(key);
    });

    totals.forEach((entry, key) => {
        if (selectedServiceCompanies.size && !selectedServiceCompanies.has(entry.companyKey)) return;
        centerKeys.add(key);
    });

    centerKeys.forEach(key => {
        const plannedEntry = planned.get(key);
        const totalEntry = totals.get(key);
        const companyName = plannedEntry?.companyName || totalEntry?.companyName || 'غير معروف';
        const centerNumber = plannedEntry?.centerNumber || totalEntry?.centerNumber || '';
        const centerName = plannedEntry?.centerName || totalEntry?.centerName || centerNumber || 'بدون مركز';
        const plannedPilgrims = plannedEntry?.plannedPilgrims || 0;
        const totalPilgrims = totalEntry?.totalPilgrims || 0;
        const completionTargetPilgrims = totalPilgrims * getPlanTypeTargetMultiplier(plannedEntry);
        const residences = totalEntry?.totalResidenceKeys.size || 0;

        rowsByCenter.push({
            type: 'center',
            companyKey: plannedEntry?.companyKey || totalEntry?.companyKey || 'all',
            centerKey: key,
            centerNumber,
            label: centerName,
            sublabel: companyName,
            totalPilgrims,
            residences,
            completion: calculateCompletionPercentage(plannedPilgrims, completionTargetPilgrims)
        });
    });

    return sortRowsByCompletion(rowsByCenter);
}

function createTableCell(text, className = '') {
    const cell = document.createElement('td');
    if (className) cell.className = className;
    cell.textContent = text;
    return cell;
}

function createNameCell(label, sublabel = '') {
    const cell = document.createElement('td');
    cell.className = 'entity-name-cell';

    const title = document.createElement('strong');
    title.textContent = label;
    cell.appendChild(title);

    if (sublabel) {
        const meta = document.createElement('span');
        meta.textContent = sublabel;
        cell.appendChild(meta);
    }

    return cell;
}

function getEntityRowKey(item, type = item.type) {
    return type === 'company' ? item.companyKey : item.centerKey;
}

function isEntityRowSelected(item, type = item.type) {
    return type === 'company'
        ? selectedServiceCompanies.has(item.companyKey)
        : selectedServiceCenters.has(item.centerKey);
}

function handleTableSelection(row) {
    if (row.type === 'company') {
        selectedServiceCompanies.clear();
        selectedServiceCompanies.add(row.companyKey);
        selectedServiceCenters.clear();
        selectedPlanId = null;
        selectedEntranceName = null;
        selectedPathName = null;
        selectedDistrict = null;
    } else if (row.type === 'center') {
        selectedServiceCenters.clear();
        selectedServiceCenters.add(row.centerKey);
    }

    applyFilters();
}

function getEntitySearchText(item, type) {
    return normalizeTextKey([
        item.label,
        item.sublabel,
        item.centerNumber,
        item.totalPilgrims,
        item.residences,
        formatCompletionPercentage(item.completion),
        type === 'company' ? item.companyKey : item.centerKey
    ].filter(value => value !== undefined && value !== null).join(' '));
}

function getEntitySortValue(item, sortKey) {
    if (['totalPilgrims', 'residences', 'completion'].includes(sortKey)) return Number(item[sortKey]) || 0;
    if (sortKey === 'centerNumber') {
        const value = String(item.centerNumber || '').trim();
        const numeric = Number(value.replace(/,/g, ''));
        return Number.isFinite(numeric) && value ? numeric : value;
    }
    return normalizeTextKey(item[sortKey] || '');
}

function compareEntityRows(a, b, sortKey, sortDirection) {
    const aValue = getEntitySortValue(a, sortKey);
    const bValue = getEntitySortValue(b, sortKey);
    const direction = sortDirection === 'asc' ? 1 : -1;

    if (typeof aValue === 'number' && typeof bValue === 'number') {
        if (aValue !== bValue) return (aValue - bValue) * direction;
    } else {
        const comparison = String(aValue).localeCompare(String(bValue), 'ar', { numeric: true, sensitivity: 'base' });
        if (comparison) return comparison * direction;
    }

    return String(a.label || '').localeCompare(String(b.label || ''), 'ar');
}

function prepareEntityTableRows(rows, type) {
    const state = entityTableState[type];
    const search = normalizeTextKey(state.search || '');
    const visibleRows = search
        ? rows.filter(item => getEntitySearchText(item, type).includes(search))
        : [...rows];

    visibleRows.sort((a, b) => compareEntityRows(a, b, state.sortKey, state.sortDirection));
    return visibleRows;
}

function updateEntityTableSortHeaders(type) {
    const table = document.querySelector(`.entity-table[data-table-type="${type}"]`);
    const state = entityTableState[type];
    if (!table || !state) return;

    table.querySelectorAll('thead th[data-sort-key]').forEach(header => {
        const isActive = header.dataset.sortKey === state.sortKey;
        header.classList.toggle('sorted', isActive);
        header.dataset.sortDirection = isActive ? state.sortDirection : '';
        header.setAttribute('aria-sort', isActive ? (state.sortDirection === 'asc' ? 'ascending' : 'descending') : 'none');
    });
}

function renderSummaryTable(tableBodyId, rows, type) {
    const tbody = document.getElementById(tableBodyId);
    if (!tbody) return;

    const preparedRows = prepareEntityTableRows(rows, type);
    const fragment = document.createDocumentFragment();
    const columnCount = type === 'center' ? 6 : 4;
    updateEntityTableSortHeaders(type);

    if (!preparedRows.length) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = columnCount;
        cell.className = 'entity-table-empty';
        cell.textContent = 'لا توجد بيانات';
        row.appendChild(cell);
        fragment.appendChild(row);
        tbody.replaceChildren(fragment);
        return;
    }

    preparedRows.forEach(item => {
        const row = document.createElement('tr');
        const isActive = isEntityRowSelected(item, type);

        row.className = 'entity-table-row';
        row.tabIndex = 0;
        row.dataset.rowKey = getEntityRowKey(item, type);
        row.setAttribute('aria-selected', isActive ? 'true' : 'false');
        if (isActive) row.classList.add('active');

        if (type === 'center') {
            row.appendChild(createTableCell(item.centerNumber || ''));
            row.appendChild(createNameCell(item.label));
            row.appendChild(createTableCell(item.sublabel || ''));
        } else {
            row.appendChild(createNameCell(item.label, item.sublabel || ''));
        }
        row.appendChild(createTableCell(item.totalPilgrims.toLocaleString()));
        row.appendChild(createTableCell(item.residences.toLocaleString()));

        const completionCell = document.createElement('td');
        completionCell.className = 'completion-cell';
        const badge = document.createElement('span');
        badge.className = 'completion-badge';
        badge.textContent = formatCompletionPercentage(item.completion);
        completionCell.appendChild(badge);
        row.appendChild(completionCell);

        row.addEventListener('click', () => handleTableSelection(item));
        row.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                handleTableSelection(item);
            }
        });

        fragment.appendChild(row);
    });

    tbody.replaceChildren(fragment);
}

function renderServiceSummaryTables() {
    renderSummaryTable('serviceCompaniesTableBody', buildServiceCompanyRows(filteredData, planTypeBaseData), 'company');
    renderSummaryTable('serviceCentersTableBody', buildServiceCenterRows(filteredData, planTypeBaseData), 'center');
}

function getSelectedServiceCompanyName() {
    if (!selectedServiceCompanies.size) return '';
    if (selectedServiceCompanies.size > 1) return `${selectedServiceCompanies.size.toLocaleString()} شركات محددة`;
    const key = Array.from(selectedServiceCompanies)[0];
    return serviceCompanyNameByKey.get(key)
        || key.split('|')[0]
        || 'غير معروف';
}

function getSelectedServiceCenterName() {
    if (!selectedServiceCenters.size) return '';
    if (selectedServiceCenters.size > 1) return `${selectedServiceCenters.size.toLocaleString()} مراكز محددة`;
    const key = Array.from(selectedServiceCenters)[0];
    return serviceCenterNamesByKey.get(key)
        || key.split('|')[1]
        || 'بدون مركز';
}

function updateMapSelectionTitle() {
    const titleEl = document.getElementById('mapSelectionTitle');
    if (!titleEl) return;

    const companyName = getSelectedServiceCompanyName();
    const centerName = getSelectedServiceCenterName();
    const text = centerName && companyName
        ? `${centerName} - ${companyName}`
        : (centerName || companyName);

    titleEl.textContent = text;
    titleEl.hidden = !text;
}

// Main Update Function
function updateDashboard() {
    const stats = getDashboardStats();
    updateKPIs(stats);
    updateMap();
    updateMapSelectionTitle();
    updateCharts(stats);
    renderServiceSummaryTables();
    updatePlanList();
}

function buildCompletionStats(rows) {
    const stats = {
        completionByPlanType: {},
        completionByCenterPlan: {}
    };
    const countedTargets = new Set();

    rows.forEach(d => {
        const haj = Number(d['number_of_haj']) || 0;
        const planTypeCode = d['plan_type_code'] || 'unknown';
        const planTypeName = d['plan_type_name'] || planTypeCode || 'غير معروف';
        const assignment = getAssignmentTotalForPlan(d);
        const completionKey = planTypeCode;

        if (!stats.completionByPlanType[completionKey]) {
            stats.completionByPlanType[completionKey] = { label: planTypeName, planned: 0, target: 0 };
        }
        stats.completionByPlanType[completionKey].planned += haj;

        const centerCompletionKey = completionKey + '|' + centerKey(d['owner_company_name'], d['owner_office_number']);
        if (!stats.completionByCenterPlan[centerCompletionKey]) {
            stats.completionByCenterPlan[centerCompletionKey] = {
                planTypeCode,
                planTypeName,
                label: String(d['owner_office_number'] || 'بدون مركز') + ' - ' + String(d['owner_company_name'] || 'غير معروف'),
                planned: 0,
                target: 0
            };
        }
        stats.completionByCenterPlan[centerCompletionKey].planned += haj;

        const targetKey = completionKey + '|' + centerKey(d['owner_company_name'], d['owner_office_number']);
        if (!countedTargets.has(targetKey)) {
            const target = getPlanTypeTarget(planTypeCode, assignment);
            stats.completionByPlanType[completionKey].target += target;
            stats.completionByCenterPlan[centerCompletionKey].target += target;
            countedTargets.add(targetKey);
        }
    });

    return stats;
}

function getDashboardStats() {
    const stats = {
        totalPilgrims: 0,
        totalBuses: 0,
        totalTrips: 0,
        uniqueCamps: new Set(),
        uniqueResidences: new Set(),
        uniqueServiceCenters: new Set(),
        periodCounts: {},
        transportCounts: {},
        entranceCounts: {},
        allPeriodsForEntrance: new Set(),
        pathCounts: {},
        districtCounts: {},
        completionByPlanType: {},
        completionByCenterPlan: {},
        campAssignmentStats: getCampAssignmentStats()
    };
    const countedTargets = new Set();

    filteredData.forEach(d => {
        const haj = Number(d['number_of_haj']) || 0;
        const buses = Number(d['number_of_buses']) || 0;
        const period = d['period'] || 'غير معروف';
        const transportType = d['transport_type_name'] || 'غير معروف';
        const entrance = d['entrance_name'] || d['entrance_asm_code'] || 'بدون مدخل';
        const path = d['path_name'] || 'بدون مسار';
        const district = d['start_point_district'] || 'بدون حي';
        const planTypeCode = d['plan_type_code'] || 'unknown';
        const planTypeName = d['plan_type_name'] || planTypeCode || 'غير معروف';
        const assignment = getAssignmentTotalForPlan(d);
        const completionKey = planTypeCode;

        stats.totalPilgrims += haj;
        stats.totalBuses += buses;
        stats.totalTrips += getTripCount(d, buses);

        if (d['camp_label']) stats.uniqueCamps.add(d['camp_label']);
        if (d['start_point_type'] === 'residence' && d['start_point_name']) stats.uniqueResidences.add(d['start_point_name']);
        if (d['end_point_type'] === 'residence' && d['end_point_name']) stats.uniqueResidences.add(d['end_point_name']);
        if (d['owner_office_number']) {
            stats.uniqueServiceCenters.add(centerKey(d['owner_company_name'], d['owner_office_number']));
        }

        addToBucket(stats.periodCounts, String(period), haj);
        addToBucket(stats.transportCounts, transportType, buses);
        addToBucket(stats.pathCounts, path, buses);
        addToBucket(stats.districtCounts, district, haj);

        if (!stats.entranceCounts[entrance]) stats.entranceCounts[entrance] = {};
        stats.entranceCounts[entrance][period] = (stats.entranceCounts[entrance][period] || 0) + buses;
        stats.allPeriodsForEntrance.add(period);

        if (!stats.completionByPlanType[completionKey]) {
            stats.completionByPlanType[completionKey] = { label: planTypeName, planned: 0, target: 0 };
        }
        stats.completionByPlanType[completionKey].planned += haj;

        const centerCompletionKey = `${completionKey}|${centerKey(d['owner_company_name'], d['owner_office_number'])}`;
        if (!stats.completionByCenterPlan[centerCompletionKey]) {
            stats.completionByCenterPlan[centerCompletionKey] = {
                planTypeCode,
                planTypeName,
                label: `${d['owner_office_number'] || 'بدون مركز'} - ${d['owner_company_name'] || 'غير معروف'}`,
                planned: 0,
                target: 0
            };
        }
        stats.completionByCenterPlan[centerCompletionKey].planned += haj;

        const targetKey = `${completionKey}|${centerKey(d['owner_company_name'], d['owner_office_number'])}`;
        if (!countedTargets.has(targetKey)) {
            const target = getPlanTypeTarget(planTypeCode, assignment);
            stats.completionByPlanType[completionKey].target += target;
            stats.completionByCenterPlan[centerCompletionKey].target += target;
            countedTargets.add(targetKey);
        }
    });

    return stats;
}

function getTripCount(row, buses) {
    const transportType = row['transport_type_name'] || '';
    if (transportType.includes('ردين')) return buses * 2;
    if (transportType.includes('ترددي')) return buses * 3;
    if (transportType.includes('رد') || transportType.includes('ىد')) return buses;
    return buses;
}

// Update KPI Cards
function updateKPIs(stats) {
    const totalPilgrims = stats.totalPilgrims;
    const totalBuses = stats.totalBuses;
    const totalPlans = filteredData.length;
    const totalTrips = stats.totalTrips;
    const totalCamps = stats.uniqueCamps.size;
    const campStats = stats.campAssignmentStats;
    const plannedServiceCenters = stats.uniqueServiceCenters.size;
    const residenceStats = getResidenceAssignmentStats();
    const totalResidences = getTotalResidencesFromRawData();

    // Animate numbers
    const pilgrimsElement = document.getElementById('kpiPilgrims');
    pilgrimsElement.textContent = `${totalPilgrims.toLocaleString()}/${campStats.totalPilgrims.toLocaleString()}`;
    pilgrimsElement.previousElementSibling.textContent = 'الحجاج (مخطط/إجمالي)';
    pilgrimsElement.title = 'الحجاج المخططون حسب نوع الخطة المحدد / إجمالي تروية وتصعيد تروية';
    document.getElementById('kpiBuses').textContent = totalBuses.toLocaleString();
    document.getElementById('kpiPlans').textContent = totalPlans.toLocaleString();
    document.getElementById('kpiTrips').textContent = totalTrips.toLocaleString();
    const serviceCentersElement = document.getElementById('kpiServiceCenters');
    if (serviceCentersElement) {
        serviceCentersElement.textContent = `${plannedServiceCenters.toLocaleString()}/${campStats.serviceCenterCount.toLocaleString()}`;
        serviceCentersElement.previousElementSibling.textContent = 'مراكز الخدمة (مخطط/إجمالي)';
        serviceCentersElement.title = 'مراكز الخدمة من البيانات المعروضة / إجمالي مراكز الخدمة من data.js';
    }

    const residencesElement = document.getElementById('kpiResidences');
    if (residencesElement) {
        residencesElement.textContent = `${residenceStats.totalResidences.toLocaleString()}/${residenceStats.totalAssigned.toLocaleString()}`;
        residencesElement.previousElementSibling.textContent = 'عدد المساكن (مخطط/إجمالي)';
        residencesElement.title = 'المساكن من الخطط / إجمالي المساكن المخصصة للشركة';
    }
    
    // Display camps with numerator/denominator format
    const campElement = document.getElementById('kpiCamps');
    if (campElement) {
        // Get denominator from assign_camps.js instead of from CSV
        const assignCampsCampCount = getCampCountFromAssignCamps();
        campElement.textContent = `${totalCamps.toLocaleString()}/${assignCampsCampCount.toLocaleString()}`;
        campElement.previousElementSibling.textContent = 'مخيمات (مخطط/إجمالي)';
        campElement.title = `${campStats.totalAssignments} تخصيص`;
    }

    // Update secondary stats display
    updateSecondaryStats(stats);
}

// Update secondary statistics display (detailed camp info)
function updateSecondaryStats(stats) {
    const campStats = stats.campAssignmentStats;
    
    // Create tooltip/info for camp assignments
    if (campStats && campStats.allNumerators && campStats.allDenominators) {
        const campInfo = {
            numerators: campStats.allNumerators.length,
            denominators: campStats.allDenominators.length,
            assignments: campStats.totalAssignments
        };
        
        // Store for potential use in tooltips or detailed views
        window.campStatistics = campInfo;
    }
}

// Update Map Routes
function updateMap() {
    routeLayerGroup.clearLayers();
    districtsLayerGroup.clearLayers();
    const mapStatus = document.getElementById('mapStatus');
    const bounds = L.latLngBounds();
    const serviceEntitySelectionActive = hasServiceEntitySelection();
    const isFocusedSelection = Boolean(selectedPlanId || selectedEntranceName || selectedPathName || selectedDistrict || serviceEntitySelectionActive);
    const mapData = isFocusedSelection ? filteredData : filteredData.slice(0, MAP_RENDER_LIMIT);
    const showDetailedMapLabels = Boolean(selectedPlanId || serviceEntitySelectionActive) || filteredData.length <= MAP_DETAIL_LABEL_LIMIT;

    if (mapStatus) {
        mapStatus.hidden = true;
        mapStatus.textContent = '';
    }

    let selectedDistrictBounds = null;

    // Draw Districts - GeoJSON data removed

    mapData.forEach(row => {
        try {
            const geojsonsToRender = getRowGeojsons(row);

            if (geojsonsToRender.length === 0) return;

            const connectedLineLatLngsByItem = new Map();
            const lineItems = geojsonsToRender.filter(item => item.geojson?.type === 'LineString' || item.geojson?.type === 'MultiLineString');
            const connectedLineSequence = orientConnectedRouteSegments(row, lineItems);
            connectedLineSequence.forEach(orientedItem => {
                const sourceItem = geojsonsToRender.find(item => item.type === orientedItem.type && item.geojson === orientedItem.geojson);
                if (sourceItem) connectedLineLatLngsByItem.set(sourceItem, orientedItem.latlngs);
            });

            geojsonsToRender.forEach(item => {
                const geojson = item.geojson;
                if (geojson && geojson.coordinates) {
                    extendBoundsFromGeojson(bounds, geojson);
                    let latlngs = [];
                    // Colors and Styles
                    let color = '#3b82f6';
                    let fillColor = '#93c5fd';
                    if (item.type === 'internal') { color = '#10b981'; fillColor = '#6ee7b7'; }
                    else if (item.type === 'entrance') { color = '#EBC468'; fillColor = '#fcd34d'; }
                    else if (item.type === 'start') { color = '#22c55e'; fillColor = '#86efac'; }
                    else if (item.type === 'end') { color = '#ef4444'; fillColor = '#fca5a5'; }

                    if (geojson.type === 'Point') {
                        let coord = geojson.coordinates;
                        if (item.isResidence) {
                            const marker = L.circleMarker([coord[1], coord[0]], {
                                radius: 7,
                                fillColor: '#ffffff',
                                color: '#0ea5e9',
                                weight: 3,
                                opacity: 1,
                                fillOpacity: 1,
                                className: 'residence-circle-marker'
                            }).addTo(routeLayerGroup);
                            bindPopupToLayer(marker, row, item);
                            if (showDetailedMapLabels) {
                                addMapLabel([coord[1], coord[0]], getPointLabel(row, item), 'map-point-label');
                            }
                        } else {
                            const marker = L.circleMarker([coord[1], coord[0]], {
                                radius: 6,
                                fillColor: color,
                                color: '#fff',
                                weight: 2,
                                opacity: 1,
                                fillOpacity: 0.9
                            }).addTo(routeLayerGroup);
                            bindPopupToLayer(marker, row, item);
                            if (showDetailedMapLabels) {
                                addMapLabel([coord[1], coord[0]], getPointLabel(row, item), 'map-point-label');
                            }
                        }
                    } else if (geojson.type === 'Polygon' || geojson.type === 'MultiPolygon') {
                        const coords = geojson.type === 'Polygon' ? geojson.coordinates[0] : geojson.coordinates[0][0];
                        latlngs = coords.map(coord => [coord[1], coord[0]]);

                        if (item.isResidence) {
                            // Calculate simple center of polygon by averaging points
                            let sumLat = 0, sumLng = 0;
                            latlngs.forEach(ll => { sumLat += ll[0]; sumLng += ll[1]; });
                            let center = [sumLat / latlngs.length, sumLng / latlngs.length];

                            const marker = L.circleMarker(center, {
                                radius: 7,
                                fillColor: '#ffffff',
                                color: '#0ea5e9',
                                weight: 3,
                                opacity: 1,
                                fillOpacity: 1,
                                className: 'residence-circle-marker'
                            }).addTo(routeLayerGroup);
                            bindPopupToLayer(marker, row, item);
                            if (showDetailedMapLabels) {
                                addMapLabel(center, getPointLabel(row, item), 'map-point-label');
                            }
                        } else {
                            const polygon = L.polygon(latlngs, {
                                color: color,
                                weight: 2,
                                opacity: 0.8,
                                fillOpacity: 0.4,
                                fillColor: fillColor,
                                className: 'route-polygon'
                            }).addTo(routeLayerGroup);

                            bindPopupToLayer(polygon, row, item);
                            if (showDetailedMapLabels) {
                                const areaLabel = getAreaLabel(row, item);
                                if (areaLabel) addMapLabel(centerOfPolygon(latlngs), areaLabel, 'map-line-label', 'center');
                            }
                        }
                    } else if (geojson.type === 'LineString' || geojson.type === 'MultiLineString') {
                        // Support MultiLineString if needed
                        let coords = geojson.type === 'LineString' ? geojson.coordinates : geojson.coordinates[0];
                        latlngs = connectedLineLatLngsByItem.get(item) || coords.map(coord => [coord[1], coord[0]]);
                        if (!connectedLineLatLngsByItem.has(item)) {
                            latlngs = orientLatLngsForRoute(latlngs, row, item);
                        }

                        const halo = L.polyline(latlngs, {
                            color: '#ffffff',
                            weight: 7,
                            opacity: 0.9,
                            className: 'route-line-halo'
                        }).addTo(routeLayerGroup);

                        const polyline = L.polyline(latlngs, {
                            color: color,
                            weight: 4,
                            opacity: 0.95,
                            className: 'route-line'
                        }).addTo(routeLayerGroup);

                        bindPopupToLayer(halo, row, item);
                        bindPopupToLayer(polyline, row, item);
                        if (showDetailedMapLabels) {
                            addDirectionalArrows(latlngs, color);
                            const areaLabel = getAreaLabel(row, item);
                            const midpoint = getMidpointLatLng(latlngs);
                            if (areaLabel && midpoint && item.type !== 'external') {
                                addMapLabel(midpoint, areaLabel, 'map-line-label', 'center');
                            }
                        }
                    }
                }
            });

            if (connectedLineSequence.length > 1) {
                for (let index = 0; index < connectedLineSequence.length - 1; index++) {
                    const current = connectedLineSequence[index].latlngs;
                    const next = connectedLineSequence[index + 1].latlngs;
                    addRouteConnector(current[current.length - 1], next[0]);
                }
            }
        } catch (e) {
            // console.warn("Failed to render geometry for row", row['ID'], e);
        }
    });

    if (selectedDistrictBounds && selectedDistrictBounds.isValid()) {
        fitMapToGeometry(selectedDistrictBounds);
        updateMapLabelScale();
        return;
    }

    fitMapToGeometry(bounds);
    updateMapLabelScale();
}

function bindPopupToLayer(layer, row, item = null) {
    layer.on('click', function (e) {
        L.DomEvent.stopPropagation(e);
        if (selectedPlanId === row['plan_id']) {
            selectedPlanId = null;
        } else {
            selectedPlanId = row['plan_id'];
        }
        applyFilters();
    });

    // Hover effects
    const originalWeight = layer.options.weight || 2;
    const originalColor = layer.options.color || '#3b82f6';
    const originalOpacity = layer.options.opacity || 0.6;

    layer.on('mouseover', function (e) {
        this.setStyle({ weight: 6, color: '#8b5cf6', opacity: 1 });
    });
    layer.on('mouseout', function (e) {
        this.setStyle({ weight: originalWeight, color: originalColor, opacity: originalOpacity });
    });
}

function renderEntranceFloatingLegend(periodsArray, colors) {
    const legendEl = document.getElementById('entranceFloatingLegend');
    if (!legendEl) return;

    if (!Array.isArray(periodsArray) || periodsArray.length === 0) {
        legendEl.innerHTML = '';
        return;
    }

    legendEl.innerHTML = periodsArray
        .map((period, index) => {
            const color = colors[index % colors.length];
            return `<span class="chart-floating-legend-item"><span class="chart-floating-legend-swatch" style="background:${color}"></span>الفترة ${period}</span>`;
        })
        .join('');
}

// Update Charts
function updateCharts(stats = getDashboardStats()) {
    const chartTheme = getThemeColors();
    const plotlyConfig = {
        responsive: true,
        displaylogo: false,
        scrollZoom: true,
        modeBarButtonsToAdd: ['zoom2d', 'pan2d', 'select2d', 'lasso2d', 'resetScale2d'],
        toImageButtonOptions: { format: 'png', scale: 2 }
    };

    // Prepare Data for Period Chart
    const periodLabels = Object.keys(stats.periodCounts).sort();
    const periodValues = periodLabels.map(l => stats.periodCounts[l]);
    const periodPlotEl = document.getElementById('periodChart');
    if (periodPlotEl && window.Plotly) {
        const periodTrace = {
            type: 'bar',
            x: periodLabels,
            y: periodValues,
            text: periodValues.map(v => Number(v || 0).toLocaleString()),
            textposition: 'outside',
            cliponaxis: false,
            marker: { color: 'rgba(42, 157, 144, 0.82)', line: { color: 'rgba(42, 157, 144, 1)', width: 1 } },
            hovertemplate: '%{x}<br>%{y:,}<extra></extra>'
        };
        const periodLayout = {
            margin: { l: 46, r: 12, t: 22, b: 44 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            font: { color: chartTheme.text, family: 'Inter, IBM Plex Sans Arabic, sans-serif' },
            xaxis: { tickfont: { color: chartTheme.text }, showgrid: false, fixedrange: false },
            yaxis: { tickfont: { color: chartTheme.text }, gridcolor: chartTheme.grid, zeroline: false, fixedrange: false },
            showlegend: false,
            hovermode: 'closest',
            dragmode: 'zoom'
        };
        Plotly.react(periodPlotEl, [periodTrace], periodLayout, plotlyConfig);
        requestDashboardResize();
        periodPlotEl.on('plotly_click', event => {
            const point = event?.points?.[0];
            const label = point ? String(point.x || '').trim() : '';
            if (!label) return;
            const periodValue = String(label).replace('الفترة ', '').trim();
            const filterEl = document.getElementById('periodFilter');
            filterEl.value = filterEl.value === periodValue ? 'all' : periodValue;
            selectedPlanId = null;
            applyFilters();
        });
    }

    const transEntries = Object.entries(stats.transportCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4);
    const totalTransportBuses = Object.values(stats.transportCounts).reduce((sum, value) => sum + value, 0);
    const transportColors = [
        ["rgba(42, 157, 144, 0.92)", "rgba(148, 163, 184, 0.26)"],
        ["rgba(78, 201, 185, 0.92)", "rgba(148, 163, 184, 0.26)"],
        ["rgba(235, 196, 104, 0.92)", "rgba(148, 163, 184, 0.26)"],
        ["rgba(194, 88, 88, 0.92)", "rgba(148, 163, 184, 0.26)"]
    ];

    transportChartInstances.forEach(chart => chart.destroy());
    transportChartInstances = [];
    const transportContainer = document.getElementById("transportCharts");
    if (transportContainer) {
        transportContainer.replaceChildren();

        transEntries.forEach(([label, value], index) => {
            const rest = Math.max(totalTransportBuses - value, 0);
            const percentage = totalTransportBuses > 0 ? Math.round((value / totalTransportBuses) * 100) : 0;
            const item = document.createElement("div");
            item.className = "transport-ring-item";
            const filterEl = document.getElementById("transportFilter");
            const isActive = filterEl && filterEl.value === label;
            item.classList.toggle("active", isActive);
            item.setAttribute("aria-pressed", isActive ? "true" : "false");
            item.tabIndex = 0;
            item.setAttribute("role", "button");
            item.setAttribute("title", label + " - " + Number(value || 0).toLocaleString() + " (" + percentage + "%)");
            item.innerHTML = "<div class=\"transport-ring-container\"><canvas></canvas><span>" + percentage + "%</span></div><strong>" + label + "</strong>";
            transportContainer.appendChild(item);

            const toggleTransportFilter = () => {
                const filterEl = document.getElementById("transportFilter");
                if (!filterEl) return;
                filterEl.value = filterEl.value === label ? "all" : label;
                selectedPlanId = null;
                applyFilters();
            };

            item.addEventListener("click", toggleTransportFilter);
            item.addEventListener("keydown", event => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    toggleTransportFilter();
                }
            });

            const transportCanvas = item.querySelector("canvas");
            transportCanvas.width = TRANSPORT_RING_CANVAS_SIZE;
            transportCanvas.height = TRANSPORT_RING_CANVAS_SIZE;
            transportCanvas.style.width = TRANSPORT_RING_CANVAS_SIZE + "px";
            transportCanvas.style.height = TRANSPORT_RING_CANVAS_SIZE + "px";
            const ctxTrans = transportCanvas.getContext("2d");

            transportChartInstances.push(new Chart(ctxTrans, {
                type: "doughnut",
                data: {
                    labels: [label, "باقي الأنماط"],
                    datasets: [{
                        data: [value, rest],
                        backgroundColor: transportColors[index % transportColors.length],
                        borderWidth: 0
                    }]
                },
                options: {
                    responsive: false,
                    maintainAspectRatio: true,
                    cutout: "72%",
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            rtl: true,
                            textDirection: "rtl",
                            callbacks: {
                                label: context => context.label + ": " + Number(context.raw || 0).toLocaleString()
                            }
                        }
                    }
                }
            }));
        });
    }

    const entranceLabels = Object.keys(stats.entranceCounts).sort();
    const periodsArray = Array.from(stats.allPeriodsForEntrance).sort((a, b) => Number(a) - Number(b));

    const colors = [
        'rgba(42, 157, 144, 0.72)',
        'rgba(78, 201, 185, 0.72)',
        'rgba(235, 196, 104, 0.72)',
        'rgba(121, 28, 42, 0.72)',
        'rgba(194, 88, 88, 0.72)'
    ];

    const entranceDatasets = periodsArray.map((period, index) => {
        const data = entranceLabels.map(ent => stats.entranceCounts[ent][period] || 0);
        return {
            label: `الفترة ${period}`,
            data: data,
            backgroundColor: colors[index % colors.length],
            borderWidth: 0
        };
    });

    const entrancePlotEl = document.getElementById('entranceChart');
    if (entrancePlotEl && window.Plotly) {
        const entranceTraces = periodsArray.map((period, index) => {
            const data = entranceLabels.map(ent => stats.entranceCounts[ent][period] || 0);
            return {
                type: 'bar',
                x: entranceLabels,
                y: data,
                name: `الفترة ${period}`,
                marker: { color: colors[index % colors.length] },
                text: data.map(v => v ? Number(v).toLocaleString() : ''),
                textposition: 'outside',
                cliponaxis: false,
                hovertemplate: `%{x}<br>الفترة ${period}: %{y:,}<extra></extra>`
            };
        });
        const entranceLayout = {
            margin: { l: 46, r: 12, t: 24, b: 58 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            font: { color: chartTheme.text, family: 'Inter, IBM Plex Sans Arabic, sans-serif' },
            barmode: 'group',
            xaxis: { tickangle: -35, tickfont: { color: chartTheme.text }, showgrid: false, fixedrange: false },
            yaxis: { tickfont: { color: chartTheme.text }, gridcolor: chartTheme.grid, zeroline: false, fixedrange: false },
            showlegend: false,
            hovermode: 'closest',
            dragmode: 'zoom'
        };
        Plotly.react(entrancePlotEl, entranceTraces, entranceLayout, plotlyConfig);
        requestDashboardResize();
        entrancePlotEl.on('plotly_click', event => {
            const point = event?.points?.[0];
            const label = point ? String(point.x || '').trim() : '';
            if (!label) return;
            selectedEntranceName = selectedEntranceName === label ? null : label;
            selectedPlanId = null;
            applyFilters();
        });
    }

    renderEntranceFloatingLegend(periodsArray, colors);

    const pathLabels = Object.keys(stats.pathCounts).sort((a, b) => stats.pathCounts[b] - stats.pathCounts[a]);
    const pathValues = pathLabels.map(l => stats.pathCounts[l]);

    const pathPlotEl = document.getElementById('pathChart');
    if (pathPlotEl && window.Plotly) {
        const pathTrace = {
            type: 'bar',
            x: pathLabels,
            y: pathValues,
            marker: { color: 'rgba(78, 201, 185, 0.82)', line: { color: 'rgba(78, 201, 185, 1)', width: 1 } },
            hovertemplate: '%{x}<br>%{y:,}<extra></extra>'
        };
        const pathLayout = {
            margin: { l: 46, r: 12, t: 16, b: 58 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            font: { color: chartTheme.text, family: 'Inter, IBM Plex Sans Arabic, sans-serif' },
            xaxis: { tickangle: -35, tickfont: { color: chartTheme.text }, showgrid: false, fixedrange: false },
            yaxis: { tickfont: { color: chartTheme.text }, gridcolor: chartTheme.grid, zeroline: false, fixedrange: false },
            showlegend: false,
            hovermode: 'closest',
            dragmode: 'zoom'
        };
        Plotly.react(pathPlotEl, [pathTrace], pathLayout, plotlyConfig);
        requestDashboardResize();
        pathPlotEl.on('plotly_click', event => {
            const point = event?.points?.[0];
            const label = point ? String(point.x || '').trim() : '';
            if (!label) return;
            selectedPathName = selectedPathName === label ? null : label;
            selectedPlanId = null;
            applyFilters();
        });
    }

    renderCompletionSummaryChart(stats, chartTheme);
    renderResidenceAssignmentChart(chartTheme);

    const distLabels = Object.keys(stats.districtCounts).sort((a, b) => stats.districtCounts[b] - stats.districtCounts[a]);
    const distValues = distLabels.map(l => stats.districtCounts[l]);

    if (districtChartInstance) districtChartInstance.destroy();
    const ctxDist = document.getElementById('districtChart').getContext('2d');

    districtChartInstance = new Chart(ctxDist, {
        type: 'doughnut',
        data: {
            labels: distLabels,
            datasets: [{
                data: distValues,
                backgroundColor: [
                    'rgba(125, 113, 80, 0.72)',
                    'rgba(29, 87, 81, 0.72)',
                    'rgba(42, 157, 144, 0.72)',
                    'rgba(121, 28, 42, 0.72)',
                    'rgba(78, 201, 185, 0.72)',
                    'rgba(235, 196, 104, 0.72)',
                    'rgba(194, 88, 88, 0.72)'
                ],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '60%',
            radius: '62%',
            layout: {
                padding: { left: 28, right: 12 }
            },
            plugins: {
                legend: {
                    position: 'right',
                    rtl: true,
                    textDirection: 'rtl',
                    onClick: (event, legendItem, legend) => {
                        const label = legend.chart.data.labels[legendItem.index];
                        handleDistrictSelection(label);
                    },
                    labels: {
                        color: chartTheme.title,
                        boxWidth: 8,
                        padding: 8,
                        font: { size: 9, family: 'Inter, IBM Plex Sans Arabic, sans-serif', weight: '600' },
                        generateLabels: (chart) => {
                            const data = chart.data;
                            if (data.labels.length && data.datasets.length) {
                                return data.labels.map((label, i) => {
                                    const value = data.datasets[0].data[i];
                                    const shortLabel = String(label || "").length > 9 ? String(label).slice(0, 9) + "..." : label;
                                    return {
                                        text: `${shortLabel} - ${value.toLocaleString()}`,
                                        fillStyle: data.datasets[0].backgroundColor[i],
                                        fontColor: chartTheme.title,
                                        strokeStyle: data.datasets[0].backgroundColor[i],
                                        hidden: isNaN(data.datasets[0].data[i]) || chart.getDatasetMeta(0).data[i].hidden,
                                        index: i
                                    };
                                });
                            }
                            return [];
                        }
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(9, 9, 11, 0.96)',
                    titleColor: '#fafafa',
                    bodyColor: '#fafafa',
                    borderColor: chartTheme.border || '#27272a',
                    borderWidth: 1,
                    rtl: true,
                    textDirection: 'rtl',
                    callbacks: {
                        label: (context) => {
                            const label = context.label || '';
                            const value = context.raw || 0;
                            return `${label} - ${value.toLocaleString()}`;
                        }
                    }
                }
            },
            onClick: (event, elements, chart) => {
                if (elements && elements.length > 0) {
                    const index = elements[0].index;
                    const label = chart.data.labels[index];
                    handleDistrictSelection(label);
                }
            }
        }
    });
}

function handleDistrictSelection(label) {
    if (selectedDistrict && normalizeArabic(selectedDistrict) === normalizeArabic(label)) {
        selectedDistrict = null;
    } else {
        selectedDistrict = label;
    }

    selectedPlanId = null;
    applyFilters();

    if (selectedDistrict) {
        requestAnimationFrame(() => {
            focusDistrictOnMap(selectedDistrict);
        });
    }
}

function renderCompletionSummaryChart(stats, chartTheme) {
    const container = document.getElementById('completionSummaryCharts');
    if (!container) return;

    completionSummaryChartInstances.forEach(chart => chart.destroy());
    completionSummaryChartInstances = [];
    container.replaceChildren();

    const planTypeSelect = document.getElementById('planTypeFilter');
    const activePlanTypes = getActivePlanTypeLabels();
    const summaryStats = buildCompletionStats(planTypeBaseData.length ? planTypeBaseData : rawData);
    const rowsByLabel = new Map(Object.values(summaryStats.completionByPlanType).map(row => [row.label, row]));
    const currentPlanTypeLabels = planTypeSelect
        ? Array.from(planTypeSelect.options)
            .filter(option => option.value !== 'all')
            .map(option => option.value)
        : Array.from(rowsByLabel.keys());
    const rows = currentPlanTypeLabels
        .map(label => rowsByLabel.get(label) || { label, planned: 0, target: 0 })
        .sort((a, b) => b.target - a.target);

    rows.forEach(row => {
        const planned = row.planned;
        const target = row.target;
        const percent = target > 0 ? Math.round((planned / target) * 1000) / 10 : 0;
        const displayPercent = clampCompletionPercentage(percent);
        const complete = Math.min(planned, target);
        const remaining = Math.max(target - planned, 0);
        const over = Math.max(planned - target, 0);
        const hasVisibleProgressData = complete > 0 || remaining > 0 || over > 0;
        const ringValues = hasVisibleProgressData
            ? (over > 0 ? [complete, over] : [complete, remaining])
            : [0, 1];
        const item = document.createElement('div');
        const isSelectedPlanType = activePlanTypes.has(row.label);

        item.className = 'progress-ring-item completion-plan-ring';
        item.tabIndex = 0;
        item.setAttribute('role', 'button');
        item.setAttribute('aria-pressed', isSelectedPlanType ? 'true' : 'false');
        item.setAttribute('title', isSelectedPlanType ? 'إزالة من التصفية' : `إضافة ${row.label} للتصفية`);
        if (isSelectedPlanType) item.classList.add('active');
        item.innerHTML = `
            <div class="progress-ring-wrap">
                <canvas></canvas>
                <span>${displayPercent}%</span>
            </div>
            <strong title="${row.label}">${row.label}</strong>
        `;
        const togglePlanTypeFilter = () => {
            const select = document.getElementById('planTypeFilter');
            if (!select) return;

            selectedPlanTypes.clear();
            selectedPlanTypes.add(row.label);
            syncPlanTypeSelectValue();
            selectedPlanId = null;
            selectedEntranceName = null;
            selectedPathName = null;
            selectedDistrict = null;
            updatePlanTypeMenuState();
            applyFilters();
        };

        item.addEventListener('click', togglePlanTypeFilter);
        item.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                togglePlanTypeFilter();
            }
        });
        container.appendChild(item);

        const ringCanvas = item.querySelector('canvas');
        ringCanvas.width = TOP_RING_CANVAS_SIZE;
        ringCanvas.height = TOP_RING_CANVAS_SIZE;
        ringCanvas.style.width = TOP_RING_CANVAS_SIZE + 'px';
        ringCanvas.style.height = TOP_RING_CANVAS_SIZE + 'px';
        const ctx = ringCanvas.getContext('2d');
        completionSummaryChartInstances.push(new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: over > 0 ? ['مكتمل', 'زيادة'] : ['مكتمل', 'متبقي'],
                datasets: [{
                    data: ringValues,
                    backgroundColor: hasVisibleProgressData
                        ? (over > 0
                            ? ['rgba(42, 157, 144, 0.96)', 'rgba(235, 196, 104, 0.86)']
                            : ['rgba(42, 157, 144, 0.96)', 'rgba(148, 163, 184, 0.28)'])
                        : ['rgba(48, 220, 148, 0)', 'rgba(148, 163, 184, 0.34)'],
                    borderColor: chartTheme.border,
                    borderWidth: 2
                }]
            },
            options: {
                responsive: false,
                maintainAspectRatio: true,
                cutout: '72%',
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            title: () => row.label,
                            label: context => {
                                const rawValue = hasVisibleProgressData ? Number(context.raw) : 0;
                                return context.label + ": " + rawValue.toLocaleString();
                            },
                            afterBody: () => [
                                `الاكتمال: ${displayPercent}%`,
                                `المخطط: ${planned.toLocaleString()}`,
                                `المستهدف: ${target.toLocaleString()}`
                            ]
                        }
                    }
                }
            }
        }));
    });
}

function renderResidenceAssignmentChart(chartTheme) {
    const container = document.getElementById('residenceAssignmentCharts');
    if (!container) return;

    residenceAssignmentChartInstances.forEach(chart => chart.destroy());
    residenceAssignmentChartInstances = [];
    container.replaceChildren();

    const coverage = getResidenceAssignmentCoverage();
    const mix = getResidenceMixStats();
    const ringDefs = [
        {
            label: 'اكتمال المساكن',
            done: coverage.assigned,
            total: coverage.total,
            doneLabel: 'مراكز مرتبطة',
            restLabel: 'مراكز ناقصة',
            afterBody: percent => [
                `نسبة الربط: ${percent}%`,
                `مراكز لها مساكن: ${coverage.assigned.toLocaleString()}`,
                `إجمالي مراكز data.js: ${coverage.total.toLocaleString()}`
            ],
            colors: ['rgba(42, 157, 144, 0.96)', 'rgba(194, 88, 88, 0.86)']
        },
        {
            label: 'مساكن تروية',
            filterKey: 'tarwiyah',
            done: mix.tarwiyahOnly,
            total: mix.total,
            doneLabel: 'تروية فقط',
            restLabel: 'غير تروية فقط',
            afterBody: percent => [
                `النسبة: ${percent}%`,
                `تروية فقط: ${mix.tarwiyahOnly.toLocaleString()}`,
                `إجمالي المساكن: ${mix.total.toLocaleString()}`
            ],
            colors: ['rgba(78, 201, 185, 0.96)', 'rgba(148, 163, 184, 0.34)']
        },
        {
            label: 'مساكن تصعيد مباشر',
            filterKey: 'direct',
            done: mix.directTaseedOnly,
            total: mix.total,
            doneLabel: 'تصعيد مباشر فقط',
            restLabel: 'غير تصعيد مباشر فقط',
            afterBody: percent => [
                `النسبة: ${percent}%`,
                `تصعيد مباشر فقط: ${mix.directTaseedOnly.toLocaleString()}`,
                `إجمالي المساكن: ${mix.total.toLocaleString()}`
            ],
            colors: ['rgba(42, 157, 144, 0.96)', 'rgba(148, 163, 184, 0.34)']
        },
        {
            label: 'مساكن مختلط',
            filterKey: 'mixed',
            done: mix.mixed,
            total: mix.total,
            doneLabel: 'مختلط',
            restLabel: 'غير مختلط',
            afterBody: percent => [
                `النسبة: ${percent}%`,
                `مختلط: ${mix.mixed.toLocaleString()}`,
                `إجمالي المساكن: ${mix.total.toLocaleString()}`
            ],
            colors: ['rgba(235, 196, 104, 0.96)', 'rgba(148, 163, 184, 0.34)']
        }
    ];

    ringDefs.forEach(def => {
        const total = def.total;
        const done = Math.max(0, Math.min(def.done, total));
        const rest = Math.max(total - done, 0);
        const hasData = total > 0;
        const percent = hasData ? Math.round((done / total) * 1000) / 10 : 0;

        const item = document.createElement('div');
        item.className = 'progress-ring-item residence-assignment-ring';
        if (def.filterKey) {
            item.classList.add('completion-plan-ring');
            item.tabIndex = 0;
            item.setAttribute('role', 'button');
            const isActive = selectedResidenceMixFilter === def.filterKey;
            item.classList.toggle('active', isActive);
            item.setAttribute('aria-pressed', isActive ? 'true' : 'false');
            item.setAttribute('title', isActive ? 'إلغاء التصفية' : `تصفية حسب ${def.label}`);
        }
        item.innerHTML = `
            <div class="progress-ring-wrap">
                <canvas></canvas>
                <span>${percent}%</span>
            </div>
            <strong title="${def.label}">${def.label}</strong>
        `;
        container.appendChild(item);

        if (def.filterKey) {
            const toggleResidenceMixFilter = () => {
                selectedResidenceMixFilter = selectedResidenceMixFilter === def.filterKey ? 'all' : def.filterKey;
                selectedPlanId = null;
                selectedEntranceName = null;
                selectedPathName = null;
                selectedDistrict = null;
                applyFilters();
            };
            item.addEventListener('click', toggleResidenceMixFilter);
            item.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    toggleResidenceMixFilter();
                }
            });
        }

        const ringCanvas = item.querySelector('canvas');
        ringCanvas.width = RESIDENCE_RING_CANVAS_SIZE;
        ringCanvas.height = RESIDENCE_RING_CANVAS_SIZE;
        ringCanvas.style.width = RESIDENCE_RING_CANVAS_SIZE + 'px';
        ringCanvas.style.height = RESIDENCE_RING_CANVAS_SIZE + 'px';
        const ctx = ringCanvas.getContext('2d');
        residenceAssignmentChartInstances.push(new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: [def.doneLabel, def.restLabel],
                datasets: [{
                    data: hasData ? [done, rest] : [0, 1],
                    backgroundColor: hasData ? def.colors : ['rgba(0,0,0,0)', 'rgba(148, 163, 184, 0.34)'],
                    borderColor: chartTheme.border,
                    borderWidth: 2
                }]
            },
            options: {
                responsive: false,
                maintainAspectRatio: true,
                cutout: '72%',
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(9, 9, 11, 0.96)',
                        titleColor: chartTheme.title || '#fafafa',
                        bodyColor: chartTheme.text || '#afafaf',
                        borderColor: chartTheme.border || '#27272a',
                        borderWidth: 1,
                        rtl: true,
                        textDirection: 'rtl',
                        callbacks: {
                            title: () => def.label,
                            label: context => `${context.label}: ${Number(context.raw).toLocaleString()}`,
                            afterBody: () => def.afterBody(percent)
                        }
                    }
                }
            }
        }));
    });
}

function updatePlanList() {
    const listEl = document.getElementById('planList');
    const fragment = document.createDocumentFragment();
    listEl.replaceChildren();

    const displayData = filteredData.slice(0, PLAN_LIST_LIMIT);

    displayData.forEach(plan => {
        const div = document.createElement('div');
        div.className = 'plan-item' + (selectedPlanId === plan['plan_id'] ? ' active' : '');
        const buses = Number(plan['number_of_buses']) || 0;
        const trips = getTripCount(plan, buses);
        const planType = plan['plan_type_name'] || plan['plan_type_code'] || 'غير معروف';
        const transportType = plan['transport_type_name'] || 'غير معروف';

        div.innerHTML = `
            <div class="plan-header">
                <span class="plan-company">${plan['owner_company_name'] || 'غير معروف'}</span>
                <span class="plan-time">${plan['timing_start_at'] || ''} - ${plan['timing_end_at'] || ''}</span>
            </div>
            <div class="plan-details">
                <div class="plan-stat">🚌 ${plan['number_of_buses']}</div>
                <div class="plan-stat">🛣️ ${trips.toLocaleString()}</div>
                <div class="plan-stat plan-type-stat" title="${planType}">📋 ${planType}</div>
                <div class="plan-stat plan-type-stat transport-type-stat" title="${transportType}">🚐 ${transportType}</div>
                <div class="plan-stat">👥 ${plan['number_of_haj']}</div>
                <div class="plan-stat">⏱️ ${plan['period'] || ''}</div>
            </div>
            <div class="plan-route" style="padding: 8px; font-size: 11px; border-top: 1px solid #243249; margin-top: 8px;">
                <div style="margin: 4px 0;"><strong>من:</strong> ${plan['start_point_name'] || 'غير متوفر'}</div>
                <div style="margin: 4px 0;"><strong>إلى:</strong> ${plan['end_point_name'] || 'غير متوفر'}</div>
            </div>
        `;

        div.addEventListener('click', () => {
            selectedPlanId = (selectedPlanId === plan['plan_id']) ? null : plan['plan_id'];
            applyFilters();
        });

        fragment.appendChild(div);
    });

    if (filteredData.length > PLAN_LIST_LIMIT) {
        const more = document.createElement('div');
        more.className = 'plan-list-more';
        more.textContent = `+ ${(filteredData.length - PLAN_LIST_LIMIT).toLocaleString()} خطط إضافية (استخدم التصفية)`;
        fragment.appendChild(more);
    }

    listEl.appendChild(fragment);
}
