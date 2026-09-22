// Global State
let rawData = [];
let filteredData = [];
let contextFilteredData = [];
let planTypeBaseData = [];
let map;
let routeLayerGroup;
let camerasLayerGroup;
let showCameras = false;
let campsGatesLayerGroup;
let showCampsGates = false;
let makafPathsLayerGroup;
let showTarwiaExitPaths = false;

// Performance Caches
let cachedFilteredGeometries = null;
let cachedFilteredGeometriesKey = null;
// Camera plan cache (rebuilt async after every filter change)
let cameraPlanCache = new Map(); // cameraName → { totalBuses, totalTrips, byKey }
let cameraCacheKey = null;
let cameraCacheBuilding = false;
let cachedDashboardStats = null;
let cachedDashboardStatsKey = null;
let cachedDashboardRenderKey = null;
let cachedMapRenderKey = null;
let districtChartTheme = null;
let chartUpdateTimerId = null;
let periodChartInstance = null;
let entranceChartInstance = null;
let pathChartInstance = null;
let districtChartInstance = null;
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
let selectedCampLabel = '';
let selectedResidenceMixFilter = 'all';
let companyDD = null;
let centerDD = null;
let campDD = null;
const selectedChartMetrics = {
    period: 'trips',
    entrance: 'trips',
    path: 'trips',
    district: 'pilgrims'
};
const entityTableState = {
    company: { search: '', sortKey: 'completion', sortDirection: 'desc' },
    center: { search: '', sortKey: 'completion', sortDirection: 'desc' }
};
let selectedPlanTypes = new Set();
let serviceCompaniesCatalog = [];
let serviceCompanyNameByKey = new Map();
let serviceCenterNamesByKey = new Map();
let plansCsvLoadSequence = 0;
let activePlansCsvSource = '';
let dashboardResizeFrameId = null;
const TOP_RING_CANVAS_SIZE = 64;
const RESIDENCE_RING_CANVAS_SIZE = TOP_RING_CANVAS_SIZE;
const TRANSPORT_RING_CANVAS_SIZE = TOP_RING_CANVAS_SIZE;

const segmentPctPlugin = {
    id: 'segmentPct',
    afterDraw(chart) {
        if (chart.options?.plugins?.segmentPct?.display === false) return;
        const { ctx, data } = chart;
        const dataset = data.datasets[0];
        const total = dataset.percentageTotal ?? dataset.data.reduce((s, v) => s + (v || 0), 0);
        if (!total) return;
        const meta = chart.getDatasetMeta(0);
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        meta.data.forEach((arc, i) => {
            const val = data.datasets[0].data[i];
            const pct = Math.round(val / total * 100);
            if (pct < 3) return;
            const arcSpan = arc.endAngle - arc.startAngle;
            if (arcSpan < 0.18) return;
            const midAngle = (arc.startAngle + arc.endAngle) / 2;
            const r = (arc.outerRadius + arc.innerRadius) / 2;
            const thickness = arc.outerRadius - arc.innerRadius;
            const arcLength = arcSpan * r;
            const label = pct + '%';
            let fontSize = Math.min(thickness * 0.52, arcLength * 0.34, 12);
            fontSize = Math.max(Math.floor(fontSize), 8);
            ctx.font = `bold ${fontSize}px sans-serif`;
            const textWidth = ctx.measureText(label).width;
            if (textWidth > arcLength * 0.78 || textWidth > thickness * 1.7) return;
            const x = arc.x + Math.cos(midAngle) * r;
            const y = arc.y + Math.sin(midAngle) * r;
            ctx.fillStyle = '#fff';
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
            ctx.lineWidth = Math.max(2, fontSize * 0.18);
            ctx.strokeText(label, x, y);
            ctx.fillText(label, x, y);
        });
        ctx.restore();
    }
};

// Chart fills come from the themed --chart-* tokens rather than literals, so the
// ramp changes with the theme and stays validated against each surface.
// One control per dimension: the distribution IS the filter. This replaces the
// old chip-row + donut pair, which showed the same taxonomy twice in two visual
// languages where only one was clickable. A stacked bar also compares four
// similar-sized categories far better than a donut, and long Arabic labels sit
// inline instead of colliding with the ring.
// Segments may carry their own `pct` (e.g. completion against a target) when
// the share of the bar total is not the meaningful number; `equalWidth` then
// stops widths from implying a proportion that does not exist.
function renderSegmentedFilter(containerId, { title, segments, selected, onSelect, equalWidth = false }) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const total = segments.reduce((sum, seg) => sum + (Number(seg.amount) || 0), 0);
    container.replaceChildren();
    container.classList.add('filter-bar');

    const head = document.createElement('div');
    head.className = 'filter-bar-head';

    const titleEl = document.createElement('span');
    titleEl.className = 'filter-bar-title';
    titleEl.textContent = title;
    head.appendChild(titleEl);

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'filter-bar-reset';
    reset.innerHTML = 'الكل <i class="fa-solid fa-xmark"></i>';
    reset.hidden = selected === null || selected === undefined;
    reset.addEventListener('click', () => onSelect(null));
    head.appendChild(reset);
    container.appendChild(head);

    const track = document.createElement('div');
    track.className = 'filter-bar-track';
    // With a selection the other segments step back so the chosen one is the
    // only segment at full strength (see .has-selection in styles.css).
    track.classList.toggle('has-selection', selected !== null && selected !== undefined);
    track.setAttribute('role', 'tablist');
    track.setAttribute('aria-label', title);

    segments.forEach((seg) => {
        const amount = Number(seg.amount) || 0;
        const share = total > 0 ? amount / total : 0;
        const percent = Number.isFinite(seg.pct) ? Math.round(seg.pct) : Math.round(share * 100);
        const isSelected = selected === seg.value;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'filter-seg' + (isSelected ? ' selected' : '') + (amount === 0 ? ' empty' : '');
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
        // Empty categories keep a fixed slot so the taxonomy stays visible, but
        // selecting one would only blank the dashboard, so they are inert. Once a
        // segment is selected the others read 0% only because of that selection,
        // so they stay clickable to allow switching. The rest share the
        // remaining width in proportion to their value.
        if (amount === 0) {
            btn.style.flex = '0 0 auto';
            if (selected === null || selected === undefined) {
                btn.disabled = true;
                btn.setAttribute('aria-disabled', 'true');
            }
        } else {
            btn.style.flex = equalWidth ? '1 1 0' : `${share} 1 0`;
            btn.style.background = seg.color;
            // The ramp runs from near-white to deep green, so no single theme
            // colour reads on every step — pick ink per segment from its fill.
            btn.style.color = inkForFill(seg.color);
        }
        btn.title = seg.tooltip || `${seg.label} — ${percent}% (${amount.toLocaleString('ar-EG')})`;
        btn.innerHTML =
            (isSelected ? '<i class="fa-solid fa-check filter-seg-check" aria-hidden="true"></i>' : '') +
            `<span class="filter-seg-label">${escapeHtml(seg.label)}</span>` +
            `<span class="filter-seg-pct">${percent}%</span>`;
        btn.addEventListener('click', () => onSelect(isSelected ? null : seg.value));
        track.appendChild(btn);
    });

    container.appendChild(track);
}

// Black or white text, whichever contrasts more with a hex fill (WCAG luminance).
function inkForFill(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return '';
    const [r, g, b] = [0, 2, 4].map(i => {
        const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return lum > 0.179 ? '#1e1e1e' : '#ffffff';
}

function chartRamp(count) {
    const styles = getComputedStyle(document.body);
    const steps = [1, 2, 3, 4, 5]
        .map(i => styles.getPropertyValue(`--chart-${i}`).trim())
        .filter(Boolean);
    if (!steps.length) return [];
    if (count >= steps.length) return steps.slice(0, count);
    // Spread the chosen steps across the ramp so a 3-series chart uses the light,
    // middle and dark ends rather than three neighbours.
    const spread = [];
    for (let i = 0; i < count; i++) {
        spread.push(steps[Math.round(i * (steps.length - 1) / Math.max(count - 1, 1))]);
    }
    return spread;
}

function formatRingPercent(value, total) {
    if (!total || !value) return '0%';
    return Math.round((value / total) * 100) + '%';
}

const CHART_METRIC_DEFS = {
    pilgrims: { label: 'الحجاج', periodTitle: 'الحجاج/الفترة', entranceTitle: 'الحجاج/مدخل', pathTitle: 'الحجاج/المسار', districtTitle: 'الحجاج حسب الحي' },
    buses: { label: 'الحافلات', periodTitle: 'الحافلات حسب الفترة', entranceTitle: 'الحافلات لكل مدخل', pathTitle: 'الحافلات حسب المسار', districtTitle: 'الحافلات حسب الحي' },
    trips: { label: 'الرحلات', periodTitle: 'الرحلات حسب الفترة', entranceTitle: 'الرحلات لكل مدخل', pathTitle: 'الرحلات حسب المسار', districtTitle: 'الرحلات حسب الحي' }
};

const MAP_RENDER_LIMIT = 300;
const PLAN_LIST_LIMIT = 50;
const MAP_FIT_MAX_ZOOM = 16;
const MAP_LABEL_MIN_ZOOM = 15;
const ASSIGNMENT_RENDER_LIMIT = 350;
const MAP_DETAIL_LABEL_LIMIT = 18;
const CAMERA_PLAN_BUFFER_KM = 0.020; // 20 meters
const SIDEBAR_WIDTH_STORAGE_KEY = 'dashboard-sidebar-width';
const RIGHT_PANEL_WIDTH_STORAGE_KEY = 'dashboard-right-panel-width';
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'dashboard-sidebar-collapsed';
const CHARTS_PANEL_COLLAPSED_STORAGE_KEY = 'dashboard-charts-panel-collapsed';
const CHART_POPOUT_WINDOW_FEATURES = 'width=1200,height=760';
const AUTH_TOKEN_STORAGE_KEY = 'maan-dashboard-auth-token';
const AUTH_ROLE_STORAGE_KEY = 'maan-dashboard-auth-role';
const THEME_STORAGE_KEY = 'dashboard-theme';
const PLAN_TYPE_RING_ORDER = ['tarwia', 'direct_taseed', 'taseed_tarwia', 'efada', 'nafra'];

// Which end of an "internal" path the entrance sits at. تروية and افاضة depart
// through their entrance, so their path starts there. تصعيد تروية travels Mina ->
// Arafat and arrives at the Arafat entrance, so its path must end there instead.
// Zoom limits measured against the live tile services over Makkah: the Esri
// Canvas basemaps carry real tiles only to z16 and answer deeper requests with a
// "Map data not yet available" placeholder. Capping maxNativeZoom makes Leaflet
// stretch the z16 tile instead, so zooming in blurs the basemap rather than
// blanking it; MAP_MAX_ZOOM is how far the user may go.
const ESRI_CANVAS_MAX_ZOOM = 16;
const MAP_MAX_ZOOM = 20;

const PLAN_TYPES_ARRIVING_AT_ENTRANCE = new Set(['taseed_tarwia']);
// Line segments that make up the actual journey, in travel order. Anything else
// drawn as a line (the tarwia exit overlay) is decoration, oriented on its own.
const JOURNEY_LINE_TYPES = new Set(['external', 'internal']);
const TRANSPORT_TYPE_MENU_OPTIONS = ['ترددي', 'تقليدي رد', 'تقليدي ردين', 'قطار'];
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

function getDistrictDensityColor(intensity) {
    // YlOrRd choropleth: yellow → orange → red based on pilgrim density (0..1)
    const stops = [
        [0.00, [255, 255, 204]],
        [0.25, [254, 217, 118]],
        [0.50, [253, 141,  60]],
        [0.75, [227,  26,  28]],
        [1.00, [128,   0,  38]]
    ];
    let lo = stops[0], hi = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
        if (intensity >= stops[i][0] && intensity <= stops[i + 1][0]) {
            lo = stops[i]; hi = stops[i + 1]; break;
        }
    }
    const t = lo[0] === hi[0] ? 0 : (intensity - lo[0]) / (hi[0] - lo[0]);
    const r = Math.round(lo[1][0] + t * (hi[1][0] - lo[1][0]));
    const g = Math.round(lo[1][1] + t * (hi[1][1] - lo[1][1]));
    const b = Math.round(lo[1][2] + t * (hi[1][2] - lo[1][2]));
    return `rgb(${r},${g},${b})`;
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
    const intensity = maxPilgrims > 0 ? Math.min(1, districtStats.pilgrims / maxPilgrims) : 0;
    const fillColor = getDistrictDensityColor(intensity);
    const strokeColor = isSelected ? '#1e40af' : '#374151';

    return {
        color: strokeColor,
        weight: isSelected ? 3 : 1,
        opacity: 0.9,
        fillColor,
        fillOpacity: isSelected ? 0.8 : Math.max(0.35, 0.35 + intensity * 0.45),
        dashArray: isSelected ? null : "4 3",
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
        if (isDomesticHajjCampRow(row)) return;

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
        if (isDomesticHajjCampRow(row)) return;

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
function isKpiDenominatorPlanType(row) {
    if (selectedPlanTypes.size > 0) {
        return selectedPlanTypes.has(row['plan_type_name']);
    }
    return isTarwiyaKpiTotalPlanType(row);
}

function getCampAssignmentStats() {
    const { company, owner } = getSelectedCompanyAndOwner();
    const hasCompanySelection = company.size > 0 || owner.size > 0;

    // Filtered rows for assignment stats (apply company/owner filters)
    const filteredRows = planTypeBaseData.filter(row => (
        isKpiDenominatorPlanType(row)
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
        : planTypeBaseData.filter(row => isKpiDenominatorPlanType(row));  // Use selected plan types, or all Tarwiya/Taseed if no selection

    const stats = calculateCampAssignmentStats(filteredRows);

    // Get denominator from assign_camps.js instead of from CSV
    const assignCampsServiceCenterCount = getServiceCenterCountFromAssignCamps();

    // The KPI denominator is the assignment target for the plan types in play,
    // not their planned pilgrims — otherwise selecting a phase reads X/X. With no
    // phase selected the rows are Tarwiya + direct Taseed, whose targets sum to
    // the total pilgrims (every pilgrim does exactly one of the two).
    const targetPilgrims = Object.values(buildCompletionStats(totalRows).completionByPlanType)
        .reduce((sum, row) => sum + (row.target || 0), 0);

    return {
        ...stats,
        serviceCenterCount: assignCampsServiceCenterCount,  // Changed: now from assign_camps.js
        totalPilgrims: targetPilgrims || calculateKpiTotalPilgrims(totalRows)
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

    if (loginScreen) loginScreen.hidden = true;
    if (dashboardApp) dashboardApp.hidden = false;
    renderUserIdentity(role);
}

function renderUserIdentity(role = '') {
    const name = localStorage.getItem('maan_name') || '';
    const company = localStorage.getItem('maan_company') || '';
    const center = localStorage.getItem('maan_center') || '';
    const roleLabel = role || localStorage.getItem('maan_role') || 'المشرف';

    // The centre is the more specific of the two, so it wins the visible line;
    // the tooltip carries the full company / centre pair.
    const scopeParts = [roleLabel, center || company].filter(Boolean);
    const fullParts = [roleLabel, company, center].filter(Boolean);

    const nameEl = document.getElementById('userNameLabel');
    if (nameEl) {
        nameEl.textContent = name;
        nameEl.hidden = !name;
    }

    const scopeEl = document.getElementById('userRoleLabel');
    if (scopeEl) scopeEl.textContent = scopeParts.join(' · ');

    const email = localStorage.getItem('maan_email') || '';
    const profile = document.querySelector('.user-profile');
    if (profile) profile.title = [name, email, ...fullParts].filter(Boolean).join(' · ');

    const avatar = document.getElementById('userAvatar');
    if (avatar) avatar.textContent = (name || roleLabel).trim().charAt(0) || 'م';
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

const DB_DATASETS = [
    { name: 'plans', global: 'CSV_DATA', format: 'text' },
    { name: 'assign-camps', global: 'ASSIGN_CAMPS_DATA', format: 'text' },
    { name: 'assign-residences', global: 'ASSIGN_RESIDENCES_DATA', format: 'text' },
    { name: 'camps-gates', global: 'CAMPS_GATES_DATA', format: 'json' },
];

function returnToLogin() {
    localStorage.removeItem('maan_token');
    localStorage.removeItem('maan_role');
    removePersistentValue(AUTH_TOKEN_STORAGE_KEY);
    removePersistentValue(AUTH_ROLE_STORAGE_KEY);
    window.location.reload();
}

// auth.js is the live bootstrap and stores the token as 'maan_token'; the key
// below belongs to app.js's own login form, which is the fallback path.
function authHeaders(extra = {}) {
    const token = localStorage.getItem('maan_token') || getPersistentValue(AUTH_TOKEN_STORAGE_KEY);
    return token ? { Authorization: `Bearer ${token}`, ...extra } : { ...extra };
}

// What this user may edit, as told by the server. Defaults to read-only so a
// failed lookup hides the controls rather than showing ones that will 403.
let dbPermissions = { isAdmin: false, editable: {} };

function editablePlanFields() {
    return dbPermissions.editable && dbPermissions.editable.plans;
}

// Editing a plan needs both the permission and edit mode: view mode is a
// read-only dashboard, so the card actions and the import button are hidden
// there even for a user who may edit.
function canEditPlansNow() {
    return appMode === 'edit' && Boolean(editablePlanFields());
}

async function loadPermissions() {
    try {
        const response = await fetch('/maan-dashboard/api/db-permissions', { headers: authHeaders() });
        if (response.ok) dbPermissions = await response.json();
    } catch (error) {
        console.warn('Could not load edit permissions; staying read-only:', error.message);
    }
}

async function loadDatasetsFromDatabase() {
    const headers = authHeaders();

    const results = await Promise.all(DB_DATASETS.map(async (dataset) => {
        try {
            const response = await fetch(`/maan-dashboard/api/db/${dataset.name}`, { headers });
            // The server scopes rows to the signed-in user rather than denying
            // access, so a 401/403 here always means the session is bad.
            if (response.status === 401 || response.status === 403) {
                return { ...dataset, unauthorized: true };
            }
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            window[dataset.global] = dataset.format === 'json'
                ? await response.json()
                : await response.text();
            return { ...dataset, rows: response.headers.get('X-Row-Count') };
        } catch (error) {
            console.error(`Failed to load "${dataset.name}" from database:`, error.message);
            return { ...dataset, failed: true };
        }
    }));

    if (results.some((r) => r.unauthorized)) {
        console.warn('Session expired or invalid; returning to login.');
        returnToLogin();
        return false;
    }

    if (results.find((r) => r.name === 'plans').failed) {
        alert('تعذر الاتصال بقاعدة البيانات. يرجى المحاولة لاحقاً.');
        return false;
    }

    const loaded = results.filter((r) => !r.failed);
    console.log('Loaded from database:', loaded.map((r) => `${r.name} (${r.rows} rows)`).join(', '));
    window.PLANS_CSV_SOURCE = 'database';

    return true;
}

let dashboardInitialized = false;

async function initializeDashboardApp() {
    if (dashboardInitialized) return;
    dashboardInitialized = true;
    // auth.js boots the dashboard without going through showDashboard(), so the
    // header identity has to be filled in here too.
    renderUserIdentity();
    initResizablePanels();
    initPanelVisibilityControls();
    initEntityTableColumnAutosize();
    initChartViewer();
    initTheme();
    initMap();

    const [plansLoaded] = await Promise.all([loadDatasetsFromDatabase(), loadPermissions()]);
    if (!plansLoaded) {
        // Either the session expired (a reload to the login screen is already in
        // flight) or the database is unreachable. Either way there is nothing to render.
        dashboardInitialized = false;
        return;
    }

    setupEventListeners();
    loadData();
    initPlanImport();
    initEditMode();
}

// ---------------------------------------------------------------- edit mode
// View mode is the read-only analytics dashboard. Edit mode swaps the filter
// bars and chart panels for a data workspace: the entity nav on the side,
// records beside the map, and a form for the selected record. Reference data
// is admin-only, so a non-admin sees the toggle but only regains the plan
// editing they already had — the nav stays empty and the dashboard stays put.

const MODE_STORAGE_KEY = 'maan_mode';
let appMode = 'view';
let mayImportPlans = false;
let entityLayerGroup = null;

const entityState = {
    catalog: [],
    resource: null,
    label: '',
    columns: [],
    columnLabels: {},
    rows: [],
    // 'map' draws the records as geometry; 'grid' shows them as a table with
    // per-column sorting and filtering. Both read the same loaded rows.
    view: 'map',
    sort: null,          // { key, dir: 1 | -1 }
    colFilters: {},      // column key -> substring / exact value
    gridPage: 0,
    total: 0,
    matched: 0,
    filter: null,
    loadAll: false,
    // Entering edit mode opens on every entity at once; picking one from the
    // nav narrows to it. Switching modes again brings the overview back.
    overview: false,
    overviewSets: null,
    limit: 0,
    selectedId: null,
    detail: null,
    search: '',
    creating: false,
    colorBy: null,
    icons: null,
    // discriminant value -> palette colour, built per entity from the rows
    colors: new Map(),
    groupCounts: new Map(),
    otherGroups: 0,
};

// Map shapes are the "any two can touch" case, so every pair has to stay
// distinguishable — not just neighbours in a legend. Validated against both
// Esri canvases (dark #2e2e2e, light #d4d4d4): these three hues pass the
// lightness band, chroma floor, colour-vision separation and the normal-vision
// floor on all pairs in both themes. A fourth hue fails hard (worst pair ΔE 1.6
// for deuteranopia — indistinguishable), which is why the palette stops at
// three and everything else folds into a neutral "أخرى".
const ENTITY_PALETTE = {
    dark: { series: ['#3987e5', '#d95926', '#199e70'], other: '#a8a8a2' },
    light: { series: ['#2a78d6', '#eb6834', '#1baf7a'], other: '#55554f' },
};
const ENTITY_COLOR_SLOTS = 3;

function entityPalette() {
    return document.body.classList.contains('light-mode') ? ENTITY_PALETTE.light : ENTITY_PALETTE.dark;
}

function entityColorKey(row) {
    const key = row && row.color_key;
    return (key === null || key === undefined || key === '') ? null : String(key);
}

// The three largest groups get the hues; the rest share the neutral. Colour is
// never the only cue — the legend, the tooltip and the list all name the group.
function buildEntityColors(rows) {
    const counts = new Map();
    rows.forEach((row) => {
        const key = entityColorKey(row);
        if (key !== null) counts.set(key, (counts.get(key) || 0) + 1);
    });
    const ranked = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'ar'));
    const palette = entityPalette();
    const colors = new Map();
    ranked.slice(0, ENTITY_COLOR_SLOTS).forEach(([value], i) => colors.set(value, palette.series[i]));
    entityState.groupCounts = counts;
    entityState.otherGroups = Math.max(0, ranked.length - ENTITY_COLOR_SLOTS);
    return colors;
}

function entityColorFor(row) {
    const key = entityColorKey(row);
    if (key === null) return entityPalette().other;
    return entityState.colors.get(key) || entityPalette().other;
}

// While the workspace is up it owns the map, so every dashboard overlay stays
// off: plan routes, district shading, cameras, camp gates and the static MAKAF
// paths — the last of which carry the flow animation.
function isEntityWorkspaceActive() {
    return appMode === 'edit' && entityState.catalog.length > 0;
}

// District boundaries, always drawn as a backdrop while editing. View mode
// shades them as a pilgrim choropleth, but there is no plan metric to shade by
// here, and a filled layer would fight the entity shapes for attention. The
// pane sits at z-index 350, below the overlay pane the shapes use, so clicks
// still reach a record and only land on a district where no record covers it.
// Districts are a backdrop, so colour here separates neighbours rather than
// encoding identity — 106 districts is far past what any palette can keep
// distinguishable, and the reader never needs to name a district by its colour
// (the tooltip does that). Adjacent districts are given different tints by
// greedy graph colouring, the four-colour-map approach, so boundaries read
// even where two districts meet. Muted and faint on purpose: these must not
// compete with the entity shapes drawn on top.
const DISTRICT_TINTS = ['#4b7f93', '#7d6b9e', '#9a7b4f', '#8f5f6b', '#5f8a6a', '#6b7280'];
let districtTintCache = null;

function districtFeatureBBox(feature) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const walk = (coords) => {
        if (typeof coords[0] === 'number') {
            if (coords[0] < minX) minX = coords[0];
            if (coords[0] > maxX) maxX = coords[0];
            if (coords[1] < minY) minY = coords[1];
            if (coords[1] > maxY) maxY = coords[1];
            return;
        }
        coords.forEach(walk);
    };
    if (feature.geometry && feature.geometry.coordinates) walk(feature.geometry.coordinates);
    return { minX, minY, maxX, maxY };
}

// Bounding boxes, not exact geometry: an over-estimate of adjacency is safe
// here (it only ever forces more separation, never less) and it keeps this to a
// cheap O(n²) pass instead of thousands of polygon intersections.
function buildDistrictTints() {
    if (districtTintCache) return districtTintCache;
    const features = (typeof DISTRICTS_DATA !== 'undefined' && DISTRICTS_DATA.features) || [];
    const boxes = features.map(districtFeatureBBox);
    const pad = 0.0005; // ~50m, so districts that merely touch count as neighbours

    const neighbours = features.map(() => []);
    for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i];
            const b = boxes[j];
            const apart = a.maxX + pad < b.minX || b.maxX + pad < a.minX
                || a.maxY + pad < b.minY || b.maxY + pad < a.minY;
            if (!apart) { neighbours[i].push(j); neighbours[j].push(i); }
        }
    }

    // Welsh–Powell: colour the most-constrained districts first, so the palette
    // stays small.
    const order = features.map((_f, i) => i).sort((x, y) => neighbours[y].length - neighbours[x].length);
    const tintOf = new Array(features.length).fill(-1);
    order.forEach((i) => {
        const taken = new Set(neighbours[i].map((n) => tintOf[n]).filter((c) => c >= 0));
        let slot = 0;
        while (taken.has(slot) && slot < DISTRICT_TINTS.length - 1) slot++;
        tintOf[i] = slot;
    });

    districtTintCache = tintOf;
    return tintOf;
}

function districtReferenceStyle(tintIndex) {
    const light = document.body.classList.contains('light-mode');
    const tint = DISTRICT_TINTS[tintIndex % DISTRICT_TINTS.length];
    return {
        color: tint,
        weight: 1,
        opacity: light ? 0.6 : 0.5,
        fill: true,
        fillColor: tint,
        fillOpacity: light ? 0.1 : 0.14,
    };
}

function renderDistrictReference() {
    if (!districtsLayerGroup) return;
    districtsLayerGroup.clearLayers();
    if (!isEntityWorkspaceActive()) return;
    if (typeof DISTRICTS_DATA === 'undefined' || !DISTRICTS_DATA.features) return;

    const tints = buildDistrictTints();
    DISTRICTS_DATA.features.forEach((feature, index) => {
        const name = getDistrictNameFromFeature(feature);
        const style = districtReferenceStyle(tints[index] < 0 ? 0 : tints[index]);
        const layer = L.geoJSON(feature, { pane: 'districtPane', style: () => style });
        if (name) layer.bindTooltip(name, { sticky: true, className: 'district-tooltip' });
        layer.addTo(districtsLayerGroup);
    });
}

function clearDashboardMapLayers() {
    [routeLayerGroup, districtsLayerGroup, camerasLayerGroup, campsGatesLayerGroup, makafPathsLayerGroup]
        .forEach((group) => { if (group) group.clearLayers(); });
}

function syncImportButton() {
    const btn = document.getElementById('planImportBtn');
    if (btn) btn.hidden = !(mayImportPlans && appMode === 'edit');
}

function entityFields(resource) {
    return (dbPermissions.editable && dbPermissions.editable[resource])
        || (dbPermissions.viewable && dbPermissions.viewable[resource])
        || [];
}

// Write access for the entity in hand. A company or centre user may browse the
// reference tables but not change shared data, so their form is read-only.
function entityWritable(resource = entityState.resource) {
    const entry = entityState.catalog.find((e) => e.name === resource);
    if (entry && typeof entry.editable === 'boolean') return entry.editable;
    return Boolean(dbPermissions.editable && dbPermissions.editable[resource]);
}

async function entityRequest(path, options = {}) {
    const response = await fetch(`/maan-dashboard/api/${path}`, {
        ...options,
        headers: authHeaders(options.body ? { 'Content-Type': 'application/json' } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error([data.error, ...(data.rejected || [])].filter(Boolean).join(' — ') || `HTTP ${response.status}`);
    }
    return data;
}

async function initEditMode() {
    const toggle = document.getElementById('modeToggle');
    try {
        const data = await entityRequest('entities');
        entityState.catalog = data.entities || [];
    } catch (error) {
        console.warn('Could not load the entity catalogue:', error.message);
        entityState.catalog = [];
    }

    // A user who can neither manage reference data nor edit plans has nothing
    // to switch to, so the toggle stays hidden and the dashboard is view-only.
    const hasEditPowers = entityState.catalog.length > 0 || Boolean(editablePlanFields());
    if (toggle) toggle.hidden = !hasEditPowers;
    if (!hasEditPowers) { setAppMode('view', { persist: false }); return; }

    toggle?.addEventListener('click', () => setAppMode(appMode === 'edit' ? 'view' : 'edit'));

    renderEntityNav();
    document.getElementById('entitySearch')?.addEventListener('input', debounce((e) => {
        entityState.search = e.target.value;
        loadEntityRows();
    }, 250));
    document.getElementById('entityCreateBtn')?.addEventListener('click', () => openEntityForm(null));
    document.querySelectorAll('#entityViewSwitch .entity-view-btn').forEach((btn) => {
        btn.addEventListener('click', () => setEntityView(btn.dataset.view));
    });

    let storedView = null;
    try { storedView = localStorage.getItem(ENTITY_VIEW_KEY); } catch (_e) {}
    setEntityView(storedView === 'grid' ? 'grid' : 'map', { persist: false, reload: false });

    let stored = null;
    try { stored = localStorage.getItem(MODE_STORAGE_KEY); } catch (_e) {}
    setAppMode(stored === 'edit' ? 'edit' : 'view', { persist: false });
}

function setAppMode(mode, { persist = true } = {}) {
    appMode = mode === 'edit' ? 'edit' : 'view';
    document.body.setAttribute('data-mode', appMode);
    if (persist) { try { localStorage.setItem(MODE_STORAGE_KEY, appMode); } catch (_e) {} }

    // The control names the mode you are in; the tooltip names the one a click
    // would take you to, so neither reading of a toggle can mislead.
    const editing = appMode === 'edit';
    const toggle = document.getElementById('modeToggle');
    if (toggle) {
        toggle.classList.toggle('is-edit', editing);
        toggle.setAttribute('aria-checked', editing ? 'true' : 'false');
        toggle.title = editing
            ? 'وضع التحرير: إدارة البيانات — اضغط للعودة إلى وضع العرض'
            : 'وضع العرض: لوحة تحليلية للقراءة فقط — اضغط للتبديل إلى وضع التحرير';
        toggle.setAttribute('aria-label', 'وضع التحرير');
    }
    const modeLabel = document.getElementById('modeToggleLabel');
    if (modeLabel) modeLabel.textContent = editing ? 'تحرير' : 'عرض';
    const modeIcon = document.getElementById('modeToggleIcon');
    if (modeIcon) modeIcon.className = `fa-solid ${editing ? 'fa-pen-to-square' : 'fa-chart-line'}`;

    const managing = appMode === 'edit' && entityState.catalog.length > 0;
    const nav = document.getElementById('entityNav');
    const workspace = document.getElementById('entityWorkspace');
    const planKpis = document.querySelector('.kpi-cards');
    if (nav) nav.hidden = !managing;
    if (workspace) workspace.hidden = !managing;
    if (planKpis) planKpis.hidden = managing;

    syncImportButton();
    cachedMapRenderKey = null;
    if (managing) {
        clearDashboardMapLayers();
        // Always the overview on entry, not the last entity: it is also the only
        // way back to it, since the nav lists entities only.
        loadOverview();
    } else {
        clearEntityLayer();
        // Leaving the workspace: the overlays were cleared, so put them back.
        renderCameras();
        renderCampsGates();
        renderMakafPaths();
    }
    // The plan cards carry edit/delete buttons only in edit mode.
    updatePlanList();
    scheduleDashboardUpdate();
}

function renderEntityNav() {
    const nav = document.getElementById('entityNav');
    if (!nav) return;
    nav.innerHTML =
        '<h3><i class="fa-solid fa-database" aria-hidden="true"></i> البيانات المرجعية</h3>' +
        entityState.catalog.map((e) => `
            <button type="button" class="entity-nav-item${e.name === entityState.resource ? ' is-active' : ''}" data-entity="${escapeHtml(e.name)}">
                <i class="fa-solid ${escapeHtml(e.icon)}" aria-hidden="true"></i>
                <span>${escapeHtml(e.label)}</span>
            </button>`).join('');
    nav.querySelectorAll('.entity-nav-item').forEach((btn) => {
        btn.addEventListener('click', () => selectEntity(btn.dataset.entity));
    });
}

function selectEntity(resource) {
    entityState.overview = false;
    document.body.removeAttribute('data-entity-overview');
    entityState.resource = resource;
    entityState.label = (entityState.catalog.find((e) => e.name === resource) || {}).label || resource;
    entityState.search = '';
    entityState.filter = null;
    // The grid keeps its view but not its columns' sort or filters: those name
    // columns that the next entity does not have.
    entityState.loadAll = entityState.view === 'grid';
    entityState.sort = null;
    entityState.colFilters = {};
    entityState.gridPage = 0;
    entityState.selectedId = null;
    entityState.detail = null;
    const search = document.getElementById('entitySearch');
    if (search) search.value = '';
    const title = document.getElementById('entityTitle');
    if (title) title.textContent = entityState.label;
    const createBtn = document.getElementById('entityCreateBtn');
    if (createBtn) createBtn.hidden = !entityWritable(resource);
    renderEntityNav();
    renderEntityDetail();
    loadEntityRows();
}

// ── Overview (all entities at once) ────────────────────────────────────────
// Every reference entity on one map. Nine categories cannot be told apart by
// colour — only three hues clear the colour-vision and contrast checks against
// the Esri canvases — so the three largest entities take those hues and the six
// small ones share the neutral and are told apart by their icons instead. They
// are few enough (243 records all told) that every one of them gets its badge,
// which is exactly what makes that split work.
const ENTITY_OVERVIEW_LIMIT = 6000;
let overviewCache = null;
// The overview draws ~6,400 shapes, 4,974 of them camp paths. As SVG that is
// 6,400 DOM nodes and panning stutters badly; on a canvas it is one node and
// Leaflet still delivers clicks and tooltips. Built lazily and reused, because
// a renderer per draw would leak a canvas per pan.
let overviewRenderer = null;

function getOverviewRenderer() {
    if (!overviewRenderer) overviewRenderer = L.canvas({ padding: 0.3 });
    return overviewRenderer;
}

async function loadOverview() {
    entityState.overview = true;
    entityState.resource = null;
    entityState.rows = [];
    entityState.selectedId = null;
    entityState.detail = null;
    document.body.setAttribute('data-entity-overview', 'on');

    const title = document.getElementById('entityTitle');
    if (title) title.textContent = 'نظرة عامة';
    const createBtn = document.getElementById('entityCreateBtn');
    if (createBtn) createBtn.hidden = true;
    renderEntityNav();
    renderEntityDetail();

    const busy = '<div class="entity-empty">جارٍ تحميل كل العناصر…</div>';
    const list = document.getElementById('entityList');
    const grid = document.getElementById('entityGrid');
    if (list) list.innerHTML = busy;
    if (grid) grid.innerHTML = busy;

    if (!overviewCache) {
        // One request per entity, in parallel. A failure is per entity: the rest
        // of the map still draws, and the summary says which one is missing.
        const results = await Promise.all(entityState.catalog.map((entry) =>
            entityRequest(`entities/${encodeURIComponent(entry.name)}?limit=${ENTITY_OVERVIEW_LIMIT}`)
                .then((data) => ({
                    entry,
                    rows: data.rows || [],
                    total: data.total || 0,
                    icons: data.icons || null,
                }))
                .catch((error) => ({ entry, rows: [], total: 0, icons: null, error: error.message }))
        ));
        overviewCache = assignOverviewColors(results);
    }
    if (!entityState.overview) return; // the user picked an entity while we loaded
    entityState.overviewSets = overviewCache;

    renderOverviewSummary();
    renderEntityLegend();
    drawEntityLayer();
}

// Rank by table size, give the top three the validated hues, the rest the
// neutral — the same three-slot rule the single-entity view uses for its colour
// groups, applied to entities instead of to one entity's discriminant.
function assignOverviewColors(sets) {
    const palette = entityPalette();
    const ranked = [...sets].sort((a, b) => b.total - a.total);
    ranked.forEach((set, i) => {
        set.color = i < ENTITY_COLOR_SLOTS ? palette.series[i] : palette.other;
        set.toned = i < ENTITY_COLOR_SLOTS;
    });
    // Back to catalogue order for the summary and the legend, so the panel does
    // not reshuffle itself between loads.
    return sets;
}

function renderOverviewSummary() {
    const sets = entityState.overviewSets ? assignOverviewColors(entityState.overviewSets) : [];
    const rows = sets.map((set) => {
        const shown = set.rows.length;
        const note = set.error
            ? `<span class="entity-row-meta is-error">${escapeHtml(set.error)}</span>`
            : `<span class="entity-row-meta">${shown.toLocaleString()}${shown < set.total ? ` من ${set.total.toLocaleString()}` : ''} سجل</span>`;
        return `
            <button type="button" class="entity-row entity-overview-row" data-entity="${escapeHtml(set.entry.name)}">
                <span class="entity-overview-swatch" style="background:${escapeHtml(set.color)}"></span>
                <span class="entity-row-title">
                    <i class="fa-solid ${escapeHtml(set.entry.icon)}" aria-hidden="true"></i>
                    ${escapeHtml(set.entry.label)}
                </span>
                ${note}
            </button>`;
    }).join('');

    const total = sets.reduce((n, s) => n + s.rows.length, 0);
    const hint = '<div class="entity-overview-hint">كل العناصر معروضة على الخريطة — اختر عنصراً لتحريره</div>';

    const list = document.getElementById('entityList');
    if (list) list.innerHTML = hint + rows;
    const grid = document.getElementById('entityGrid');
    if (grid) grid.innerHTML = hint + rows;

    document.querySelectorAll('.entity-overview-row').forEach((btn) => {
        btn.addEventListener('click', () => selectEntity(btn.dataset.entity));
    });

    const foot = `${sets.length} عنصراً · ${total.toLocaleString()} سجل على الخريطة`;
    const listFoot = document.getElementById('entityListFoot');
    if (listFoot) listFoot.textContent = foot;
    const gridFoot = document.getElementById('entityGridFoot');
    if (gridFoot) gridFoot.textContent = foot;
}

// Every entity drawn in one pass. Point records are culled to the viewport once
// there are more than ENTITY_PIN_CULL_AFTER of them across all entities, so the
// ~1,900 residences do not put 1,900 DOM nodes on the map at once.
function drawOverviewLayer() {
    const sets = entityState.overviewSets ? assignOverviewColors(entityState.overviewSets) : [];
    const allBounds = L.latLngBounds();

    const pinCount = sets.reduce((n, set) => n + set.rows.reduce(
        (m, r) => m + (!r.geojson && Number.isFinite(r.lon) && Number.isFinite(r.lat) ? 1 : 0), 0), 0);
    const cullPins = pinCount > ENTITY_PIN_CULL_AFTER;
    const viewport = cullPins ? map.getBounds().pad(0.3) : null;

    sets.forEach((set) => {
        const { color } = set;
        const withIcons = set.entry.mapIcon !== false;
        // The small entities all get badges; the big ones would be a wall of them.
        const badgeAll = withIcons && set.rows.length <= ENTITY_BADGE_LIMIT;
        const iconFor = (row) => {
            const key = row.icon_key;
            if (set.icons && key && set.icons.map && set.icons.map[key]) return set.icons.map[key];
            return set.entry.icon || 'fa-location-dot';
        };

        set.rows.forEach((row) => {
            const label = String(row.name ?? row[Object.keys(row)[1]] ?? '');
            const tip = `${set.entry.label} · ${label}`;
            const attach = (layer) => {
                layer.addTo(entityLayerGroup);
                layer.bindTooltip(tip, { direction: 'top', sticky: true });
                layer.on('click', () => {
                    selectEntity(set.entry.name);
                    openEntityForm(row.id);
                });
            };

            let bounds = null;
            if (row.geojson) {
                let shapeLayer = null;
                try {
                    shapeLayer = L.geoJSON(JSON.parse(row.geojson), {
                        renderer: getOverviewRenderer(),
                        style: () => ({ color, weight: 1.5, fillColor: color, fillOpacity: 0.22 }),
                        pointToLayer: (_f, latlng) => (withIcons
                            ? L.marker(latlng, { icon: entityPinIcon(color, false, row, iconFor(row)) })
                            : L.circleMarker(latlng, { renderer: getOverviewRenderer(), radius: 4.5, color, weight: 1.5, fillColor: color, fillOpacity: 0.7 })),
                    });
                } catch (_e) {
                    shapeLayer = null;
                }
                if (shapeLayer) {
                    attach(shapeLayer);
                    bounds = shapeLayer.getBounds();
                    const type = (() => { try { return String(JSON.parse(row.geojson).type || ''); } catch (_e) { return ''; } })();
                    if (badgeAll && /Polygon|LineString/.test(type) && bounds && bounds.isValid()) {
                        attach(L.marker(bounds.getCenter(), { icon: entityPinIcon(color, false, row, iconFor(row)) }));
                    }
                }
            } else if (Number.isFinite(row.lon) && Number.isFinite(row.lat)) {
                const at = L.latLng(row.lat, row.lon);
                bounds = L.latLngBounds(at, at);
                if (!viewport || viewport.contains(at)) {
                    attach(withIcons
                        ? L.marker(at, { icon: entityPinIcon(color, false, row, iconFor(row)) })
                        : L.circleMarker(at, { renderer: getOverviewRenderer(), radius: 4.5, color, weight: 1.5, fillColor: color, fillOpacity: 0.7 }));
                }
            }
            if (bounds && bounds.isValid()) allBounds.extend(bounds);
        });
    });

    renderDistrictReference();
    return allBounds;
}

async function loadEntityRows() {
    const { resource, search } = entityState;
    if (!resource) return;
    const list = document.getElementById('entityList');
    const grid = document.getElementById('entityGrid');
    const busy = '<div class="entity-empty">جارٍ التحميل…</div>';
    if (list) list.innerHTML = busy;
    if (grid && entityState.view === 'grid') grid.innerHTML = busy;
    try {
        const params = new URLSearchParams({ limit: String(entityState.loadAll ? Math.max(entityState.total, ENTITY_PAGE_SIZE) : ENTITY_PAGE_SIZE) });
        if (search) params.set('q', search);
        if (entityState.filter) params.set('filter', entityState.filter);
        const data = await entityRequest(`entities/${encodeURIComponent(resource)}?${params}`);
        if (data.resource !== entityState.resource) return; // a newer selection won
        entityState.rows = data.rows || [];
        entityState.columns = data.columns || [];
        entityState.columnLabels = data.columnLabels || {};
        entityState.total = data.total || 0;
        entityState.matched = data.matched ?? data.total ?? 0;
        entityState.filter = data.filter ?? null;
        entityState.limit = data.limit || 0;
        entityState.colorBy = data.colorBy || null;
        entityState.icons = data.icons || null;
        entityState.colors = buildEntityColors(entityState.rows);
    } catch (error) {
        entityState.rows = [];
        entityState.total = 0;
        const message = `<div class="entity-empty">${escapeHtml(error.message)}</div>`;
        if (list) list.innerHTML = message;
        if (grid) grid.innerHTML = message;
        return;
    }
    renderEntityList();
    renderEntityGrid();
    renderEntityLegend();
    drawEntityLayer();
}

function renderEntityList() {
    if (entityState.overview) return; // the overview owns both panels
    const list = document.getElementById('entityList');
    const foot = document.getElementById('entityListFoot');
    if (!list) return;
    if (!entityState.rows.length) {
        list.innerHTML = '<div class="entity-empty">لا توجد سجلات</div>';
        if (foot) foot.textContent = '';
        return;
    }
    const [titleCol, ...restCols] = entityState.columns;
    list.innerHTML = entityState.rows.map((row) => {
        const meta = restCols
            .map((c) => (row[c] === null || row[c] === undefined || row[c] === '' ? '' : String(row[c])))
            .filter(Boolean).join(' · ');
        return `
            <button type="button" class="entity-row${row.id === entityState.selectedId ? ' is-active' : ''}" data-id="${escapeHtml(row.id)}">
                <span class="entity-row-title">${escapeHtml(row[titleCol] ?? '—')}</span>
                ${meta ? `<span class="entity-row-meta">${escapeHtml(meta)}</span>` : ''}
            </button>`;
    }).join('');
    list.querySelectorAll('.entity-row').forEach((btn) => {
        btn.addEventListener('click', () => openEntityForm(btn.dataset.id));
    });
    if (foot) {
        const shown = entityState.rows.length;
        const FILTER_NAMES = { used: 'مستخدمة في الخطط', unused: 'غير مستخدمة' };
        const narrowed = entityState.search || entityState.filter;
        const pool = narrowed ? entityState.matched : entityState.total;
        const active = entityState.filter ? ` · ${FILTER_NAMES[entityState.filter]}` : '';
        foot.replaceChildren();
        if (shown < pool) {
            foot.append(`معروض ${shown.toLocaleString()} من ${pool.toLocaleString()}${active} `);
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'entity-load-all';
            more.textContent = `عرض الكل (${pool.toLocaleString()})`;
            more.addEventListener('click', () => { entityState.loadAll = true; loadEntityRows(); });
            foot.append(more);
        } else {
            foot.append(`${shown.toLocaleString()} سجل${active}`);
        }
    }
}

// ── Grid view ──────────────────────────────────────────────────────────────
// The same records, as a table. Sorting and filtering are per column and run
// client-side over the rows already loaded — which is why switching to the grid
// loads the whole (scoped) table first: a table that quietly sorted only the
// first page would be worse than no sorting at all.

const ENTITY_VIEW_KEY = 'maan_entity_view';
const ENTITY_GRID_PAGE = 50;
// Past this many distinct values a dropdown stops being a shortcut, so the
// column gets a free-text box instead.
const ENTITY_GRID_SELECT_MAX = 30;
const ENTITY_COLLATOR = new Intl.Collator('ar', { numeric: true, sensitivity: 'base' });

function setEntityView(view, { persist = true, reload = true } = {}) {
    entityState.view = view === 'grid' ? 'grid' : 'map';
    document.body.setAttribute('data-entity-view', entityState.view);
    if (persist) { try { localStorage.setItem(ENTITY_VIEW_KEY, entityState.view); } catch (_e) {} }

    document.querySelectorAll('#entityViewSwitch .entity-view-btn').forEach((btn) => {
        const on = btn.dataset.view === entityState.view;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (!reload) return;

    if (entityState.view === 'grid') {
        entityState.gridPage = 0;
        if (!entityState.loadAll && entityState.rows.length < entityState.matched) {
            entityState.loadAll = true;
            loadEntityRows();
            return;
        }
        renderEntityGrid();
    } else {
        // The map spent the grid session at display:none, so Leaflet's cached
        // size is stale and tiles would lay out against a zero-width box.
        requestAnimationFrame(() => {
            if (map) map.invalidateSize();
            drawEntityLayer();
            renderEntityLegend();
        });
    }
}

// Which geometry a record carries, worked out once and cached on the row: the
// grid re-renders on every keystroke and re-parsing thousands of shapes each
// time would be felt.
function entityGeoKind(row) {
    if (row.__geoKind === undefined) {
        let kind = '';
        if (row.geojson) {
            try {
                const type = String(JSON.parse(row.geojson).type || '');
                kind = /Polygon/.test(type) ? 'مضلّع' : (/LineString/.test(type) ? 'خط' : 'نقطة');
            } catch (_e) { kind = 'شكل'; }
        } else if (Number.isFinite(row.lon) && Number.isFinite(row.lat)) {
            kind = 'نقطة';
        }
        Object.defineProperty(row, '__geoKind', { value: kind, enumerable: false });
    }
    return row.__geoKind;
}

// The list columns the server chose, plus the two the map encodes (the colour
// discriminant and the icon column) and the geometry kind — so everything the
// map says about a record is also readable as text.
function entityGridColumns() {
    const fields = entityFields(entityState.resource);
    const typeOf = (key) => (fields.find((f) => f.name === key) || {}).type || 'text';
    const cols = entityState.columns.map((key) => ({
        key, label: entityState.columnLabels[key] || key, type: typeOf(key),
    }));
    // The map's colour and icon keys become columns too — unless they are just
    // a list column under a second name, which several entities are.
    const derived = (meta, key) => {
        if (!meta) return;
        if (meta.column && entityState.columns.includes(meta.column)) return;
        cols.push({ key, label: meta.label, type: 'text' });
    };
    derived(entityState.colorBy, 'color_key');
    derived(entityState.icons, 'icon_key');
    if (entityState.rows.some((r) => entityGeoKind(r))) {
        cols.push({ key: '__geo', label: 'الشكل', type: 'text' });
    }
    return cols;
}

function entityGridValue(row, col) {
    if (col.key === '__geo') return entityGeoKind(row);
    const v = row[col.key];
    return (v === null || v === undefined) ? '' : v;
}

// Blanks sort last in both directions: they are absence, not a low value, and
// flipping the arrow should not park them at the top.
function entityGridSortRows(rows, col, dir) {
    return [...rows].sort((a, b) => {
        const av = entityGridValue(a, col);
        const bv = entityGridValue(b, col);
        const aEmpty = av === '';
        const bEmpty = bv === '';
        if (aEmpty || bEmpty) return aEmpty && bEmpty ? 0 : (aEmpty ? 1 : -1);
        if (col.type === 'number') return (Number(av) - Number(bv)) * dir;
        return ENTITY_COLLATOR.compare(String(av), String(bv)) * dir;
    });
}

function entityGridRows(cols) {
    const active = Object.entries(entityState.colFilters)
        .filter(([, f]) => f && f.value !== '' && f.value !== null && f.value !== undefined);

    let rows = entityState.rows;
    if (active.length) {
        rows = rows.filter((row) => active.every(([key, f]) => {
            const col = cols.find((c) => c.key === key) || { key, type: 'text' };
            const val = String(entityGridValue(row, col));
            if (f.exact) return val === String(f.value);
            return val.toLowerCase().includes(String(f.value).toLowerCase());
        }));
    }
    if (entityState.sort) {
        const col = cols.find((c) => c.key === entityState.sort.key);
        if (col) rows = entityGridSortRows(rows, col, entityState.sort.dir);
    }
    return rows;
}

// A dropdown when the column is a small taxonomy, a text box when it is not.
function entityGridDistinct(col) {
    if (col.type === 'number') return null;
    const seen = new Set();
    for (const row of entityState.rows) {
        const v = entityGridValue(row, col);
        if (v === '') continue;
        seen.add(String(v));
        if (seen.size > ENTITY_GRID_SELECT_MAX) return null;
    }
    return [...seen].sort(ENTITY_COLLATOR.compare);
}

function renderEntityGrid() {
    const host = document.getElementById('entityGrid');
    const foot = document.getElementById('entityGridFoot');
    if (!host) return;
    if (entityState.overview) return; // the overview owns both panels
    if (entityState.view !== 'grid' || !entityState.resource) return;
    if (!entityState.rows.length) {
        host.innerHTML = '<div class="entity-empty">لا توجد سجلات</div>';
        if (foot) foot.replaceChildren();
        return;
    }

    const cols = entityGridColumns();
    const rows = entityGridRows(cols);
    const pageCount = Math.max(1, Math.ceil(rows.length / ENTITY_GRID_PAGE));
    if (entityState.gridPage > pageCount - 1) entityState.gridPage = pageCount - 1;
    const start = entityState.gridPage * ENTITY_GRID_PAGE;
    const page = rows.slice(start, start + ENTITY_GRID_PAGE);

    const sortMark = (key) => {
        if (!entityState.sort || entityState.sort.key !== key) return 'fa-sort';
        return entityState.sort.dir === 1 ? 'fa-sort-up' : 'fa-sort-down';
    };
    const headCells = cols.map((c) => {
        const sorted = entityState.sort && entityState.sort.key === c.key;
        return `<th scope="col"${sorted ? ` aria-sort="${entityState.sort.dir === 1 ? 'ascending' : 'descending'}"` : ''}>
            <button type="button" class="entity-grid-sort${sorted ? ' is-sorted' : ''}" data-sort="${escapeHtml(c.key)}" title="فرز حسب ${escapeHtml(c.label)}">
                <span>${escapeHtml(c.label)}</span>
                <i class="fa-solid ${sortMark(c.key)}" aria-hidden="true"></i>
            </button></th>`;
    }).join('');

    const filterCells = cols.map((c) => {
        const current = entityState.colFilters[c.key];
        const value = current ? String(current.value) : '';
        const options = entityGridDistinct(c);
        if (options) {
            return `<th><select class="entity-grid-filter" data-filter-col="${escapeHtml(c.key)}" data-exact="1" aria-label="تصفية ${escapeHtml(c.label)}">
                <option value="">الكل</option>
                ${options.map((o) => `<option value="${escapeHtml(o)}"${o === value ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('')}
            </select></th>`;
        }
        return `<th><input type="search" class="entity-grid-filter" data-filter-col="${escapeHtml(c.key)}"
            value="${escapeHtml(value)}" placeholder="تصفية…" autocomplete="off" aria-label="تصفية ${escapeHtml(c.label)}"></th>`;
    }).join('');

    const body = page.map((row) => {
        const color = entityColorFor(row);
        const cells = cols.map((c, i) => {
            const raw = entityGridValue(row, c);
            const shown = c.type === 'number' && raw !== '' ? Number(raw).toLocaleString() : raw;
            // The first column carries the same icon and colour the map uses, so
            // a record is recognisable in either view.
            const lead = i === 0 && entityMapIcons()
                ? `<i class="fa-solid ${escapeHtml(entityIconClass(row))} entity-grid-icon" style="color:${escapeHtml(color)}" aria-hidden="true"></i>`
                : '';
            return `<td class="${c.type === 'number' ? 'num' : ''}">${lead}${escapeHtml(shown === '' ? '—' : shown)}</td>`;
        }).join('');
        return `<tr class="entity-grid-row${row.id === entityState.selectedId ? ' is-active' : ''}" data-id="${escapeHtml(row.id)}" tabindex="0">${cells}</tr>`;
    }).join('');

    const focused = document.activeElement;
    const focusKey = focused && focused.classList.contains('entity-grid-filter')
        ? focused.dataset.filterCol : null;

    host.innerHTML = `
        <table class="entity-grid-table">
            <thead>
                <tr class="entity-grid-head">${headCells}</tr>
                <tr class="entity-grid-filters">${filterCells}</tr>
            </thead>
            <tbody>${body}</tbody>
        </table>`;

    host.querySelectorAll('.entity-grid-sort').forEach((btn) => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.sort;
            const cur = entityState.sort;
            entityState.sort = (cur && cur.key === key)
                ? (cur.dir === 1 ? { key, dir: -1 } : null)   // asc → desc → unsorted
                : { key, dir: 1 };
            entityState.gridPage = 0;
            renderEntityGrid();
        });
    });

    const applyFilter = (el) => {
        const key = el.dataset.filterCol;
        const value = el.value;
        if (value === '') delete entityState.colFilters[key];
        else entityState.colFilters[key] = { value, exact: el.dataset.exact === '1' };
        entityState.gridPage = 0;
        renderEntityGrid();
    };
    host.querySelectorAll('input.entity-grid-filter').forEach((el) => {
        el.addEventListener('input', debounce(() => applyFilter(el), 220));
    });
    host.querySelectorAll('select.entity-grid-filter').forEach((el) => {
        el.addEventListener('change', () => applyFilter(el));
    });

    const open = (tr) => openEntityForm(tr.dataset.id);
    host.querySelectorAll('.entity-grid-row').forEach((tr) => {
        tr.addEventListener('click', () => open(tr));
        tr.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(tr); }
        });
    });

    // The table is rebuilt on each keystroke, so put the caret back where it was.
    if (focusKey) {
        const again = host.querySelector(`.entity-grid-filter[data-filter-col="${focusKey}"]`);
        if (again) {
            again.focus();
            if (again.setSelectionRange) {
                const end = again.value.length;
                try { again.setSelectionRange(end, end); } catch (_e) {}
            }
        }
    }

    if (foot) {
        foot.replaceChildren();
        const filtered = Object.keys(entityState.colFilters).length > 0;
        const from = rows.length ? start + 1 : 0;
        const to = Math.min(start + ENTITY_GRID_PAGE, rows.length);
        const info = document.createElement('span');
        info.className = 'entity-grid-count';
        info.textContent = filtered
            ? `${from.toLocaleString()}–${to.toLocaleString()} من ${rows.length.toLocaleString()} مصفّاة (${entityState.rows.length.toLocaleString()} محمّلة)`
            : `${from.toLocaleString()}–${to.toLocaleString()} من ${rows.length.toLocaleString()}`;
        foot.append(info);

        if (filtered || entityState.sort) {
            const reset = document.createElement('button');
            reset.type = 'button';
            reset.className = 'entity-grid-reset';
            reset.textContent = 'إلغاء الفرز والتصفية';
            reset.addEventListener('click', () => {
                entityState.colFilters = {};
                entityState.sort = null;
                entityState.gridPage = 0;
                renderEntityGrid();
            });
            foot.append(reset);
        }

        if (pageCount > 1) {
            const pager = document.createElement('div');
            pager.className = 'entity-grid-pager';
            const step = (delta, icon, label) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'entity-grid-page-btn';
                b.title = label;
                b.setAttribute('aria-label', label);
                b.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i>`;
                b.disabled = delta < 0 ? entityState.gridPage === 0 : entityState.gridPage >= pageCount - 1;
                b.addEventListener('click', () => {
                    entityState.gridPage = Math.min(pageCount - 1, Math.max(0, entityState.gridPage + delta));
                    renderEntityGrid();
                });
                return b;
            };
            // RTL: "previous" sits on the right, so the chevron points that way.
            pager.append(step(-1, 'fa-chevron-right', 'الصفحة السابقة'));
            const at = document.createElement('span');
            at.className = 'entity-grid-page-at';
            at.textContent = `${(entityState.gridPage + 1).toLocaleString()} / ${pageCount.toLocaleString()}`;
            pager.append(at);
            pager.append(step(1, 'fa-chevron-left', 'الصفحة التالية'));
            foot.append(pager);
        }
    }
}

// The legend lives on the map, beside the shapes it explains: the entity and
// how its records are drawn, then each colour group with its count. Groups past
// the three coloured slots are named here too, so folding them into one neutral
// hides no information.
function renderEntityLegend() {
    const host = document.getElementById('mapLegend');
    if (!host) return;
    if (!isEntityWorkspaceActive()) {
        host.hidden = true;
        host.innerHTML = '';
        return;
    }
    // In the overview the legend is the key to the whole map: which colour or
    // glyph is which entity, and how many of each is drawn.
    if (entityState.overview) {
        const sets = entityState.overviewSets ? assignOverviewColors(entityState.overviewSets) : [];
        if (!sets.length) { host.hidden = true; host.innerHTML = ''; return; }
        const drawn = sets.reduce((n, s) => n + s.rows.length, 0);
        host.hidden = false;
        host.innerHTML = `
            <div class="map-legend-head">
                <i class="fa-solid fa-layer-group" aria-hidden="true"></i>
                <span class="map-legend-title">كل العناصر</span>
                <span class="map-legend-sub">${drawn.toLocaleString()} سجل</span>
            </div>
            <div class="map-legend-items">
                ${sets.map((set) => `
                    <span class="entity-legend-item" title="${escapeHtml(set.entry.label)} — ${set.rows.length.toLocaleString()} سجل">
                        <span class="entity-legend-dot" style="background:${escapeHtml(set.color)}"></span>
                        <i class="fa-solid ${escapeHtml(set.entry.icon)} entity-legend-icon" aria-hidden="true"></i>
                        <span class="entity-legend-text">${escapeHtml(set.entry.label)}</span>
                        <span class="entity-legend-count">${set.rows.length.toLocaleString()}</span>
                    </span>`).join('')}
            </div>
            <div class="map-legend-hint">اللون يميّز أكبر ${ENTITY_COLOR_SLOTS} عناصر؛ البقية بلون محايد وتتميّز بأيقوناتها</div>`;
        return;
    }
    if (!entityState.resource || !entityState.rows.length) {
        host.hidden = true;
        host.innerHTML = '';
        return;
    }

    const palette = entityPalette();
    const shaped = entityState.rows.filter((r) => r.geojson).length;
    const pinned = entityState.rows.length - shaped;
    const drawnAs = [
        shaped ? `${shaped.toLocaleString()} شكل` : '',
        pinned ? `${pinned.toLocaleString()} علامة` : '',
    ].filter(Boolean).join(' · ');

    const rows = [];
    if (entityState.colorBy) {
        const missing = entityState.rows.filter((r) => entityColorKey(r) === null).length;
        [...entityState.colors.entries()]
            .map(([value, color]) => ({ value, color, n: entityState.groupCounts.get(value) || 0 }))
            .sort((a, b) => b.n - a.n)
            .forEach((e) => rows.push(e));

        if (entityState.otherGroups > 0) {
            const rest = [...entityState.groupCounts.entries()]
                .filter(([value]) => !entityState.colors.has(value))
                .sort((a, b) => b[1] - a[1]);
            rows.push({
                value: `بقية المجموعات · ${entityState.otherGroups}`,
                color: palette.other,
                n: rest.reduce((sum, [, n]) => sum + n, 0),
                hint: rest.map(([v, n]) => `${v} (${n})`).join('، '),
            });
        }
        if (missing) rows.push({ value: 'بدون قيمة', color: palette.other, n: missing });
    }

    // Icon key: only the glyphs actually present on this page.
    const iconRows = [];
    if (entityState.icons && entityState.icons.map) {
        const counts = new Map();
        entityState.rows.forEach((r) => {
            const key = r.icon_key;
            if (key && entityState.icons.map[key]) counts.set(key, (counts.get(key) || 0) + 1);
        });
        [...counts.entries()]
            .sort((x, y) => y[1] - x[1])
            .forEach(([value, n]) => iconRows.push({ value, n, icon: entityState.icons.map[value] }));
    }

    host.hidden = false;
    host.innerHTML = `
        <div class="map-legend-head">
            <i class="fa-solid ${escapeHtml(entityIconClass())}" aria-hidden="true"></i>
            <span class="map-legend-title">${escapeHtml(entityState.label)}</span>
            ${drawnAs ? `<span class="map-legend-sub">${escapeHtml(drawnAs)}</span>` : ''}
        </div>
        ${entityState.colorBy ? `<div class="map-legend-by">${escapeHtml(entityState.colorBy.label)}</div>` : ''}
        <div class="map-legend-items">
            ${rows.map((e) => `
                <span class="entity-legend-item" title="${escapeHtml(e.hint || `${e.value} — ${e.n} سجل`)}">
                    <span class="entity-legend-dot" style="background:${escapeHtml(e.color)}"></span>
                    <span class="entity-legend-text">${escapeHtml(e.value)}</span>
                    <span class="entity-legend-count">${e.n.toLocaleString()}</span>
                </span>`).join('')}
        </div>
        ${iconRows.length ? `
            <div class="map-legend-by">${escapeHtml(entityState.icons.label)}</div>
            <div class="map-legend-items">
                ${iconRows.map((e) => `
                    <span class="entity-legend-item" title="${escapeHtml(e.value)} — ${e.n} سجل">
                        <i class="fa-solid ${escapeHtml(e.icon)} entity-legend-icon" aria-hidden="true"></i>
                        <span class="entity-legend-text">${escapeHtml(e.value)}</span>
                        <span class="entity-legend-count">${e.n.toLocaleString()}</span>
                    </span>`).join('')}
            </div>` : ''}
        ${entityState.otherGroups ? `<div class="map-legend-hint">اللون يميّز أكبر ${ENTITY_COLOR_SLOTS} مجموعات فقط؛ البقية بلون محايد — مرّر عليها لعرضها</div>` : ''}
        ${entityState.filter ? '<div class="map-legend-note">تصفية مطبّقة</div>' : ''}`;
}

async function openEntityForm(id) {
    entityState.creating = id === null;
    entityState.selectedId = id;
    if (id) {
        try {
            const data = await entityRequest(`entities/${encodeURIComponent(entityState.resource)}/${id}`);
            entityState.detail = data.row;
        } catch (error) {
            entityState.detail = null;
            showNotification(error.message, 'error');
            return;
        }
    } else {
        entityState.detail = {};
    }
    renderEntityList();
    renderEntityGrid();
    renderEntityDetail();
    drawEntityLayer();
}

function renderEntityDetail() {
    const host = document.getElementById('entityDetail');
    if (!host) return;
    const { resource, detail, creating } = entityState;
    if (entityState.overview) {
        host.innerHTML = '<div class="entity-empty">اختر عنصراً من القائمة المرجعية، أو اضغط شكلاً على الخريطة لتحريره</div>';
        return;
    }
    if (!resource || !detail) {
        host.innerHTML = '<div class="entity-empty">اختر سجلاً لعرض تفاصيله</div>';
        return;
    }

    const fields = entityFields(resource);
    const writable = entityWritable(resource);
    const lock = writable ? '' : ' disabled';
    const options = dbPermissions.options || {};
    const controls = fields.map((field) => {
        const value = detail[field.name];
        if (field.type === 'select') {
            const list = options[field.options] || [];
            return `
                <label class="entity-field">
                    <span>${escapeHtml(field.label)}</span>
                    <select name="${escapeHtml(field.name)}"${lock}>
                        <option value="">—</option>
                        ${list.map((o) => `<option value="${escapeHtml(o.id ?? o.value)}" ${String(o.id ?? o.value) === String(value ?? '') ? 'selected' : ''}>${escapeHtml(o.name ?? o.label)}</option>`).join('')}
                    </select>
                </label>`;
        }
        const type = field.type === 'number' ? 'number' : 'text';
        return `
            <label class="entity-field">
                <span>${escapeHtml(field.label)}</span>
                <input type="${type}" name="${escapeHtml(field.name)}" value="${escapeHtml(value ?? '')}" autocomplete="off"${lock}>
            </label>`;
    }).join('');

    // Geometry and derived measures are shown but never sent back.
    const readOnlyPairs = [
        ['lon', 'خط الطول'], ['lat', 'دائرة العرض'],
        ['shape_area', 'المساحة'], ['objectid', 'المعرف المساحي'],
    ].filter(([k]) => detail[k] !== null && detail[k] !== undefined);
    const readOnly = readOnlyPairs.map(([k, label]) => {
        const raw = detail[k];
        const shown = typeof raw === 'number' ? raw.toFixed(k === 'shape_area' ? 0 : 6) : raw;
        return `<div class="entity-readonly-item"><span>${escapeHtml(label)}</span><b>${escapeHtml(shown)}</b></div>`;
    }).join('');

    host.innerHTML = `
        <form id="entityForm" class="entity-form">
            <div class="entity-detail-head">
                <h3>${creating ? 'سجل جديد' : escapeHtml(detail.name ?? '')}</h3>
                ${writable && !creating ? '<button type="button" class="entity-delete-btn" id="entityDeleteBtn"><i class="fa-solid fa-trash-can" aria-hidden="true"></i> حذف</button>' : ''}
                ${writable ? '' : '<span class="entity-readonly-badge"><i class="fa-solid fa-lock" aria-hidden="true"></i> عرض فقط</span>'}
            </div>
            ${writable ? '' : '<p class="entity-readonly-why">هذه بيانات مشتركة بين جميع المراكز؛ التعديل عليها من صلاحيات مشرف النظام.</p>'}
            <div class="entity-fields">${controls}</div>
            ${readOnly ? `<div class="entity-readonly"><span class="entity-readonly-label">قيم للقراءة فقط</span><div class="entity-readonly-grid">${readOnly}</div></div>` : ''}
            <p class="entity-form-error" id="entityFormError" hidden></p>
            <div class="entity-form-actions">
                <button type="button" class="entity-btn ghost" id="entityCancelBtn">${writable ? 'إلغاء' : 'إغلاق'}</button>
                ${writable ? `<button type="submit" class="entity-btn primary">${creating ? 'إنشاء' : 'حفظ'}</button>` : ''}
            </div>
        </form>`;

    document.getElementById('entityCancelBtn').addEventListener('click', () => {
        entityState.selectedId = null;
        entityState.detail = null;
        entityState.creating = false;
        renderEntityList();
        renderEntityGrid();
        renderEntityDetail();
        drawEntityLayer();
    });
    document.getElementById('entityDeleteBtn')?.addEventListener('click', deleteEntityRecord);
    document.getElementById('entityForm').addEventListener('submit', saveEntityRecord);
}

async function saveEntityRecord(event) {
    event.preventDefault();
    const { resource, selectedId, creating } = entityState;
    if (!entityWritable(resource)) return;
    const errorEl = document.getElementById('entityFormError');
    const form = new FormData(event.target);
    const values = {};
    for (const field of entityFields(resource)) {
        const raw = form.get(field.name);
        values[field.name] = field.type === 'number' && raw !== '' && raw !== null ? Number(raw) : (raw ?? '');
    }

    try {
        if (creating) {
            const created = await entityRequest(`entities/${encodeURIComponent(resource)}`, {
                method: 'POST', body: JSON.stringify(values),
            });
            showNotification('تم إنشاء السجل', 'success');
            entityState.search = '';
            const search = document.getElementById('entitySearch');
            if (search) search.value = '';
            await loadEntityRows();
            await openEntityForm(created.id);
        } else {
            await entityRequest(`db/${encodeURIComponent(resource)}/${selectedId}`, {
                method: 'PATCH', body: JSON.stringify(values),
            });
            showNotification('تم حفظ التعديلات', 'success');
            await loadEntityRows();
            await openEntityForm(selectedId);
        }
        await refreshDatasetsAfterEntityWrite();
    } catch (error) {
        if (errorEl) { errorEl.textContent = error.message; errorEl.hidden = false; }
    }
}

async function deleteEntityRecord() {
    const { resource, selectedId, detail } = entityState;
    if (!selectedId || !entityWritable(resource)) return;
    if (!confirm(`حذف «${detail?.name ?? ''}» نهائياً؟`)) return;
    try {
        await entityRequest(`db/${encodeURIComponent(resource)}/${selectedId}`, { method: 'DELETE' });
        showNotification('تم حذف السجل', 'success');
        entityState.selectedId = null;
        entityState.detail = null;
        await loadEntityRows();
        renderEntityDetail();
        await refreshDatasetsAfterEntityWrite();
    } catch (error) {
        showNotification(error.message, 'error');
    }
}

// Reference edits change what the dashboard datasets join against, and the
// server has already dropped its caches, so pull them again for view mode.
async function refreshDatasetsAfterEntityWrite() {
    try {
        await loadDatasetsFromDatabase();
        const parsed = Papa.parse(window.CSV_DATA || '', { header: true, dynamicTyping: true, skipEmptyLines: true });
        applyPlansRows(parsed.data, 'database');
    } catch (error) {
        console.warn('Could not refresh datasets after the edit:', error.message);
    }
}

function clearEntityLayer() {
    if (entityLayerGroup) entityLayerGroup.clearLayers();
}

// Geometry is read-only here, so these are plain styles with no editing
// handles. Colour carries the discriminant; selection is carried by weight and
// opacity instead, so the group a record belongs to stays readable when it is
// the one being edited.
function entityShapeStyle(selected, row) {
    const color = entityColorFor(row);
    return selected
        ? { color: '#f59e0b', weight: 3.5, fillColor: color, fillOpacity: 0.55 }
        : { color, weight: 1.5, fillColor: color, fillOpacity: 0.22 };
}

// A point record of an icon-less entity: the same colour, worn as a plain dot,
// so it is still on the map and still clickable.
function entityDotStyle(selected, row) {
    const color = entityColorFor(row);
    return selected
        ? { radius: 7, color: '#f59e0b', weight: 2.5, fillColor: color, fillOpacity: 0.9 }
        : { radius: 4.5, color, weight: 1.5, fillColor: color, fillOpacity: 0.7 };
}

// How many shapes may carry an icon badge before the map turns into a wall of
// pins. Above this only the selected record is badged; the shapes still read.
const ENTITY_BADGE_LIMIT = 80;
// Covers every entity except paths (~5k) in one request, so "all" really means
// all for the ones people browse most. Past this the footer offers to load the
// rest rather than silently truncating.
const ENTITY_PAGE_SIZE = 2000;
// Icon pins are DOM elements, so thousands of them would crawl. Past this many
// point records only the ones in view (plus a margin) get built, and the layer
// is rebuilt as the map moves — so every record still wears its icon, there are
// just never thousands of nodes alive at once.
const ENTITY_PIN_CULL_AFTER = 300;
let entityViewportBound = false;

// Some entities are drawn without any icon: a line entity gains nothing from a
// glyph pinned at its midpoint. Declared per entity on the server, so the
// frontend does not hardcode which ones.
function entityMapIcons(resource = entityState.resource) {
    const entry = entityState.catalog.find((e) => e.name === resource);
    return !entry || entry.mapIcon !== false;
}

function entityIconClass(row, override) {
    if (override) return override;
    const icons = entityState.icons;
    if (icons && row) {
        const key = row.icon_key;
        if (key && icons.map && icons.map[key]) return icons.map[key];
        if (icons.fallback) return icons.fallback;
    }
    const entry = entityState.catalog.find((e) => e.name === entityState.resource);
    return (entry && entry.icon) || 'fa-location-dot';
}

// The icon says which entity this is; geometry type decides how it is worn —
// a record with no shape becomes the pin itself, a polygon or line keeps its
// shape and gets the icon as a badge at its centre.
function entityPinIcon(color, selected, row, iconOverride) {
    const size = selected ? 28 : 22;
    return L.divIcon({
        className: '',
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
        // One node per pin, not three: the glyph comes from Font Awesome's own
        // ::before on this element, so a thousand markers is a thousand spans
        // rather than a span wrapping an <i>.
        html: `<span class="entity-pin fa-solid ${entityIconClass(row, iconOverride)}${selected ? ' is-selected' : ''}" `
            + `style="--pin-bg:${color};--pin-ink:${inkForFill(color) || '#ffffff'};width:${size}px;height:${size}px"`
            + ` aria-hidden="true"></span>`,
    });
}

// Rebuild the pins as the map moves, so culling follows the viewport. Bound
// once, and never re-fits — the user is the one panning.
function bindEntityViewportRedraw() {
    if (entityViewportBound || !map) return;
    entityViewportBound = true;
    map.on('moveend zoomend', () => {
        if (isEntityWorkspaceActive() && (entityState.resource || entityState.overview)) {
            drawEntityLayer({ fit: false });
        }
    });
}

function drawEntityLayer({ fit = true } = {}) {
    if (!map) return;
    if (!entityLayerGroup) entityLayerGroup = L.layerGroup().addTo(map);
    bindEntityViewportRedraw();
    entityLayerGroup.clearLayers();
    if (appMode !== 'edit') return;
    if (entityState.overview) {
        const bounds = drawOverviewLayer();
        if (fit && bounds && bounds.isValid()) fitMapToGeometry(bounds);
        return;
    }
    if (!entityState.resource) return;

    const titleColumn = entityState.columns[0];
    const allBounds = L.latLngBounds();
    let selectedBounds = null;
    const withIcons = entityMapIcons();
    const badgeAll = withIcons && entityState.rows.length <= ENTITY_BADGE_LIMIT;

    // Records drawn as a pin rather than a shape; only these need culling.
    const pinCount = entityState.rows.reduce(
        (n, r) => n + (!r.geojson && Number.isFinite(r.lon) && Number.isFinite(r.lat) ? 1 : 0), 0);
    const cullPins = pinCount > ENTITY_PIN_CULL_AFTER;
    const viewport = cullPins ? map.getBounds().pad(0.3) : null;

    entityState.rows.forEach((row) => {
        const selected = row.id === entityState.selectedId;
        const label = String(row[titleColumn] ?? '');
        const color = entityColorFor(row);
        const tip = row.color_key ? `${label} — ${row.color_key}` : label;
        // The selected record is drawn from the detail endpoint's exact shape;
        // the rest from the simplified shape that came with the list.
        const shape = (selected && entityState.detail && entityState.detail.geojson) || row.geojson;

        const attach = (layer) => {
            layer.addTo(entityLayerGroup);
            if (tip) layer.bindTooltip(tip, { direction: 'top', sticky: true });
            layer.on('click', () => openEntityForm(row.id));
        };

        let shapeLayer = null;
        if (shape) {
            try {
                shapeLayer = L.geoJSON(JSON.parse(shape), {
                    style: () => entityShapeStyle(selected, row),
                    // A bare GeoJSON Point is the pin case, not a shape.
                    pointToLayer: (_feature, latlng) => (withIcons
                        ? L.marker(latlng, {
                            icon: entityPinIcon(color, selected, row),
                            zIndexOffset: selected ? 1000 : 0,
                        })
                        : L.circleMarker(latlng, entityDotStyle(selected, row))),
                });
            } catch (_e) {
                shapeLayer = null; // a malformed shape must not blank the map
            }
        }

        let bounds = null;
        if (shapeLayer) {
            attach(shapeLayer);
            bounds = shapeLayer.getBounds();
            // Polygons and lines wear the icon as a badge at their centre.
            const isAreaOrLine = /Polygon|LineString/.test(JSON.parse(shape).type || '');
            if (isAreaOrLine && withIcons && (badgeAll || selected) && bounds && bounds.isValid()) {
                attach(L.marker(bounds.getCenter(), {
                    icon: entityPinIcon(color, selected, row),
                    zIndexOffset: selected ? 1000 : 0,
                }));
            }
        } else if (Number.isFinite(row.lon) && Number.isFinite(row.lat)) {
            const at = L.latLng(row.lat, row.lon);
            bounds = L.latLngBounds(at, at);
            // Every point record wears its icon. Off-screen ones are simply not
            // built this pass; the moveend redraw brings them in as you pan, and
            // the bounds above still come from the full set so the fit is right.
            if (!viewport || selected || viewport.contains(at)) {
                attach(withIcons
                    ? L.marker(at, {
                        icon: entityPinIcon(color, selected, row),
                        zIndexOffset: selected ? 1000 : 0,
                    })
                    : L.circleMarker(at, entityDotStyle(selected, row)));
            }
        }

        if (bounds && bounds.isValid()) {
            allBounds.extend(bounds);
            if (selected) selectedBounds = bounds;
        }
    });

    renderDistrictReference();

    if (!fit) return;
    if (selectedBounds) fitMapToGeometry(selectedBounds);
    else if (allBounds.isValid()) fitMapToGeometry(allBounds);
}

// ---------------------------------------------------------------- plan import

function readFileText(input) {
    const file = input && input.files && input.files[0];
    if (!file) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error(`تعذر قراءة الملف ${file.name}`));
        reader.readAsText(file);
    });
}

async function collectPlanFiles() {
    const [assignCampUsers, assignResidences, periodPreferences, mashaersTrips] = await Promise.all([
        readFileText(document.getElementById('fileAssignCampUsers')),
        readFileText(document.getElementById('fileAssignResidences')),
        readFileText(document.getElementById('filePeriodPreferences')),
        readFileText(document.getElementById('fileMashaersTrips')),
    ]);
    return { assignCampUsers, assignResidences, periodPreferences, mashaersTrips };
}

// The three steps are advisory: they show where the user is, and the analyse
// button stays the only gate on the write.
function planStep(step) {
    const order = ['files', 'analyze', 'commit'];
    const at = order.indexOf(step);
    document.querySelectorAll('#planSteps .plan-step').forEach((el) => {
        const i = order.indexOf(el.dataset.step);
        el.classList.toggle('is-active', i === at);
        el.classList.toggle('is-done', i < at);
    });
}

const PLAN_REQUIRED_FILES = ['fileAssignCampUsers', 'fileAssignResidences', 'filePeriodPreferences'];

// Reflect each chosen file back: name, size and line count, so a wrong or empty
// file is obvious before analysing rather than after.
function planFileState(input) {
    const state = document.querySelector(`.plan-file-state[data-for="${input.id}"]`);
    const card = input.closest('.plan-file-card');
    const file = input.files && input.files[0];
    if (!state || !card) return;

    if (!file) {
        card.classList.remove('is-filled', 'is-problem');
        state.textContent = 'لم يُختر ملف';
        return;
    }

    const kb = file.size < 1024 ? `${file.size} بايت` : `${Math.round(file.size / 1024).toLocaleString()} كيلوبايت`;
    const looksCsv = /\.csv$/i.test(file.name) || /csv/i.test(file.type || '');
    card.classList.toggle('is-problem', !looksCsv || file.size === 0);
    card.classList.toggle('is-filled', looksCsv && file.size > 0);
    state.textContent = file.size === 0
        ? `${file.name} — الملف فارغ`
        : (!looksCsv ? `${file.name} — ليس ملف CSV` : `${file.name} · ${kb}`);

    // Row count needs a read; worth it, since "0 rows" is the usual surprise.
    if (looksCsv && file.size > 0) {
        const reader = new FileReader();
        reader.onload = () => {
            const rows = String(reader.result || '').split(/\r?\n/).filter((l) => l.trim()).length - 1;
            state.textContent = `${file.name} · ${kb} · ${Math.max(0, rows).toLocaleString()} صفاً`;
            if (rows <= 0) { card.classList.add('is-problem'); state.textContent = `${file.name} — لا صفوف بيانات`; }
        };
        reader.onerror = () => {};
        reader.readAsText(file);
    }
}

function planFilesReady() {
    return PLAN_REQUIRED_FILES.some((id) => {
        const el = document.getElementById(id);
        return el && el.files && el.files.length;
    });
}

function planMsg(text, kind = 'info') {
    const el = document.getElementById('planImportMessage');
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || '';
    el.className = `plan-modal-message plan-msg-${kind}`;
}

function renderPlanSummary(s) {
    const box = document.getElementById('planImportSummary');
    if (!box) return;

    const typeLabels = { tarwia: 'تروية', direct_taseed: 'تصعيد مباشر', taseed_tarwia: 'تصعيد تروية', efada: 'إفاضة', nafra: 'نفرة' };
    const typeIcons = { tarwia: 'fa-tent', direct_taseed: 'fa-right-to-bracket', taseed_tarwia: 'fa-arrow-right-arrow-left', efada: 'fa-flag', nafra: 'fa-bus' };
    const byType = s.plans.byType || {};

    const tile = (icon, label, value) => `
        <div class="plan-sum-tile">
            <i class="fa-solid ${icon}" aria-hidden="true"></i>
            <span class="plan-sum-label">${label}</span>
            <b class="plan-sum-value">${Number(value || 0).toLocaleString()}</b>
        </div>`;

    const phases = Object.entries(byType).map(([code, n]) => `
        <div class="plan-phase">
            <i class="fa-solid ${typeIcons[code] || 'fa-diagram-project'}" aria-hidden="true"></i>
            <span>${typeLabels[code] || code}</span>
            <b>${Number(n).toLocaleString()}</b>
        </div>`).join('');

    // Split by consequence: the unmatched lists mean rows will be dropped, the
    // notices only qualify what gets built.
    const unmatched = s.unmatched || {};
    const dropped = [
        ['مخيمات غير معروفة', unmatched.camps],
        ['مساكن غير معروفة', unmatched.residences],
        ['جنسيات غير معروفة', unmatched.countries],
    ].filter(([, arr]) => arr && arr.length);

    const notices = (s.warnings || []).concat(s.planIssues || []);
    if (!s.routingConfigured) notices.push('خدمة المسارات غير مهيأة؛ ستُستخدم مسارات مستقيمة مؤقتاً.');

    box.hidden = false;
    box.innerHTML = `
        <div class="plan-sum-head">
            <h3><i class="fa-solid fa-clipboard-check" aria-hidden="true"></i> ملخص التحليل</h3>
            <span class="plan-sum-center">
                <i class="fa-solid fa-sitemap" aria-hidden="true"></i>
                ${escapeHtml(s.center.name || '')} · ${escapeHtml(String(s.center.office || ''))}
            </span>
        </div>

        <div class="plan-sum-tiles">
            ${tile('fa-diagram-project', 'خطط', s.plans.total)}
            ${tile('fa-bus', 'حافلات', s.plans.totalBuses)}
            ${tile('fa-route', 'رحلات', s.plans.totalTrips)}
            ${tile('fa-users', 'حجاج', s.plans.totalHaj)}
            ${tile('fa-tent', 'تعيينات مخيمات', s.assignCamps)}
            ${tile('fa-house', 'تعيينات مساكن', s.assignResidences)}
            ${tile('fa-bus-simple', 'حافلات مُخصّصة', s.mashaersTrips)}
        </div>

        ${phases ? `<div class="plan-phases">${phases}</div>`
                 : '<div class="plan-warn"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> لا توجد خطط قابلة للإنشاء من هذه الملفات</div>'}

        ${dropped.length ? `
            <div class="plan-notice is-dropped">
                <div class="plan-notice-head"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i> صفوف لم يُعرف ما تشير إليه — ستُتجاهل</div>
                ${dropped.map(([label, arr]) => `
                    <div class="plan-notice-line">
                        <b>${label} (${arr.length}):</b>
                        ${escapeHtml(arr.slice(0, 15).join('، '))}${arr.length > 15 ? ' …' : ''}
                    </div>`).join('')}
            </div>` : ''}

        ${notices.length ? `
            <div class="plan-notice">
                <div class="plan-notice-head"><i class="fa-solid fa-circle-info" aria-hidden="true"></i> ملاحظات (${notices.length})</div>
                ${notices.map((n) => `<div class="plan-notice-line">${escapeHtml(n)}</div>`).join('')}
            </div>` : ''}
    `;
}

async function planImportRequest(path, files) {
    const response = await fetch(`/maan-dashboard/api/plan-import/${path}`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ files }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
}

function initPlanImport() {
    const btn = document.getElementById('planImportBtn');
    const modal = document.getElementById('planImportModal');
    if (!btn || !modal) return;

    const analyzeBtn = document.getElementById('planAnalyzeBtn');
    const commitBtn = document.getElementById('planCommitBtn');
    let lastFiles = null;
    const PLAN_FILE_INPUT_IDS = ['fileAssignCampUsers', 'fileAssignResidences', 'filePeriodPreferences', 'fileMashaersTrips'];

    const openModal = () => { modal.hidden = false; planStep('files'); };
    const closeModal = () => { modal.hidden = true; };
    const resetAfterChange = () => { commitBtn.hidden = true; lastFiles = null; };

    // Only show the button to users the server says may import — and only in
    // edit mode, since importing creates plans.
    fetch('/maan-dashboard/api/plan-import/capabilities', { headers: authHeaders() })
        .then((r) => (r.ok ? r.json() : null))
        .then((cap) => { mayImportPlans = Boolean(cap && cap.mayImport); syncImportButton(); })
        .catch(() => {});

    btn.addEventListener('click', openModal);
    document.getElementById('planModalClose')?.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    PLAN_FILE_INPUT_IDS.forEach((id) => {
        const input = document.getElementById(id);
        if (!input) return;
        input.addEventListener('change', () => {
            planFileState(input);
            resetAfterChange();
            planStep('files');
            planMsg('');
            analyzeBtn.disabled = !planFilesReady();
        });
        planFileState(input);
    });
    analyzeBtn.disabled = !planFilesReady();

    analyzeBtn.addEventListener('click', async () => {
        analyzeBtn.disabled = true;
        planStep('analyze');
        planMsg('جارٍ تحليل الملفات…', 'info');
        document.getElementById('planImportSummary').hidden = true;
        commitBtn.hidden = true;
        try {
            const files = await collectPlanFiles();
            if (!files.assignCampUsers && !files.assignResidences && !files.periodPreferences) {
                planMsg('يرجى اختيار الملفات المطلوبة أولاً.', 'error');
                planStep('files');
                return;
            }
            const summary = await planImportRequest('analyze', files);
            lastFiles = files;
            renderPlanSummary(summary);
            if (summary.plans.total === 0) {
                commitBtn.hidden = true;
                planMsg('لم ينتج عن الملفات أي خطة — راجع التنبيهات أدناه.', 'error');
            } else {
                commitBtn.hidden = false;
                planMsg(`جاهز لإنشاء ${summary.plans.total.toLocaleString()} خطة. راجع الملخص ثم اعتمد.`, 'success');
            }
        } catch (err) {
            planMsg(err.message, 'error');
            planStep('files');
        } finally {
            analyzeBtn.disabled = !planFilesReady();
        }
    });

    commitBtn.addEventListener('click', async () => {
        if (!lastFiles) { planMsg('يرجى تحليل الملفات أولاً.', 'error'); return; }
        commitBtn.disabled = true;
        planStep('commit');
        planMsg('جارٍ إنشاء الخطط…', 'info');
        try {
            const summary = await planImportRequest('commit', lastFiles);
            planMsg(`تم إنشاء ${summary.plansCreated} خطة بنجاح. جارٍ تحديث اللوحة…`, 'success');
            commitBtn.hidden = true;
            // Rebuild the dashboard from the freshly written data.
            await loadDatasetsFromDatabase();
            loadData();
            setTimeout(closeModal, 1500);
        } catch (err) {
            planMsg(err.message, 'error');
            planStep('analyze');
        } finally {
            commitBtn.disabled = false;
        }
    });
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
        ctx.font = `700 ${fontSize}px 'IBM Plex Sans Arabic', system-ui, sans-serif`;

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
    const isChartContainer = element.classList?.contains('plotly-chart');

    if (isChartContainer) {
        const canvas = element.querySelector('canvas');
        if (!canvas) return;
        const chart = (typeof Chart !== 'undefined' && Chart.getChart) ? Chart.getChart(canvas) : null;
        imageData = chart?.toBase64Image?.() || canvas.toDataURL('image/png');
    } else if (isCanvas) {
        const chart = (typeof Chart !== 'undefined' && Chart.getChart) ? Chart.getChart(element) : null;
        imageData = chart?.toBase64Image?.() || element.toDataURL('image/png');
    } else {
        return;
    }

    const title = getChartTitleFromElement(element);
    const isLightMode = document.body.classList.contains('light-mode');
    const popupTheme = isLightMode
        ? {
            bodyBg: '#f8fafc',
            panelBg: '#ffffff',
            text: '#0f172a',
            border: '#e2e8f0',
            shadow: '0 18px 48px rgba(15, 23, 42, 0.10)'
        }
        : {
            bodyBg: '#0b1220',
            panelBg: '#0f172a',
            text: '#e2e8f0',
            border: '#243249',
            shadow: 'none'
        };
    const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { margin: 0; font-family: 'IBM Plex Sans Arabic', system-ui, sans-serif; background: ${popupTheme.bodyBg}; color: ${popupTheme.text}; }
    .wrap { min-height: 100vh; display: flex; flex-direction: column; gap: 10px; padding: 18px; box-sizing: border-box; }
    h1 { margin: 0; font-size: 20px; font-weight: 800; }
    .panel { flex: 1; border-radius: 12px; background: ${popupTheme.panelBg}; border: 1px solid ${popupTheme.border}; box-shadow: ${popupTheme.shadow}; padding: 14px; display: grid; place-items: center; }
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
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const popup = window.open(url, '_blank', CHART_POPOUT_WINDOW_FEATURES);

    if (!popup) {
        window.location.href = url;
        return;
    }

    setTimeout(() => URL.revokeObjectURL(url), 30000);
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

function requestDashboardResize() {
    if (dashboardResizeFrameId) cancelAnimationFrame(dashboardResizeFrameId);

    dashboardResizeFrameId = requestAnimationFrame(() => {
        dashboardResizeFrameId = null;
        if (map) map.invalidateSize();
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
        if (event.target.closest('.panel-collapse-toggle')) return;
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

function updatePanelToggleButton(button, collapsed, hiddenLabel, shownLabel, collapsedIcon, expandedIcon) {
    if (!button) return;
    button.classList.toggle('is-collapsed', collapsed);
    button.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
    button.setAttribute('aria-label', collapsed ? shownLabel : hiddenLabel);
    button.setAttribute('title', collapsed ? shownLabel : hiddenLabel);
    button.innerHTML = `<i class="fa-solid ${collapsed ? collapsedIcon : expandedIcon}"></i>`;
}

function applyPanelVisibilityState() {
    const sidebarCollapsed = getPersistentValue(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
    const chartsCollapsed = getPersistentValue(CHARTS_PANEL_COLLAPSED_STORAGE_KEY) === 'true';

    document.body.classList.toggle('sidebar-panel-collapsed', sidebarCollapsed);
    document.body.classList.toggle('charts-panel-collapsed', chartsCollapsed);

    updatePanelToggleButton(
        document.getElementById('sidebarPanelToggleBtn'),
        sidebarCollapsed,
        'إخفاء لوحة الفلاتر',
        'إظهار لوحة الفلاتر',
        'fa-chevron-left',
        'fa-chevron-right'
    );
    updatePanelToggleButton(
        document.getElementById('chartsPanelToggleBtn'),
        chartsCollapsed,
        'إخفاء لوحة الرسوم',
        'إظهار لوحة الرسوم',
        'fa-chevron-right',
        'fa-chevron-left'
    );

    requestDashboardResize();
}

function initPanelVisibilityControls() {
    const sidebarToggleBtn = document.getElementById('sidebarPanelToggleBtn');
    const chartsToggleBtn = document.getElementById('chartsPanelToggleBtn');

    sidebarToggleBtn?.addEventListener('click', () => {
        const nextCollapsed = !document.body.classList.contains('sidebar-panel-collapsed');
        setPersistentValue(SIDEBAR_COLLAPSED_STORAGE_KEY, String(nextCollapsed));
        applyPanelVisibilityState();
    });

    chartsToggleBtn?.addEventListener('click', () => {
        const nextCollapsed = !document.body.classList.contains('charts-panel-collapsed');
        setPersistentValue(CHARTS_PANEL_COLLAPSED_STORAGE_KEY, String(nextCollapsed));
        applyPanelVisibilityState();
    });

    applyPanelVisibilityState();
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
        Chart.defaults.font.family = "'IBM Plex Sans Arabic', system-ui, sans-serif";
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
    // The entity palette is stepped per theme (each set is validated against
    // its own basemap), so a theme change has to restyle the map.
    if (typeof entityState !== 'undefined' && entityState.rows.length) {
        entityState.colors = buildEntityColors(entityState.rows);
        renderEntityLegend();
        drawEntityLayer();
    }
    if (typeof renderDistrictReference === 'function') renderDistrictReference();
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

function isDomesticHajjCampRow(row) {
    return normalizeTextKey(row.service_company_name).includes('حجاج الداخل')
        || normalizeTextKey(row.nationality) === 'حجاج الداخل';
}

function buildAssignmentTotalsFromCampRows(rows) {
    const companyMetrics = new Map();
    const centerMetrics = new Map();

    rows.forEach(row => {
        if (isDomesticHajjCampRow(row)) return;

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

function hasActiveMapFilter() {
    const period = document.getElementById('periodFilter')?.value || 'all';
    const transport = document.getElementById('transportFilter')?.value || 'all';
    const district = document.getElementById('districtFilter')?.value || 'all';
    const search = document.querySelector('.search-bar input')?.value?.trim() || '';

    return Boolean(
        selectedPlanId
        || selectedEntranceName
        || selectedPathName
        || selectedDistrict
        || hasServiceEntitySelection()
        || selectedPlanTypes.size
        || selectedResidenceMixFilter !== 'all'
        || period !== 'all'
        || transport !== 'all'
        || district !== 'all'
        || search
    );
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

function normalizePlanTypeCode(value) {
    const normalized = normalizeTextKey(value);
    if (!normalized) return '';
    if (normalized.includes('direct_taseed') || normalized.includes('تصعيد مباشر')) return 'direct_taseed';
    if (normalized.includes('taseed_tarwia') || normalized.includes('تصعيد تروية')) return 'taseed_tarwia';
    if (normalized.includes('tarwia') || normalized.includes('tarwiya') || normalized.includes('تروية')) return 'tarwia';
    if (normalized.includes('efada') || normalized.includes('إفاضة') || normalized.includes('افاضة')) return 'efada';
    if (normalized.includes('nafra') || normalized.includes('نفرة')) return 'nafra';
    return normalized;
}

function getPlanTypeRingOrderIndex(row) {
    const code = normalizePlanTypeCode(
        row.planTypeCode
        || row.plan_type_code
        || row.code
        || row.plan_type_name
        || row.label
    );
    const orderIndex = PLAN_TYPE_RING_ORDER.indexOf(code);
    return orderIndex === -1 ? PLAN_TYPE_RING_ORDER.length : orderIndex;
}

// Load CSV Data
function loadData() {
    if (typeof CSV_DATA === 'undefined') {
        alert("تعذر تحميل بيانات الخطط من قاعدة البيانات.");
        return;
    }

    // GeoJSON data removed - using only core data files (assign_camps, assign_residences, data.js)


    loadAssignCampTotals();
    loadResidenceAssignments();

    const loadId = ++plansCsvLoadSequence;
    parsePlansCsv(CSV_DATA, {
        loadId,
        source: typeof PLANS_CSV_SOURCE !== 'undefined' ? PLANS_CSV_SOURCE : 'database'
    });

}

const REQUIRED_CSV_COLUMNS = [
    'plan_id', 'camp_label', 'allocated_haj', 'number_of_buses', 'number_of_haj',
    'get_type_parking', 'get_parking_name', 'get_parking_geom',
    'set_type_parking', 'set_parking_name', 'set_parking_geom', 'entrance_asm_code',
    'entrance_name', 'entrance_point_geom', 'entrance_polygon', 'start_point_name',
    'start_geom', 'start_point_district', 'start_point_type', 'start_point_geom',
    'end_point_name', 'end_geom', 'end_point_type', 'end_point_geom', 'path_geom',
    'path_name', 'internal_path', 'owner_company_name', 'owner_office_number',
    'period', 'timing_start_at', 'timing_start_at_hijri', 'timing_end_at',
    'timing_end_at_hijri', 'plan_type_name', 'plan_type_code', 'transport_type_name'
];

const NUMERIC_COLUMNS = new Set([
    'allocated_haj', 'number_of_buses', 'number_of_haj',
    'number_of_late_haj', 'number_of_early_haj',
    'owner_office_number'
]);

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

    if (source && source !== 'data.js') {
        showNotification(`✓ تم تحميل البيانات من ${source} (${rawData.length} صف)`, 'success');
    }
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

function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${type === 'success' ? '#10b981' : '#3b82f6'};
        color: white;
        padding: 12px 20px;
        border-radius: 6px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        z-index: 10000;
        font-size: 14px;
        animation: slideIn 0.3s ease;
    `;
    document.body.appendChild(notification);
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

function resetSelections() {
    selectedPlanId = null;
    selectedTripServiceCenter = null;
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

function normalizeCampLabel(value) {
    return String(value || '').trim();
}

function getTarwiaExitRouteForCamp(campLabel) {
    const normalizedCampLabel = normalizeCampLabel(campLabel);
    if (!normalizedCampLabel || typeof MIN_MINASM_DATA === 'undefined' || !Array.isArray(MIN_MINASM_DATA.features)) {
        return null;
    }

    const routeFeature = MIN_MINASM_DATA.features.find(feature =>
        normalizeCampLabel(feature?.properties?.camp_label) === normalizedCampLabel
    );
    if (!routeFeature?.geometry) return null;

    const exitCode = String(routeFeature.properties?.ASMCODE || '').trim();
    const exitFeature = typeof EXIT_POINTS_DATA !== 'undefined' && Array.isArray(EXIT_POINTS_DATA.features)
        ? EXIT_POINTS_DATA.features.find(feature => String(feature?.properties?.MINASM_Code || '').trim() === exitCode)
        : null;

    return {
        routeFeature,
        exitFeature,
        exitCode,
        exitName: exitFeature?.properties?.MINASM_Name || routeFeature.properties?.MINASM || exitCode
    };
}

function getRowGeojsons(row) {
    const geojsonsToRender = [];
    const planTypeCode = normalizePlanTypeCode(row['plan_type_code'] || row['plan_type_name']);

    let targetBaseName = null;
    if (planTypeCode === 'tarwia') targetBaseName = 'ASMMIN';
    else if (planTypeCode === 'taseed_tarwia') targetBaseName = 'MINARF';
    else if (planTypeCode === 'efada') targetBaseName = 'ARFMUZ';
    else if (planTypeCode === 'nafra') targetBaseName = 'MINARF';

    if (row['internal_path']) {
        const internalGeojson = parseGeom(row['internal_path']);
        if (internalGeojson && internalGeojson.coordinates) {
            geojsonsToRender.push({ geojson: internalGeojson, type: 'internal' });
            if (window.DEBUG_PATHS) console.log('Internal path added:', internalGeojson.type, internalGeojson.coordinates.length, 'coords');
        } else if (window.DEBUG_PATHS) {
            console.log('Failed to parse internal_path:', row['internal_path']?.substring(0, 50));
        }
    } else if (targetBaseName && geojsonLookup[targetBaseName]) {
        const feature = geojsonLookup[targetBaseName][row['camp_label']];
        if (feature && feature.geometry) geojsonsToRender.push({ geojson: feature.geometry, type: 'internal' });
    } else if (planTypeCode === 'direct_taseed' && typeof MAKAF_PATHS_DATA !== 'undefined') {
        const campLabel = (row['camp_label'] || '').trim();
        const asmCode = (row['entrance_asm_code'] || '').trim();
        const feature = MAKAF_PATHS_DATA.features.find(f => {
            const p = f.properties;
            return p.camp_label?.trim() === campLabel &&
                   (!asmCode || p.ASM_CODE?.trim() === asmCode);
        });
        if (feature && feature.geometry) geojsonsToRender.push({ geojson: feature.geometry, type: 'internal' });
    }

    if (planTypeCode === 'tarwia') {
        const exitRoute = getTarwiaExitRouteForCamp(row['camp_label']);
        if (exitRoute?.routeFeature?.geometry) {
            geojsonsToRender.push({
                geojson: exitRoute.routeFeature.geometry,
                type: 'tarwia_exit',
                label: exitRoute.exitName,
                exitCode: exitRoute.exitCode,
                exitLatLng: getRepresentativeLatLngFromGeojson(exitRoute.exitFeature?.geometry)
            });
        }
        if (exitRoute?.exitFeature?.geometry) {
            geojsonsToRender.push({
                geojson: exitRoute.exitFeature.geometry,
                type: 'tarwia_exit_point',
                label: exitRoute.exitName,
                exitCode: exitRoute.exitCode
            });
        }
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

    // Add parking locations
    const getParkingGeom = row['get_parking_geom'];
    const setParkingGeom = row['set_parking_geom'];
    const isSameParking = getParkingGeom && setParkingGeom && getParkingGeom === setParkingGeom;

    if (getParkingGeom) {
        const getParkingGeojson = parseGeom(getParkingGeom);
        if (getParkingGeojson && getParkingGeojson.coordinates) {
            geojsonsToRender.push({
                geojson: getParkingGeojson,
                type: isSameParking ? 'parking_combined' : 'get_parking',
                label: row['get_parking_name'],
                isSameParking: isSameParking
            });
        }
    }

    if (setParkingGeom && !isSameParking) {
        const setParkingGeojson = parseGeom(setParkingGeom);
        if (setParkingGeojson && setParkingGeojson.coordinates) {
            geojsonsToRender.push({
                geojson: setParkingGeojson,
                type: 'set_parking',
                label: row['set_parking_name']
            });
        }
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
    if (item.type === 'tarwia_exit_point') return String(item.label || item.exitCode || '').trim();
    if (item.type === 'start') return String(row['start_point_name'] || '').trim();
    if (item.type === 'end') return String(row['end_point_name'] || '').trim();
    if (item.type === 'entrance') return String(row['entrance_name'] || row['entrance_asm_code'] || '').trim();
    if (item.type === 'get_parking') {
        const type = String(row['get_type_parking'] || '').trim();
        const name = String(row['get_parking_name'] || '').trim();
        return 'استلام: ' + (type && name ? type + '/' + name : name || type);
    }
    if (item.type === 'set_parking') {
        const type = String(row['set_type_parking'] || '').trim();
        const name = String(row['set_parking_name'] || '').trim();
        return 'تسليم: ' + (type && name ? type + '/' + name : name || type);
    }
    if (item.type === 'parking_combined') {
        const getType = String(row['get_type_parking'] || '').trim();
        const getName = String(row['get_parking_name'] || '').trim();
        const setType = String(row['set_type_parking'] || '').trim();
        const getLabel = getType && getName ? getType + '/' + getName : getName || getType;
        return 'استلام و تسليم: ' + getLabel;
    }
    return item.label || '';
}

function getAreaLabel(row, item) {
    if (item.type === 'tarwia_exit') return String(item.label || item.exitCode || row['camp_label'] || '').trim();
    if (item.type === 'tarwia_exit_point') return String(item.label || item.exitCode || '').trim();
    if (item.type === 'internal') return String(row['path_name'] || row['camp_label'] || '').trim();
    if (item.type === 'entrance') return String(row['entrance_name'] || row['entrance_asm_code'] || '').trim();
    if (item.type === 'end') return String(row['end_point_name'] || '').trim();
    if (item.type === 'start') return String(row['start_point_name'] || '').trim();
    if (item.type === 'get_parking') {
        const type = String(row['get_type_parking'] || '').trim();
        const name = String(row['get_parking_name'] || '').trim();
        return 'استلام: ' + (type && name ? type + '/' + name : name || type);
    }
    if (item.type === 'set_parking') {
        const type = String(row['set_type_parking'] || '').trim();
        const name = String(row['set_parking_name'] || '').trim();
        return 'تسليم: ' + (type && name ? type + '/' + name : name || type);
    }
    if (item.type === 'parking_combined') {
        const getType = String(row['get_type_parking'] || '').trim();
        const getName = String(row['get_parking_name'] || '').trim();
        const setType = String(row['set_type_parking'] || '').trim();
        const getLabel = getType && getName ? getType + '/' + getName : getName || getType;
        return 'استلام و تسليم: ' + getLabel;
    }
    return item.label || '';
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

function getRowGeomLatLng(row, fields) {
    for (const field of fields) {
        const latlng = getRepresentativeLatLngFromGeojson(parseGeom(row?.[field]));
        if (latlng) return latlng;
    }
    return null;
}

function getRouteResidenceAnchor(row) {
    if (row?.['start_point_type'] === 'residence') {
        return getRowAnchorLatLng(row, 'start');
    }
    if (row?.['end_point_type'] === 'residence') {
        return getRowAnchorLatLng(row, 'end');
    }
    return null;
}

function getRouteDestinationAnchor(row) {
    return getRowGeomLatLng(row, ['entrance_point_geom', 'entrance_polygon'])
        || (row?.['start_point_type'] !== 'residence' ? getRowAnchorLatLng(row, 'start') : null)
        || (row?.['end_point_type'] !== 'residence' ? getRowAnchorLatLng(row, 'end') : null);
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
    // Internal camp paths flow from the entrance into the camp, except for plan
    // types that arrive at their entrance rather than leaving through it.
    if (item?.type === "internal") {
        const entranceAnchor = getRowGeomLatLng(row, ["entrance_point_geom", "entrance_polygon"]);
        if (entranceAnchor) {
            const planTypeCode = normalizePlanTypeCode(row['plan_type_code'] || row['plan_type_name']);
            const entranceIsNearerLast =
                getLatLngDistance(last, entranceAnchor) < getLatLngDistance(first, entranceAnchor);
            const entranceBelongsAtEnd = PLAN_TYPES_ARRIVING_AT_ENTRANCE.has(planTypeCode);
            return entranceIsNearerLast === entranceBelongsAtEnd ? latlngs : [...latlngs].reverse();
        }
    }

    const residenceAnchor = getRouteResidenceAnchor(row);
    const destinationAnchor = getRouteDestinationAnchor(row);
    const startAnchor = getRowAnchorLatLng(row, 'start');
    const endAnchor = getRowAnchorLatLng(row, 'end');
    const thresholdMeters = item?.type === 'internal' ? 10 : 6;

    if (residenceAnchor && destinationAnchor) {
        const forwardScore = getLatLngDistance(first, residenceAnchor) + getLatLngDistance(last, destinationAnchor);
        const reverseScore = getLatLngDistance(last, residenceAnchor) + getLatLngDistance(first, destinationAnchor);
        return reverseScore + thresholdMeters < forwardScore ? [...latlngs].reverse() : latlngs;
    }

    if (residenceAnchor) {
        return getLatLngDistance(last, residenceAnchor) + thresholdMeters < getLatLngDistance(first, residenceAnchor)
            ? [...latlngs].reverse()
            : latlngs;
    }

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

    const startAnchor = getRouteResidenceAnchor(row) || getRowAnchorLatLng(row, 'start');
    // Plans that depart through the entrance continue into the camp, so the
    // sequence must end at the camp, not the entrance; anchoring on the
    // entrance flips the internal segment and the gap connector spans the camp.
    const planTypeCode = normalizePlanTypeCode(row['plan_type_code'] || row['plan_type_name']);
    const departsThroughEntrance = !PLAN_TYPES_ARRIVING_AT_ENTRANCE.has(planTypeCode)
        && segments.some(item => item.type === 'internal');
    const endAnchor = (departsThroughEntrance && row['end_point_type'] !== 'residence' && getRowAnchorLatLng(row, 'end'))
        || getRouteDestinationAnchor(row) || getRowAnchorLatLng(row, 'end');
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

function addRouteConnector(fromLatLng, toLatLng, showArrows = false) {
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

}

function addDirectionalArrows(latlngs, color) {
    addDirectionalArrowsToGroup(latlngs, color, routeLayerGroup);
}

function shouldShowDirectionalArrows(row, item) {
    const planTypeCode = normalizePlanTypeCode(row?.['plan_type_code'] || row?.['plan_type_name']);
    return planTypeCode === 'direct_taseed' && (item?.type === 'internal' || item?.type === 'external');
}

function shouldRenderRouteConnectors(row) {
    const planTypeCode = normalizePlanTypeCode(row?.['plan_type_code'] || row?.['plan_type_name']);
    return planTypeCode === 'direct_taseed';
}

function addDirectionalArrowsToGroup(latlngs, color, group) {
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
        }).addTo(group);
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
        zoomControl: false, // Move to bottom right
        // Deeper than any basemap has tiles; the layers upscale past their own
        // limit so editing can zoom right into a camp shape.
        maxZoom: MAP_MAX_ZOOM,
    }).setView([21.4225, 39.8262], 13);

    L.control.zoom({
        position: 'bottomright'
    }).addTo(map);

    // Basemaps
    const darkBaseMap = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri', maxNativeZoom: ESRI_CANVAS_MAX_ZOOM, maxZoom: MAP_MAX_ZOOM
    });
    const darkRoadLabelsMap = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Labels &copy; Esri', maxNativeZoom: ESRI_CANVAS_MAX_ZOOM, maxZoom: MAP_MAX_ZOOM
    });
    const darkMap = L.layerGroup([darkBaseMap, darkRoadLabelsMap]);

    const lightBaseMap = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri', maxNativeZoom: ESRI_CANVAS_MAX_ZOOM, maxZoom: MAP_MAX_ZOOM
    });
    const lightRoadLabelsMap = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Labels &copy; Esri', maxNativeZoom: ESRI_CANVAS_MAX_ZOOM, maxZoom: MAP_MAX_ZOOM
    });
    const lightMap = L.layerGroup([lightBaseMap, lightRoadLabelsMap]);

    const streetsMap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors', maxNativeZoom: 19, maxZoom: MAP_MAX_ZOOM
    });

    const satelliteMap = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
        maxNativeZoom: 19, maxZoom: MAP_MAX_ZOOM
    });

    lightMapLayer = lightMap;
    darkMapLayer = darkMap;

    if (document.body.classList.contains('dark-mode')) {
        darkMap.addTo(map);
    } else {
        lightMap.addTo(map);
    }

    // Layer control — custom buttons
    const baseLayers = [
        { label: 'فاتح',        icon: 'fa-sun',       layer: lightMap },
        { label: 'شوارع',       icon: 'fa-road',      layer: streetsMap },
        { label: 'داكن',        icon: 'fa-moon',      layer: darkMap },
        { label: 'قمر صناعي',   icon: 'fa-satellite', layer: satelliteMap }
    ];

    const BasemapControl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd() {
            const container = L.DomUtil.create('div', 'leaflet-control basemap-btn-control');
            L.DomEvent.disableClickPropagation(container);
            baseLayers.forEach(({ label, icon, layer }) => {
                const btn = L.DomUtil.create('button', 'basemap-btn', container);
                btn.type = 'button';
                btn.title = label;
                btn.innerHTML = `<i class="fa-solid ${icon}"></i>`;
                if (map.hasLayer(layer)) btn.classList.add('active');
                L.DomEvent.on(btn, 'click', (e) => {
                    L.DomEvent.preventDefault(e);
                    baseLayers.forEach(b => map.removeLayer(b.layer));
                    layer.addTo(map);
                    container.querySelectorAll('.basemap-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    lightMapLayer = (layer === lightMap) ? lightMap : lightMapLayer;
                    darkMapLayer  = (layer === darkMap)     ? darkMap     : darkMapLayer;
                });
            });
            return container;
        }
    });
    new BasemapControl().addTo(map);

    map.createPane("districtPane");
    map.getPane("districtPane").style.zIndex = 350;

    districtsLayerGroup = L.layerGroup().addTo(map);
    routeLayerGroup = L.layerGroup().addTo(map);
    camerasLayerGroup = L.layerGroup().addTo(map);
    campsGatesLayerGroup = L.layerGroup().addTo(map);
    makafPathsLayerGroup = L.layerGroup().addTo(map);
    renderCameras();
    renderCampsGates();
    renderMakafPaths();
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
    const transports = [...new Set([
        ...TRANSPORT_TYPE_MENU_OPTIONS,
        ...rawData.map(d => d['transport_type_name']).filter(Boolean)
    ])];
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
    syncPlanTypeSelectValue();

    populateTopNavDropdowns();
}

function populateTopNavDropdowns() {
    if (!companyDD) return;
    const companyOpts = serviceCompaniesCatalog
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, 'ar'))
        .map(c => ({ value: c.key, label: c.name }));
    companyDD.setOptions(companyOpts);
    companyDD.setValue(selectedServiceCompanies.size === 1 ? Array.from(selectedServiceCompanies)[0] : '');
    populateCenterDropdown();
}

function populateCenterDropdown() {
    if (!centerDD) return;
    const selectedCompanyKey = companyDD ? companyDD.getValue() : '';
    const rows = buildServiceCenterRows(rawData);
    const filtered = selectedCompanyKey
        ? rows.filter(r => r.companyKey && r.companyKey.startsWith(selectedCompanyKey))
        : rows;
    const centerOpts = filtered
        .sort((a, b) => String(a.centerNumber || '').localeCompare(String(b.centerNumber || ''), 'ar'))
        .map(r => ({ value: r.centerKey, label: (r.centerNumber ? r.centerNumber + ' - ' : '') + r.label }));
    centerDD.setOptions(centerOpts);
    centerDD.setValue(selectedServiceCenters.size === 1 ? Array.from(selectedServiceCenters)[0] : '');
    populateCampDropdown();
}

function populateCampDropdown() {
    if (!campDD) return;
    const companyKey = companyDD ? companyDD.getValue() : '';
    const centerKey = centerDD ? centerDD.getValue() : '';
    const baseRows = rawData.filter(d => {
        if (companyKey && !matchesCompanyOwnerFilters(d['owner_company_name'], d['owner_office_number'],
            new Set([companyKey]), new Set())) return false;
        if (centerKey && !matchesCompanyOwnerFilters(d['owner_company_name'], d['owner_office_number'],
            new Set(), new Set([centerKey]))) return false;
        return true;
    });
    const campOpts = [...new Set(baseRows.map(d => (d['camp_label'] || '').trim()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'ar'))
        .map(c => ({ value: c, label: c }));
    campDD.setOptions(campOpts);
    campDD.setValue(selectedCampLabel && campOpts.find(o => o.value === selectedCampLabel) ? selectedCampLabel : '');
    if (!campDD.getValue()) selectedCampLabel = '';
}

function buildSearchableDropdown(inputId, listId, hiddenSelectId, onSelect, clearBtnId) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    if (!input || !list) return null;

    let opts = [];
    let selectedValue = '';

    function setClearBtnVisible(visible) {
        const btn = clearBtnId ? document.getElementById(clearBtnId) : null;
        if (btn) btn.hidden = !visible;
    }

    function renderList() {
        const q = input.value.toLowerCase();
        const selOpt = opts.find(o => o.value === selectedValue);
        const isDisplayingLabel = selOpt && input.value === selOpt.label;
        const filtered = (!input.value || isDisplayingLabel)
            ? opts
            : opts.filter(o => o.label.toLowerCase().includes(q));
        list.innerHTML = '';
        if (!filtered.length) {
            const li = document.createElement('li');
            li.className = 'sidebar-dropdown-empty';
            li.textContent = 'لا توجد نتائج';
            list.appendChild(li);
            return;
        }
        filtered.forEach(o => {
            const li = document.createElement('li');
            li.className = 'sidebar-dropdown-item' + (o.value === selectedValue ? ' active' : '');
            li.textContent = o.label;
            li.addEventListener('mousedown', e => { e.preventDefault(); pick(o.value, o.label); });
            list.appendChild(li);
        });
    }

    function pick(value, label) {
        selectedValue = value;
        input.value = label;
        list.hidden = true;
        setClearBtnVisible(!!value);
        const hs = document.getElementById(hiddenSelectId);
        if (hs) hs.value = value;
        onSelect(value);
        updateSidebarClearBtn();
    }

    input.addEventListener('focus', () => {
        if (selectedValue) input.value = '';
        renderList();
        list.hidden = false;
    });
    input.addEventListener('click', () => {
        if (list.hidden) {
            if (selectedValue) input.value = '';
            renderList();
            list.hidden = false;
        }
    });
    input.addEventListener('input', () => { renderList(); list.hidden = false; });
    input.addEventListener('blur', () => {
        list.hidden = true;
        const sel = opts.find(o => o.value === selectedValue);
        input.value = sel ? sel.label : '';
    });
    input.addEventListener('keydown', e => {
        if (e.key === 'Escape') { list.hidden = true; input.blur(); }
    });

    return {
        setOptions(newOpts) {
            opts = newOpts;
            const hs = document.getElementById(hiddenSelectId);
            if (hs) {
                hs.innerHTML = '<option value=""></option>';
                opts.forEach(o => {
                    const opt = document.createElement('option');
                    opt.value = o.value; opt.textContent = o.label;
                    hs.appendChild(opt);
                });
            }
            if (selectedValue && !opts.find(o => o.value === selectedValue)) {
                selectedValue = ''; input.value = '';
            } else {
                const sel = opts.find(o => o.value === selectedValue);
                input.value = sel ? sel.label : '';
            }
        },
        setValue(value) {
            selectedValue = value;
            const sel = opts.find(o => o.value === value);
            input.value = sel ? sel.label : '';
            setClearBtnVisible(!!value);
            const hs = document.getElementById(hiddenSelectId);
            if (hs) hs.value = value;
        },
        getValue() { return selectedValue; },
        clear() {
            selectedValue = ''; input.value = '';
            setClearBtnVisible(false);
            const hs = document.getElementById(hiddenSelectId);
            if (hs) hs.value = '';
        }
    };
}

function updateSidebarClearBtn() {
    const btn = document.getElementById('sidebarClearFiltersBtn');
    if (!btn) return;
    const active = (companyDD && companyDD.getValue()) ||
                   (centerDD && centerDD.getValue()) ||
                   selectedCampLabel;
    btn.hidden = !active;
}

function setupTopNavDropdownEvents() {
    companyDD = buildSearchableDropdown('companySearch', 'companyDropdownList', 'companyDropdown', value => {
        selectedServiceCompanies.clear();
        selectedServiceCenters.clear();
        selectedCampLabel = '';
        if (value) selectedServiceCompanies.add(value);
        populateCenterDropdown();
        selectedPlanId = null;
        applyFilters();
    }, 'companyClearBtn');

    centerDD = buildSearchableDropdown('centerSearch', 'centerDropdownList', 'centerDropdown', value => {
        selectedServiceCenters.clear();
        selectedCampLabel = '';
        if (value) selectedServiceCenters.add(value);
        populateCampDropdown();
        selectedPlanId = null;
        applyFilters();
    }, 'centerClearBtn');

    campDD = buildSearchableDropdown('campSearch', 'campDropdownList', 'campDropdown', value => {
        selectedCampLabel = value;
        selectedPlanId = null;
        applyFilters();
    }, 'campClearBtn');

    document.getElementById('companyClearBtn')?.addEventListener('click', () => {
        companyDD.clear();
        selectedServiceCompanies.clear();
        selectedServiceCenters.clear();
        selectedCampLabel = '';
        populateCenterDropdown();
        selectedPlanId = null;
        applyFilters();
        updateSidebarClearBtn();
    });

    document.getElementById('centerClearBtn')?.addEventListener('click', () => {
        centerDD.clear();
        selectedServiceCenters.clear();
        selectedCampLabel = '';
        populateCampDropdown();
        selectedPlanId = null;
        applyFilters();
        updateSidebarClearBtn();
    });

    document.getElementById('campClearBtn')?.addEventListener('click', () => {
        campDD.clear();
        selectedCampLabel = '';
        selectedPlanId = null;
        applyFilters();
        updateSidebarClearBtn();
    });

    const sidebarClearBtn = document.getElementById('sidebarClearFiltersBtn');
    if (sidebarClearBtn) sidebarClearBtn.addEventListener('click', clearAllFilters);
}

function syncPlanTypeSelectValue() {
    const select = document.getElementById('planTypeFilter');
    if (!select) return;
    // Update value without triggering change event
    const newValue = selectedPlanTypes.size === 1 ? Array.from(selectedPlanTypes)[0] : 'all';
    if (select.value !== newValue) {
        select.value = newValue;
    }
}

function getActivePlanTypeLabels() {
    return selectedPlanTypes;
}

function getAvailablePlanTypeLabelsForCurrentContext() {
    const sourceRows = planTypeBaseData.length || hasActiveMapFilter() || hasServiceEntitySelection()
        ? planTypeBaseData
        : rawData;
    const labelsByName = new Map();

    sourceRows.forEach(row => {
        const label = String(row['plan_type_name'] || '').trim();
        if (label && !labelsByName.has(label)) labelsByName.set(label, row);
    });

    selectedPlanTypes.forEach(label => {
        if (label && !labelsByName.has(label)) {
            labelsByName.set(label, { plan_type_name: label, plan_type_code: normalizePlanTypeCode(label) });
        }
    });

    return Array.from(labelsByName.keys()).sort((a, b) => {
        const rowA = labelsByName.get(a) || { label: a };
        const rowB = labelsByName.get(b) || { label: b };
        const orderDiff = getPlanTypeRingOrderIndex(rowA) - getPlanTypeRingOrderIndex(rowB);
        return orderDiff || String(a).localeCompare(String(b), 'ar');
    });
}

function applyPlanTypeChartSelection(planTypeLabel) {
    if (!planTypeLabel) return;

    const wasSelected = selectedPlanTypes.size === 1 && selectedPlanTypes.has(planTypeLabel);
    selectedPlanTypes.clear();
    if (!wasSelected) selectedPlanTypes.add(planTypeLabel);

    syncPlanTypeSelectValue();
    selectedPlanId = null;
    selectedEntranceName = null;
    selectedPathName = null;
    selectedDistrict = null;
    applyFilters();
}

// Event Listeners for Filters
function setupMobileMenu() {
    const menuBtn = document.getElementById('mobileMenuBtn');
    const backdrop = document.getElementById('mobileSidebarBackdrop');
    const closeSidebar = () => document.body.classList.remove('mobile-sidebar-open');
    menuBtn?.addEventListener('click', () => document.body.classList.toggle('mobile-sidebar-open'));
    backdrop?.addEventListener('click', closeSidebar);
    document.querySelector('.sidebar')?.addEventListener('click', e => {
        if (e.target.closest('.panel-collapse-toggle')) closeSidebar();
    });
}

function setupEventListeners() {
    setupMobileMenu();
    setupTopNavDropdownEvents();
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
                // Skip - plan type selection is handled by the segmented filter bar
                return;
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

    document.querySelectorAll('.chart-metric-tab').forEach(button => {
        button.addEventListener('click', () => {
            const metric = button.dataset.chartMetric;
            const target = button.dataset.chartTarget;
            if (!CHART_METRIC_DEFS[metric] || !selectedChartMetrics[target] || selectedChartMetrics[target] === metric) return;
            selectedChartMetrics[target] = metric;
            syncChartMetricTabs();
            updateCharts();
        });
    });
    syncChartMetricTabs();

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
            applyFilters();
        });
    }


    const topNavActions = document.querySelector('.top-nav-actions');
    if (topNavActions) {
        // Anything tagged .dashboard-tool below belongs to the analytics
        // dashboard and is hidden in edit mode (see styles.css).
        // Toolbar buttons are positioned relative to the theme toggle. Captured by
        // id and captured once, because the buttons inserted below also carry the
        // .theme-toggle-btn class and would otherwise shadow it.
        const toolbarAnchor = topNavActions.querySelector('#themeToggleBtn') || topNavActions.lastElementChild;
        // Add clear filters button
        const clearFiltersBtn = document.createElement('button');
        clearFiltersBtn.id = 'clearFiltersBtn';
        clearFiltersBtn.className = 'theme-toggle-btn dashboard-tool';
        clearFiltersBtn.type = 'button';
        clearFiltersBtn.title = 'مسح جميع الفلاتر';
        clearFiltersBtn.setAttribute('aria-label', 'مسح الفلاتر');
        clearFiltersBtn.innerHTML = '<i class="fa-solid fa-filter-circle-xmark"></i>';
        clearFiltersBtn.style.marginRight = '4px';
        clearFiltersBtn.addEventListener('click', clearAllFilters);
        toolbarAnchor.parentNode.insertBefore(clearFiltersBtn, toolbarAnchor);

        // Add camera stats export button
        const cameraExportBtn = document.createElement('button');
        cameraExportBtn.id = 'cameraExportBtn';
        cameraExportBtn.className = 'theme-toggle-btn dashboard-tool';
        cameraExportBtn.type = 'button';
        cameraExportBtn.title = 'تصدير إحصائيات الكاميرات CSV';
        cameraExportBtn.setAttribute('aria-label', 'تصدير إحصائيات الكاميرات');
        cameraExportBtn.innerHTML = '<i class="fa-solid fa-file-csv"></i>';
        cameraExportBtn.style.marginRight = '4px';
        cameraExportBtn.addEventListener('click', exportCameraStatsToCSV);
        toolbarAnchor.parentNode.insertBefore(cameraExportBtn, toolbarAnchor);

        // Add Cameras toggle button
        const camerasBtn = document.createElement('button');
        camerasBtn.id = 'camerasToggleBtn';
        camerasBtn.className = 'theme-toggle-btn dashboard-tool';
        camerasBtn.type = 'button';
        camerasBtn.title = 'تبديل عرض الكاميرات';
        camerasBtn.setAttribute('aria-label', 'تبديل الكاميرات');
        camerasBtn.innerHTML = '<i class="fa-solid fa-video"></i>';
        camerasBtn.style.marginRight = '4px';
        camerasBtn.style.opacity = '1';
        camerasBtn.addEventListener('click', toggleCameras);
        // Insert before export button (so order is: ... | camera-toggle | export | csv)
        toolbarAnchor.parentNode.insertBefore(camerasBtn, cameraExportBtn);

        const exitPathsBtn = document.createElement('button');
        exitPathsBtn.id = 'exitPathsToggleBtn';
        exitPathsBtn.className = 'theme-toggle-btn active dashboard-tool';
        exitPathsBtn.type = 'button';
        exitPathsBtn.title = 'تبديل عرض مسارات الخروج';
        exitPathsBtn.setAttribute('aria-label', 'تبديل مسارات الخروج');
        exitPathsBtn.innerHTML = '<i class="fa-solid fa-route"></i>';
        exitPathsBtn.style.marginRight = '4px';
        exitPathsBtn.style.opacity = showTarwiaExitPaths ? '1' : '0.4';
        exitPathsBtn.addEventListener('click', toggleTarwiaExitPaths);
        toolbarAnchor.parentNode.insertBefore(exitPathsBtn, camerasBtn);

        console.log('Cameras toggle button added');
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

    // Event delegation for table rows (performance optimization)
    document.getElementById('serviceCompaniesTableBody')?.addEventListener('click', handleTableRowClick);
    document.getElementById('serviceCompaniesTableBody')?.addEventListener('keydown', handleTableRowKeydown);
    document.getElementById('serviceCentersTableBody')?.addEventListener('click', handleTableRowClick);
    document.getElementById('serviceCentersTableBody')?.addEventListener('keydown', handleTableRowKeydown);

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

        if (selectedCampLabel && (d['camp_label'] || '').trim() !== selectedCampLabel) return false;

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

function handleTableRowClick(event) {
    const row = event.target.closest('tr.entity-table-row');
    if (!row || !row.dataset.itemData) return;
    try {
        const item = JSON.parse(row.dataset.itemData);
        const type = row.dataset.tableType;
        handleTableSelection({ ...item, type });
    } catch (e) {
        console.error('Failed to parse row data:', e);
    }
}

function handleTableRowKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('tr.entity-table-row');
    if (!row || !row.dataset.itemData) return;
    event.preventDefault();
    try {
        const item = JSON.parse(row.dataset.itemData);
        const type = row.dataset.tableType;
        handleTableSelection({ ...item, type });
    } catch (e) {
        console.error('Failed to parse row data:', e);
    }
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
        row.dataset.itemData = JSON.stringify(item);
        row.dataset.tableType = type;
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
    const [companyKeyValue, centerNumber] = key.split('|');
    const companyName = serviceCompanyNameByKey.get(companyKeyValue) || '';
    const centerName = serviceCenterNamesByKey.get(key)
        || centerNumber
        || 'بدون مركز';
    return !selectedServiceCompanies.size && companyName
        ? `${companyName} - ${centerName}`
        : centerName;
}

function getFilteredPlanGeometries() {
    // Create a cache key based on filtered data size and first/last plan
    const cacheKey = filteredData.length > 0
        ? `${filteredData.length}|${filteredData[0]['plan_id']}|${filteredData[filteredData.length - 1]['plan_id']}`
        : '0';

    // Return cached geometries if key matches
    if (cachedFilteredGeometriesKey === cacheKey && cachedFilteredGeometries !== null) {
        return cachedFilteredGeometries;
    }

    const geometries = [];

    filteredData.forEach(plan => {
        const geojsons = getRowGeojsons(plan);
        geojsons.forEach(item => {
            if (item.geojson && item.geojson.coordinates) {
                try {
                    const feature = turf.feature(item.geojson);
                    const buffered = turf.buffer(feature, CAMERA_PLAN_BUFFER_KM, { units: 'kilometers' });
                    geometries.push(buffered.geometry);
                } catch (e) {
                    console.warn('Error buffering geometry:', e);
                }
            }
        });
    });

    // Cache the result
    cachedFilteredGeometries = geometries;
    cachedFilteredGeometriesKey = cacheKey;

    return geometries;
}

function cameraIntersectsGeometries(camera, geometries) {
    if (!geometries || geometries.length === 0) return false;

    const point = turf.point([camera.longitude, camera.latitude]);

    for (const geom of geometries) {
        try {
            // Check if point is within the buffered geometry
            if (turf.booleanPointInPolygon(point, geom)) {
                return true;
            }
        } catch (e) {
            // If geometry is not a polygon, try distance-based check
            try {
                const distance = turf.distance(point, geom, { units: 'kilometers' });
                if (distance <= CAMERA_PLAN_BUFFER_KM) {
                    return true;
                }
            } catch (e2) {
                // Skip this geometry
            }
        }
    }

    return false;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

const CAMERA_TOKEN_LABELS = {
    ARF: 'عرفات',
    MNA: 'منى',
    MZD: 'مزدلفة',
    MKZ: 'مكة',
    UNIV: 'الجامعة',
    BRG: 'جسر',
    RD26: 'طريق 26',
    MDRING: 'الدائري الأوسط',
    TNL: 'نفق',
    PRK: 'مواقف',
    PKG: 'مواقف',
    BASIN: 'حوض',
    WBR: 'جسر وادي عرنة',
    DQM: 'الدقم',
    SUP: 'دعم',
    GEN: 'عام',
    SEC: 'الأمن'
};

function decodeCameraToken(token) {
    const normalized = String(token || '').trim().toUpperCase();
    return CAMERA_TOKEN_LABELS[normalized] || token;
}

function getCameraDirectionLabel(tokens, camera = null) {
    const sourceDirection = String(camera?.direction || camera?.['الإتجاه'] || '').trim();
    if (sourceDirection) return sourceDirection;

    const hasEntry = tokens.includes('ENT') || tokens.includes('IN');
    const hasExit = tokens.includes('EXT') || tokens.includes('OUT');
    if (hasEntry && hasExit) return 'دخول وخروج';
    if (hasEntry) return 'دخول';
    if (hasExit) return 'خروج';
    return 'غير محدد';
}

function getCameraTypeLabel(tokens, camera = null) {
    const sourceType = String(camera?.type || camera?.['النوع'] || '').trim();
    if (sourceType) return sourceType;

    if (tokens.includes('TRN')) return 'قطار';
    if (tokens.includes('MSH')) return 'مشاة';
    if (tokens.includes('PRK') || tokens.includes('PKG')) return 'مواقف';
    if (tokens.includes('TNL')) return 'نفق';
    if (tokens.includes('SUP')) return 'مساندة';
    return 'كاميرا مراقبة';
}

function getCameraLocationLabel(camera) {
    const sourceLocation = String(camera?.location || camera?.['الموقع'] || camera?.shortName || '').trim();
    if (sourceLocation) return sourceLocation;

    const tokens = String(camera.name || '').split('_').filter(Boolean);
    const primaryZone = tokens.find(token => ['ARF', 'MNA', 'MZD', 'MKZ'].includes(token));
    const descriptorTokens = tokens.filter(token => ![
        'ENT', 'EXT', 'IN', 'OUT', 'MSH', 'TRN', 'SUP'
    ].includes(token) && !/^\d+$/.test(token));

    const labels = descriptorTokens.map(decodeCameraToken).filter(Boolean);
    const uniqueLabels = Array.from(new Set(labels));
    if (uniqueLabels.length) return uniqueLabels.join(' - ');
    return primaryZone ? decodeCameraToken(primaryZone) : 'غير محدد';
}

function getCameraDetails(camera) {
    const tokens = String(camera.name || '').split('_').filter(Boolean);

    return {
        name: camera.name || 'غير محدد',
        location: getCameraLocationLabel(camera),
        direction: getCameraDirectionLabel(tokens, camera),
        type: getCameraTypeLabel(tokens, camera),
        latitude: Number(camera.latitude),
        longitude: Number(camera.longitude),
        altitude: Number(camera.altitude)
    };
}

function buildCameraDetailsHtml(camera) {
    const details = getCameraDetails(camera);

    return `
        <div style="font-size:14px;font-weight:bold;margin-bottom:6px;">📷 ${escapeHtml(details.name)}</div>
        <div style="display:grid;grid-template-columns:auto 1fr;gap:5px 10px;font-size:12px;line-height:1.45;">
            <span style="opacity:0.65;">الموقع</span><strong>${escapeHtml(details.location)}</strong>
            <span style="opacity:0.65;">الاتجاه</span><strong>${escapeHtml(details.direction)}</strong>
            <span style="opacity:0.65;">النوع</span><strong>${escapeHtml(details.type)}</strong>
        </div>`;
}

// [lng, lat] zone centers used to determine path direction relative to each zone
const HAJJ_ZONE_CENTERS = [
    { prefix: 'ARF', coords: [39.9848, 21.3546] },
    { prefix: 'MNA', coords: [39.8903, 21.4122] },
    { prefix: 'MZD', coords: [39.9362, 21.3863] },
    { prefix: 'MKZ', coords: [39.8262, 21.4225] },
];

function getCameraZoneCenter(camera) {
    const prefix = camera.name.split('_')[0];
    const match = HAJJ_ZONE_CENTERS.find(z => z.prefix === prefix);
    if (match) return match.coords;
    // Fallback: nearest zone by distance
    const cam = turf.point([camera.longitude, camera.latitude]);
    let nearest = HAJJ_ZONE_CENTERS[0];
    let minDist = Infinity;
    for (const z of HAJJ_ZONE_CENTERS) {
        const d = turf.distance(cam, turf.point(z.coords), { units: 'kilometers' });
        if (d < minDist) { minDist = d; nearest = z; }
    }
    return nearest.coords;
}

// Returns 'entry', 'exit', or 'unknown' based on path bearing at camera vs zone center bearing
function getPlanDirectionAtCamera(plan, camera) {
    const geojsons = getRowGeojsons(plan);
    const camPoint = turf.point([camera.longitude, camera.latitude]);
    const zoneCoords = getCameraZoneCenter(camera);
    const bearingToZone = turf.bearing(camPoint, turf.point(zoneCoords));

    for (const item of geojsons) {
        if (!item.geojson || item.geojson.type !== 'LineString') continue;
        const coords = item.geojson.coordinates;
        if (coords.length < 2) continue;
        try {
            const line = turf.lineString(coords);
            const nearest = turf.nearestPointOnLine(line, camPoint, { units: 'kilometers' });
            const idx = Math.min(nearest.properties.index ?? 0, coords.length - 2);
            const pathBearing = turf.bearing(turf.point(coords[idx]), turf.point(coords[idx + 1]));
            let diff = Math.abs(pathBearing - bearingToZone);
            if (diff > 180) diff = 360 - diff;
            return diff <= 90 ? 'entry' : 'exit';
        } catch (e) {}
    }
    return 'unknown';
}

function getCameraFilterKey() {
    if (!filteredData || filteredData.length === 0) return '0';
    const cameraSignature = typeof CAMERAS_DATA !== 'undefined' && CAMERAS_DATA.length
        ? `${CAMERAS_DATA.length}|${CAMERAS_DATA[0]?.name || ''}|${CAMERAS_DATA[CAMERAS_DATA.length - 1]?.name || ''}`
        : 'no-cameras';
    return `${filteredData.length}|${filteredData[0]['plan_id']}|${filteredData[filteredData.length - 1]['plan_id']}|${cameraSignature}`;
}

function updateCameraExportBtnState() {
    const btn = document.getElementById('cameraExportBtn');
    if (!btn) return;
    if (cameraCacheBuilding) {
        btn.disabled = true;
        btn.title = 'جارٍ تحميل الإحصائيات...';
        btn.style.opacity = '0.4';
    } else {
        btn.disabled = false;
        btn.title = 'تصدير إحصائيات الكاميرات CSV';
        btn.style.opacity = showCameras ? '1' : '0.4';
    }
}

function buildCameraPlanCacheAsync() {
    const newKey = getCameraFilterKey();
    if (cameraCacheKey === newKey) return;

    cameraCacheKey = newKey;
    cameraPlanCache = new Map();
    cameraCacheBuilding = true;
    updateCameraExportBtnState();

    if (typeof CAMERAS_DATA === 'undefined' || filteredData.length === 0) {
        cameraCacheBuilding = false;
        updateCameraExportBtnState();
        return;
    }

    const cameraPoints = CAMERAS_DATA.map(cam => ({
        cam,
        point: turf.point([cam.longitude, cam.latitude])
    }));

    let planIdx = 0;
    const CHUNK = 8;

    function processChunk() {
        if (cameraCacheKey !== newKey) return;

        const end = Math.min(planIdx + CHUNK, filteredData.length);
        for (let i = planIdx; i < end; i++) {
            const plan = filteredData[i];
            const geojsons = getRowGeojsons(plan);
            const buses = Number(plan.number_of_buses) || 0;
            const trips = getTripCount(plan, buses);
            const typeLabel = plan.plan_type_name || plan.plan_type_code || 'غير محدد';
            const transport = plan.transport_type_name || 'غير محدد';
            const company = plan.service_company_name || plan.owner_company_name || 'غير محدد';
            const center = plan.owner_office_number || 'غير محدد';
            const byKeyLabel = typeLabel + '|||' + transport + '|||' + company + '|||' + center;

            const buffers = [];
            for (const item of geojsons) {
                if (!item.geojson || !item.geojson.coordinates) continue;
                try {
                    const feature = turf.feature(item.geojson);
                    buffers.push({ buffered: true, geom: turf.buffer(feature, CAMERA_PLAN_BUFFER_KM, { units: 'kilometers' }) });
                } catch (_) {
                    try { buffers.push({ buffered: false, geom: turf.feature(item.geojson) }); } catch (__) {}
                }
            }
            if (buffers.length === 0) continue;

            for (const { cam, point } of cameraPoints) {
                let intersects = false;
                for (const b of buffers) {
                    try {
                        if (b.buffered) {
                            if (turf.booleanPointInPolygon(point, b.geom)) { intersects = true; break; }
                        } else {
                            if (turf.distance(point, b.geom, { units: 'kilometers' }) <= CAMERA_PLAN_BUFFER_KM) { intersects = true; break; }
                        }
                    } catch (_) {}
                }
                if (intersects) {
                    if (!cameraPlanCache.has(cam.name)) {
                        cameraPlanCache.set(cam.name, { totalBuses: 0, totalTrips: 0, byKey: {} });
                    }
                    const entry = cameraPlanCache.get(cam.name);
                    entry.totalBuses += buses;
                    entry.totalTrips += trips;
                    if (!entry.byKey[byKeyLabel]) {
                        entry.byKey[byKeyLabel] = { typeLabel, transport, company, center, buses: 0, trips: 0 };
                    }
                    entry.byKey[byKeyLabel].buses += buses;
                    entry.byKey[byKeyLabel].trips += trips;
                }
            }
        }
        planIdx = end;

        if (planIdx >= filteredData.length) {
            cameraCacheBuilding = false;
            updateCameraExportBtnState();
            return;
        }
        setTimeout(processChunk, 0);
    }

    setTimeout(processChunk, 0);
}

function exportCameraStatsToCSV() {
    if (cameraCacheBuilding) {
        alert('جارٍ تحميل الإحصائيات، يرجى الانتظار لحظة ثم حاول مجدداً');
        return;
    }
    if (cameraPlanCache.size === 0) {
        alert('لا توجد كاميرات مرئية حالياً لتصديرها');
        return;
    }

    const rows = [];
    for (const [cameraName, stats] of cameraPlanCache) {
        for (const s of Object.values(stats.byKey)) {
            rows.push([cameraName, s.typeLabel, s.transport, s.company, s.center, s.buses, s.trips]);
        }
    }

    if (rows.length === 0) { alert('لم يتم العثور على بيانات للتصدير'); return; }

    const headers = ['اسم الكاميرا', 'نوع الخطة', 'نمط النقل', 'الشركة', 'المركز', 'عدد الحافلات', 'عدد الرحلات'];
    const csvContent = [headers, ...rows]
        .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
        .join('\r\n');
    const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
    a.href = url; a.download = `احصائيات_الكاميرات_${ts}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function clearAllFilters() {
    ['periodFilter', 'transportFilter', 'districtFilter'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = 'all';
    });
    companyDD?.clear();
    centerDD?.clear();
    campDD?.clear();
    const searchInput = document.querySelector('.search-bar input');
    if (searchInput) searchInput.value = '';
    selectedPlanId = null;
    selectedEntranceName = null;
    selectedPathName = null;
    selectedDistrict = null;
    selectedResidenceMixFilter = 'all';
    selectedPlanTypes.clear();
    selectedServiceCompanies.clear();
    selectedServiceCenters.clear();
    selectedCampLabel = '';
    populateCenterDropdown();
    populateCampDropdown();
    updateSidebarClearBtn();
    applyFilters();
}

function getPlansForCamera(camera) {
    if (!filteredData || filteredData.length === 0) return [];

    const point = turf.point([camera.longitude, camera.latitude]);
    const matchingPlans = [];

    for (const plan of filteredData) {
        const geojsons = getRowGeojsons(plan);
        let intersects = false;

        for (const item of geojsons) {
            if (!item.geojson || !item.geojson.coordinates) continue;
            try {
                const feature = turf.feature(item.geojson);
                const buffered = turf.buffer(feature, CAMERA_PLAN_BUFFER_KM, { units: 'kilometers' });
                if (turf.booleanPointInPolygon(point, buffered)) {
                    intersects = true;
                    break;
                }
            } catch (e) {
                try {
                    const dist = turf.distance(point, turf.feature(item.geojson), { units: 'kilometers' });
                    if (dist <= CAMERA_PLAN_BUFFER_KM) { intersects = true; break; }
                } catch (e2) {}
            }
        }

        if (intersects) matchingPlans.push(plan);
    }

    return matchingPlans;
}

function renderCameras() {
    if (!camerasLayerGroup) return;

    camerasLayerGroup.clearLayers();

    if (isEntityWorkspaceActive()) return;
    if (!showCameras || typeof CAMERAS_DATA === 'undefined') return;

    // Get geometries from filtered plans (if any plans are displayed)
    const planGeometries = filteredData.length > 0 ? getFilteredPlanGeometries() : null;

    CAMERAS_DATA.forEach(camera => {
        // If there are filtered plans, only show cameras that intersect with them
        if (planGeometries && planGeometries.length > 0) {
            if (!cameraIntersectsGeometries(camera, planGeometries)) {
                return; // Skip this camera
            }
        }

        const marker = L.marker([camera.latitude, camera.longitude], {
            icon: L.divIcon({
                className: 'camera-marker',
                html: '<i class="fa-solid fa-video" style="color: #22c55e; font-size: 18px; text-shadow: 0 0 3px #000;"></i>',
                iconSize: [24, 24],
                iconAnchor: [12, 12],
                popupAnchor: [0, -12]
            })
        });

        const cameraDetailsHtml = buildCameraDetailsHtml(camera);
        marker.bindTooltip(cameraDetailsHtml, {
            direction: 'top',
            sticky: true,
            opacity: 0.96,
            className: 'camera-detail-tooltip'
        });
        marker.bindPopup(
            `<div dir="rtl" style="font-family:inherit;min-width:240px;padding:4px;">
                ${cameraDetailsHtml}
                <hr style="margin:6px 0;border:none;border-top:1px solid rgba(128,128,128,0.25);">
                <small style="color:#888;">جارٍ تحميل البيانات...</small>
            </div>`
        );

        marker.on('popupopen', function () {
            const popup = this.getPopup();
            const SEP = `<hr style="margin:6px 0;border:none;border-top:1px solid rgba(128,128,128,0.25);">`;

            if (cameraCacheBuilding) {
                popup.setContent(
                    `<div dir="rtl" style="font-family:inherit;min-width:220px;padding:4px;">
                        ${cameraDetailsHtml}
                        ${SEP}
                        <div style="font-size:12px;opacity:0.6;">جارٍ تحميل الإحصائيات...</div>
                    </div>`
                );
                popup.update();
                return;
            }

            const cached = cameraPlanCache.get(camera.name);
            if (!cached) {
                popup.setContent(
                    `<div dir="rtl" style="font-family:inherit;min-width:220px;padding:4px;">
                        ${cameraDetailsHtml}
                        ${SEP}
                        <div style="font-size:12px;opacity:0.6;">لا توجد رحلات مخططة لهذه الكاميرا</div>
                    </div>`
                );
                popup.update();
                return;
            }

            const { totalBuses, totalTrips, byKey } = cached;
            const typeRows = Object.values(byKey).map(v =>
                `<tr>
                    <td style="padding:4px 8px;border-bottom:1px solid rgba(128,128,128,0.15);font-size:12px;">${v.typeLabel}</td>
                    <td style="padding:4px 8px;border-bottom:1px solid rgba(128,128,128,0.15);font-size:12px;">${v.transport}</td>
                    <td style="padding:4px 8px;border-bottom:1px solid rgba(128,128,128,0.15);text-align:center;font-size:12px;">${v.buses.toLocaleString()}</td>
                    <td style="padding:4px 8px;border-bottom:1px solid rgba(128,128,128,0.15);text-align:center;font-size:12px;font-weight:bold;">${v.trips.toLocaleString()}</td>
                </tr>`
            ).join('');

            const exportBtnId = 'camExportBtn_' + camera.name.replace(/\W/g, '_');
            popup.setContent(
                `<div dir="rtl" style="font-family:inherit;min-width:260px;padding:4px;font-size:13px;">
                    ${cameraDetailsHtml}
                    ${SEP}
                    <div style="display:flex;justify-content:space-around;padding:8px 0;">
                        <div style="text-align:center;">
                            <div style="font-size:24px;font-weight:bold;color:#3b82f6;">${totalBuses.toLocaleString()}</div>
                            <div style="font-size:11px;opacity:0.65;margin-top:2px;">الحافلات</div>
                        </div>
                        <div style="text-align:center;">
                            <div style="font-size:24px;font-weight:bold;color:#8b5cf6;">${totalTrips.toLocaleString()}</div>
                            <div style="font-size:11px;opacity:0.65;margin-top:2px;">الرحلات</div>
                        </div>
                    </div>
                    ${SEP}
                    <div style="display:flex;justify-content:flex-end;padding-top:2px;">
                        <button id="${exportBtnId}" style="display:flex;align-items:center;gap:6px;padding:6px 14px;border-radius:7px;border:1px solid rgba(128,128,128,0.4);background:transparent;color:inherit;cursor:pointer;font-size:12px;">
                            <i class="fa-solid fa-file-csv"></i> تصدير CSV
                        </button>
                    </div>
                </div>`
            );
            popup.update();

            requestAnimationFrame(() => {
                const btn = document.getElementById(exportBtnId);
                if (!btn) return;
                btn.addEventListener('click', () => {
                    const rows = Object.values(byKey).map(v =>
                        [camera.name, v.typeLabel, v.transport, v.company, v.center, v.buses, v.trips]
                    );
                    const headers = ['اسم الكاميرا', 'نوع الخطة', 'نمط النقل', 'الشركة', 'المركز', 'عدد الحافلات', 'عدد الرحلات'];
                    const csvContent = [headers, ...rows]
                        .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
                        .join('\r\n');
                    const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    const now = new Date();
                    const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
                    a.href = url; a.download = `كاميرا_${camera.name}_${ts}.csv`; a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 10000);
                });
            });
        });

        marker.addTo(camerasLayerGroup);
    });
}

const debouncedRenderCameras = debounce(renderCameras, 300);

function renderCampsGates() {
    if (!campsGatesLayerGroup) return;
    campsGatesLayerGroup.clearLayers();
    if (isEntityWorkspaceActive()) return;
    if (!showCampsGates || typeof CAMPS_GATES_DATA === 'undefined') return;

    const planGeometries = filteredData.length > 0 ? getFilteredPlanGeometries() : null;

    CAMPS_GATES_DATA.forEach(gate => {
        if (planGeometries && planGeometries.length > 0) {
            const point = turf.point([gate.longitude, gate.latitude]);
            let near = false;
            for (const geom of planGeometries) {
                try {
                    if (turf.booleanPointInPolygon(point, geom)) { near = true; break; }
                } catch (_e) {
                    try {
                        if (turf.distance(point, geom, { units: 'kilometers' }) <= 0.020) { near = true; break; }
                    } catch (_e2) {}
                }
            }
            if (!near) return;
        }

        const isARF = gate.source === 'ARF';
        const color = isARF ? '#f97316' : '#a855f7';
        const marker = L.marker([gate.latitude, gate.longitude], {
            icon: L.divIcon({
                className: 'camp-gate-marker',
                html: `<i class="fa-solid fa-door-open" style="color:${color};font-size:16px;text-shadow:0 0 3px #000;"></i>`,
                iconSize: [20, 20],
                iconAnchor: [10, 10],
                popupAnchor: [0, -10]
            })
        });

        let popupHtml = `<strong style="color:#333;">🚪 مخيم ${gate.camp_label}</strong><br><small>بوابة: ${gate.gate_number}`;
        if (isARF) {
            if (gate.type) popupHtml += `<br>النوع: ${gate.type}`;
            if (gate.transport_mode) popupHtml += `<br>النقل: ${gate.transport_mode}`;
            if (gate.capacity) popupHtml += `<br>الطاقة: ${gate.capacity}`;
        } else {
            if (gate.nationality) popupHtml += `<br>الجنسية: ${gate.nationality}`;
            if (gate.capacity) popupHtml += `<br>الطاقة: ${gate.capacity}`;
            if (gate.piligrim_type) popupHtml += `<br>النوع: ${gate.piligrim_type}`;
        }
        popupHtml += `<br><em style="color:#888;">${isARF ? 'عرفات' : 'منى'}</em></small>`;
        marker.bindPopup(popupHtml);
        marker.addTo(campsGatesLayerGroup);
    });
}

const debouncedRenderCampsGates = debounce(renderCampsGates, 300);

function toggleCampsGates() {
    showCampsGates = !showCampsGates;
    const btn = document.getElementById('campsGatesToggleBtn');
    if (btn) btn.style.opacity = showCampsGates ? '1' : '0.4';
    debouncedRenderCampsGates();
}

function renderMakafPaths() {
    if (!makafPathsLayerGroup) return;
    makafPathsLayerGroup.clearLayers();
    if (isEntityWorkspaceActive()) return;
    if (typeof MAKAF_PATHS_DATA === 'undefined') return;

    // Static fallback only: camps whose direct_taseed plans already carry a
    // routed internal_path from the DB get that drawn by getRowGeojsons(), so
    // drawing the MAKAF line too would show two entrance->camp paths.
    const activeCampLabels = new Set(
        filteredData
            .filter(row => (row['plan_type_code'] || '').trim() === 'direct_taseed' && !row['internal_path'])
            .map(row => (row['camp_label'] || '').trim())
            .filter(Boolean)
    );
    if (activeCampLabels.size === 0) return;

    MAKAF_PATHS_DATA.features.forEach(feature => {
        const props = feature.properties;
        const campLabel = (props.camp_label || '').trim();
        if (!campLabel || !activeCampLabels.has(campLabel)) return;
        if (!feature.geometry) return;

        const color = '#f59e0b';

        const popup = [
            `<strong style="color:#333">\ud83d\ude8c \u0645\u062e\u064a\u0645 ${campLabel}</strong>`,
            props.MAKARF         ? `<small>\u0645\u0633\u0627\u0631 \u0639\u0631\u0641\u0627\u062a: ${props.MAKARF}</small>` : '',
            props.ASMARF         ? `<small>\u0646\u0642\u0637\u0629 \u062f\u062e\u0648\u0644 \u0639\u0631\u0641\u0627\u062a: ${props.ASMARF}</small>` : '',
            props.Transport_mode ? `<small>\u0646\u0648\u0639 \u0627\u0644\u0646\u0642\u0644: ${props.Transport_mode}</small>` : '',
            props._length        ? `<small>\u0627\u0644\u0637\u0648\u0644: ${Math.round(props._length).toLocaleString()} \u0645</small>` : ''
        ].filter(Boolean).join('<br>');

        // Convert GeoJSON coords [lon,lat] → latlngs arrays [[lat,lon],...]
        const geom = feature.geometry;
        const rings = geom.type === 'MultiLineString'
            ? geom.coordinates
            : [geom.coordinates];

        rings.forEach(coords => {
            const latlngs = coords.map(([lon, lat]) => [lat, lon]);
            if (latlngs.length < 2) return;

            // Halo
            L.polyline(latlngs, {
                color: '#ffffff',
                weight: 7,
                opacity: 0.6,
                className: 'route-line'
            }).addTo(makafPathsLayerGroup);

            // Keep the dashed flow animation while omitting separate arrow markers.
            const line = L.polyline(latlngs, {
                color,
                weight: 3,
                opacity: 0.95,
                className: 'route-line'
            });
            line.bindPopup(popup);
            line.addTo(makafPathsLayerGroup);
        });
    });
}

const debouncedRenderMakafPaths = debounce(renderMakafPaths, 300);

function toggleCameras() {
    showCameras = !showCameras;
    const btn = document.getElementById('camerasToggleBtn');
    if (btn) {
        btn.style.opacity = showCameras ? '1' : '0.4';
    }
    debouncedRenderCameras();
}

function toggleTarwiaExitPaths() {
    showTarwiaExitPaths = !showTarwiaExitPaths;
    const btn = document.getElementById('exitPathsToggleBtn');
    if (btn) {
        btn.classList.toggle('active', showTarwiaExitPaths);
        btn.style.opacity = showTarwiaExitPaths ? '1' : '0.4';
    }
    cachedMapRenderKey = null;
    updateMap();
}

function updateMapSelectionTitle() {
    const titleEl = document.getElementById('mapSelectionTitle');
    if (!titleEl) return;

    let text = '';

    // Priority 1: If a trip service center is selected, show it
    if (selectedTripServiceCenter) {
        text = `${selectedTripServiceCenter.company} / ${selectedTripServiceCenter.centerNumber}`;
    }
    // Priority 2: If a specific plan is selected, show plan details
    else if (selectedPlanId) {
        const planRow = rawData.find(r => r['plan_id'] === selectedPlanId);
        if (planRow) {
            const company = String(planRow['owner_company_name'] || '').trim();
            const center = String(planRow['owner_office_number'] || '').trim();
            const camp = String(planRow['camp_label'] || '').trim();
            text = [company, center, camp].filter(Boolean).join(' - ');
        }
    }
    // Priority 3: If no plan selected but service center/company selected, show that
    if (!text) {
        const companyName = getSelectedServiceCompanyName();
        const centerName = getSelectedServiceCenterName();
        text = companyName && centerName
            ? `${companyName} - ${centerName}`
            : (companyName || centerName);
    }

    titleEl.textContent = text;
    titleEl.hidden = !text;
}

// Main Update Function
function getDashboardRenderKey() {
    return [
        filteredData.length,
        filteredData.length ? filteredData[0]['plan_id'] : '',
        filteredData.length ? filteredData[filteredData.length - 1]['plan_id'] : '',
        selectedPlanId, selectedEntranceName, selectedPathName, selectedDistrict,
        Array.from(selectedServiceCompanies).sort().join(','),
        Array.from(selectedServiceCenters).sort().join(','),
        selectedResidenceMixFilter,
        Array.from(selectedPlanTypes).sort().join(',')
    ].join('|');
}

function updateDashboard() {
    const stats = getDashboardStats();
    updateKPIs(stats);
    debouncedRenderCameras();
    buildCameraPlanCacheAsync();
    debouncedRenderCampsGates();
    debouncedRenderMakafPaths();

    const renderKey = getDashboardRenderKey();
    if (renderKey === cachedDashboardRenderKey) return;
    cachedDashboardRenderKey = renderKey;

    updateMap();
    updateMapSelectionTitle();
    updatePlanList();

    clearTimeout(chartUpdateTimerId);
    chartUpdateTimerId = setTimeout(() => {
        updateCharts(stats);
        renderServiceSummaryTables();
    }, 0);
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
            stats.completionByPlanType[completionKey] = { planTypeCode, label: planTypeName, planned: 0, target: 0 };
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
    // Create a cache key based on filtered data (memoization)
    const cacheKey = filteredData.length > 0
        ? `${filteredData.length}|${filteredData[0]['plan_id']}|${filteredData[filteredData.length - 1]['plan_id']}`
        : '0';

    // Return cached stats if key matches
    if (cachedDashboardStatsKey === cacheKey && cachedDashboardStats !== null) {
        return cachedDashboardStats;
    }

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
            stats.completionByPlanType[completionKey] = { planTypeCode, label: planTypeName, planned: 0, target: 0 };
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

    // Cache the result
    cachedDashboardStats = stats;
    cachedDashboardStatsKey = cacheKey;

    return stats;
}

function getTripCount(row, buses) {
    const transportType = (row['transport_type_name'] || '').trim();
    if (transportType === 'تقليدي رد') return buses;
    if (transportType === 'تقليدي ردين') return buses * 2;
    if (transportType === 'ترددي' || transportType === 'قطار') return buses * 3;
    return buses;
}

function getChartMetricValue(row, metric = 'pilgrims') {
    const buses = Number(row['number_of_buses']) || 0;
    if (metric === 'buses') return buses;
    if (metric === 'trips') return getTripCount(row, buses);
    return Number(row['number_of_haj']) || 0;
}

function buildChartMetricStats(metric = 'pilgrims') {
    const metricStats = {
        periodCounts: {},
        entranceCounts: {},
        pathCounts: {},
        districtCounts: {},
        allPeriodsForEntrance: new Set()
    };

    filteredData.forEach(row => {
        const value = getChartMetricValue(row, metric);
        const period = String(row['period'] || 'غير معروف');
        const entrance = row['entrance_name'] || row['entrance_asm_code'] || 'بدون مدخل';
        const path = row['path_name'] || 'بدون مسار';
        const district = row['start_point_district'] || 'بدون حي';

        addToBucket(metricStats.periodCounts, period, value);
        addToBucket(metricStats.pathCounts, path, value);
        addToBucket(metricStats.districtCounts, district, value);

        if (!metricStats.entranceCounts[entrance]) metricStats.entranceCounts[entrance] = {};
        metricStats.entranceCounts[entrance][period] = (metricStats.entranceCounts[entrance][period] || 0) + value;
        metricStats.allPeriodsForEntrance.add(period);
    });

    return metricStats;
}

function syncChartMetricTabs() {
    document.querySelectorAll('.chart-metric-tab').forEach(button => {
        const target = button.dataset.chartTarget;
        const isActive = Boolean(target) && button.dataset.chartMetric === selectedChartMetrics[target];
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
}

function formatAxisLabel(value, maxLineLength = 9) {
    const text = String(value || '').trim();
    if (!text) return '';
    const words = text.split(/\s+/);
    const lines = [];
    let currentLine = '';

    words.forEach(word => {
        const nextLine = currentLine ? `${currentLine} ${word}` : word;
        if (nextLine.length > maxLineLength && currentLine) {
            lines.push(currentLine);
            currentLine = word;
        } else {
            currentLine = nextLine;
        }
    });

    if (currentLine) lines.push(currentLine);
    return lines.slice(0, 2);
}

function truncateAxisLabel(value, maxLength = 28) {
    const text = String(value || '').trim();
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 1) + '…';
}

const angledXAxisLabelsPlugin = {
    id: 'angledXAxisLabels',
    afterDraw(chart, _args, pluginOptions = {}) {
        const xScale = chart.scales?.x;
        const labels = pluginOptions.labels || chart.data?.labels || [];
        if (!xScale || !labels.length) return;

        const ctx = chart.ctx;
        const angle = (pluginOptions.angle ?? -55) * Math.PI / 180;
        const color = pluginOptions.color || '#fafafa';
        const fontSize = pluginOptions.fontSize || 10;
        const maxLength = pluginOptions.maxLength || 28;
        const yOffset = pluginOptions.bottomOffset || 16;
        const y = Math.min(chart.height - 8, chart.chartArea.bottom + yOffset);

        ctx.save();
        ctx.direction = 'rtl';
        ctx.fillStyle = color;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.font = `700 ${fontSize}px 'IBM Plex Sans Arabic', system-ui, sans-serif`;

        labels.forEach((label, index) => {
            const x = xScale.getPixelForTick(index);
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(angle);
            ctx.fillText(truncateAxisLabel(label, maxLength), 0, 0);
            ctx.restore();
        });

        ctx.restore();
    }
};

// A planned/target KPI is really a share: "2,198/4,210" makes the reader do the
// division, so the meter and the percentage carry it and the two numbers stay
// as the detail. Below COVERAGE_LOW the fill turns amber — a gap that large is
// usually unmatched import data, not a plan that is simply still filling up.
const COVERAGE_LOW = 60;

function setKpiRatio(element, planned, target, label, title) {
    if (!element) return;
    const value = Number(planned) || 0;
    const total = Number(target) || 0;
    const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;

    element.textContent = `${value.toLocaleString()}/${total.toLocaleString()}`;
    element.title = title;
    if (element.previousElementSibling) element.previousElementSibling.textContent = label;

    const info = element.parentElement;
    if (!info) return;
    let meter = info.querySelector('.kpi-meter');
    if (!meter) {
        meter = document.createElement('div');
        meter.className = 'kpi-meter';
        meter.innerHTML = '<span class="kpi-meter-track"><span class="kpi-meter-fill"></span></span><span class="kpi-meter-pct"></span>';
        info.appendChild(meter);
    }
    meter.querySelector('.kpi-meter-fill').style.width = `${pct}%`;
    meter.querySelector('.kpi-meter-pct').textContent = total > 0 ? `${pct}%` : '—';
    meter.classList.toggle('low', total > 0 && pct < COVERAGE_LOW);
    meter.setAttribute('role', 'img');
    meter.setAttribute('aria-label', total > 0 ? `${label}: ${pct}%` : label);
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

    // With no phase selected, summing every phase would count each pilgrim once
    // per phase; count them through Tarwiya + direct Taseed instead, which every
    // pilgrim passes through exactly once.
    const plannedPilgrims = getActivePlanTypeLabels().size
        ? totalPilgrims
        : calculateKpiTotalPilgrims(filteredData.filter(isTarwiyaKpiTotalPlanType));

    // Animate numbers
    setKpiRatio(
        document.getElementById('kpiPilgrims'),
        plannedPilgrims, campStats.totalPilgrims,
        'الحجاج (مخطط/مستهدف)',
        'الحجاج المخططون حسب نوع الخطة المحدد / المستهدفون من تخصيصات المخيمات'
    );
    document.getElementById('kpiBuses').textContent = totalBuses.toLocaleString();
    document.getElementById('kpiPlans').textContent = totalPlans.toLocaleString();
    document.getElementById('kpiTrips').textContent = totalTrips.toLocaleString();
    setKpiRatio(
        document.getElementById('kpiServiceCenters'),
        plannedServiceCenters, campStats.serviceCenterCount,
        'مراكز الخدمة (مخطط/إجمالي)',
        'مراكز الخدمة من البيانات المعروضة / إجمالي مراكز الخدمة'
    );

    setKpiRatio(
        document.getElementById('kpiResidences'),
        residenceStats.totalResidences, residenceStats.totalAssigned,
        'عدد المساكن (مخطط/إجمالي)',
        'المساكن من الخطط / إجمالي المساكن المخصصة للشركة'
    );

    setKpiRatio(
        document.getElementById('kpiCamps'),
        totalCamps, getCampCountFromAssignCamps(),
        'مخيمات (مخطط/إجمالي)',
        `${campStats.totalAssignments} تخصيص`
    );

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
function getTransportTypeColor(transportTypeName) {
    const t = String(transportTypeName || '');
    if (t.includes('ترددي'))       return { color: '#f97316', fillColor: '#fed7aa' }; // orange
    if (t.includes('ردين'))         return { color: '#8b5cf6', fillColor: '#ddd6fe' }; // purple
    if (t.includes('رد'))           return { color: '#3b82f6', fillColor: '#bfdbfe' }; // blue
    if (t.includes('قطار'))         return { color: '#f59e0b', fillColor: '#fde68a' }; // amber
    return { color: '#22c55e', fillColor: '#bbf7d0' };                                 // green default
}

function sampleAcrossPlanTypes(data, limit) {
    if (data.length <= limit) return data;
    const byType = {};
    data.forEach(row => {
        const t = row['plan_type_code'] || 'unknown';
        if (!byType[t]) byType[t] = [];
        byType[t].push(row);
    });
    const types = Object.keys(byType);
    const perType = Math.floor(limit / types.length);
    const remainder = limit - perType * types.length;
    const result = [];
    types.forEach((t, i) => {
        result.push(...byType[t].slice(0, perType + (i < remainder ? 1 : 0)));
    });
    return result;
}

function updateMap() {
    // The entity workspace owns the map; it draws the selected records itself.
    if (isEntityWorkspaceActive()) {
        clearDashboardMapLayers();
        renderDistrictReference();
        cachedMapRenderKey = null;
        return;
    }
    const mapKey = [
        filteredData.length,
        filteredData.length ? filteredData[0]['plan_id'] : '',
        filteredData.length ? filteredData[filteredData.length - 1]['plan_id'] : '',
        selectedPlanId, selectedEntranceName, selectedPathName, selectedDistrict,
        showTarwiaExitPaths ? 'exit-paths-on' : 'exit-paths-off',
        Array.from(selectedServiceCompanies).sort().join(','),
        Array.from(selectedServiceCenters).sort().join(',')
    ].join('|');
    if (mapKey === cachedMapRenderKey) return;
    cachedMapRenderKey = mapKey;

    routeLayerGroup.clearLayers();
    districtsLayerGroup.clearLayers();
    const mapStatus = document.getElementById('mapStatus');
    const bounds = L.latLngBounds();
    const serviceEntitySelectionActive = hasServiceEntitySelection();
    const shouldFitFilteredResults = hasActiveMapFilter();
    const mapData = shouldFitFilteredResults ? filteredData : sampleAcrossPlanTypes(filteredData, MAP_RENDER_LIMIT);
    const showDetailedMapLabels = Boolean(selectedPlanId || serviceEntitySelectionActive) || filteredData.length <= MAP_DETAIL_LABEL_LIMIT;

    if (mapStatus) {
        const noMatches = filteredData.length === 0 && rawData.length > 0;
        mapStatus.hidden = !noMatches;
        mapStatus.textContent = noMatches ? 'لا توجد خطط مطابقة للفلاتر الحالية' : '';
    }

    let selectedDistrictBounds = null;

    // Draw Districts - only for residence start-point trips
    if (typeof DISTRICTS_DATA !== 'undefined' && DISTRICTS_DATA.features) {
        const residenceRows = mapData.filter(row => row['start_point_type'] === 'residence');
        if (residenceRows.length > 0) {
            const { stats: districtStats, maxPilgrims } = buildDistrictMapStats(residenceRows);
            const activeDistrictKeys = new Set(
                residenceRows
                    .map(row => normalizeArabic(row['start_point_district'] || ''))
                    .filter(Boolean)
            );

            DISTRICTS_DATA.features.forEach(feature => {
                const districtName = getDistrictNameFromFeature(feature);
                if (!districtName) return;
                const normalizedName = normalizeArabic(districtName);
                if (!activeDistrictKeys.has(normalizedName)) return;

                const stats = districtStats.get(normalizedName) || { pilgrims: 0, plans: 0 };
                const style = getDistrictPolygonStyle(districtName, stats, maxPilgrims);

                const geoLayer = L.geoJSON(feature, {
                    pane: 'districtPane',
                    style: () => style,
                    onEachFeature: (_feat, lyr) => {
                        lyr.bindTooltip(districtName, { sticky: true, className: 'district-tooltip' });
                        lyr.on('click', function (e) {
                            L.DomEvent.stopPropagation(e);
                            if (selectedDistrict && normalizeArabic(selectedDistrict) === normalizedName) {
                                selectedDistrict = null;
                            } else {
                                selectedDistrict = districtName;
                            }
                            applyFilters();
                        });
                    }
                }).addTo(districtsLayerGroup);

                if (selectedDistrict && normalizeArabic(selectedDistrict) === normalizedName) {
                    try { selectedDistrictBounds = geoLayer.getBounds(); } catch (_e) {}
                }
            });
        }
    }

    mapData.forEach(row => {
        try {
            const geojsonsToRender = getRowGeojsons(row);

            if (geojsonsToRender.length === 0) return;

            const connectedLineLatLngsByItem = new Map();
            // The journey chain is the routed leg plus the camp's internal leg.
            // The tarwia exit overlay is a separate decoration: it has its own
            // orientation rule below and can be toggled off entirely. Letting it
            // into the chain made tarwia a 3-segment case, and 3+ segments keep
            // the order they arrive in (internal, exit, external) — so the
            // scorer flipped the routed leg backwards to fit that impossible
            // order, and its dashes animated into the residence.
            const lineItems = geojsonsToRender.filter(item =>
                (item.geojson?.type === 'LineString' || item.geojson?.type === 'MultiLineString')
                && JOURNEY_LINE_TYPES.has(item.type));
            const connectedLineSequence = orientConnectedRouteSegments(row, lineItems);
            connectedLineSequence.forEach(orientedItem => {
                const sourceItem = geojsonsToRender.find(item => item.type === orientedItem.type && item.geojson === orientedItem.geojson);
                if (sourceItem) {
                    const routeLatLngs = sourceItem.type === "internal"
                        ? orientLatLngsForRoute(orientedItem.latlngs, row, sourceItem)
                        : orientedItem.latlngs;
                    // Keep the sequence in step with what is drawn, so the gap
                    // connectors join the same endpoints the polylines use.
                    orientedItem.latlngs = routeLatLngs;
                    connectedLineLatLngsByItem.set(sourceItem, routeLatLngs);
                }
            });

            geojsonsToRender.forEach(item => {
                if ((item.type === 'tarwia_exit' || item.type === 'tarwia_exit_point') && !showTarwiaExitPaths) return;
                const geojson = item.geojson;
                if (geojson && geojson.coordinates) {
                    extendBoundsFromGeojson(bounds, geojson);
                    let latlngs = [];
                    // Colors and Styles
                    let color = '#3b82f6';
                    let fillColor = '#93c5fd';
                    if (item.type === 'internal') { color = '#10b981'; fillColor = '#6ee7b7'; }
                    else if (item.type === 'tarwia_exit' || item.type === 'tarwia_exit_point') { color = '#dc2626'; fillColor = '#fecaca'; }
                    else if (item.type === 'entrance') { color = '#EBC468'; fillColor = '#fcd34d'; }
                    else if (item.type === 'start' || item.type === 'end') {
                        const tc = getTransportTypeColor(row['transport_type_name']);
                        color = tc.color; fillColor = tc.fillColor;
                    }
                    else if (item.type === 'get_parking') { color = '#f59e0b'; fillColor = '#fcd34d'; }
                    else if (item.type === 'set_parking') { color = '#ec4899'; fillColor = '#fbcfe8'; }
                    else if (item.type === 'parking_combined') { color = '#8b5cf6'; fillColor = '#ddd6fe'; }

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
                        if (item.type === 'tarwia_exit' && item.exitLatLng && latlngs.length >= 2) {
                            const firstDistance = getLatLngDistance(latlngs[0], item.exitLatLng);
                            const lastDistance = getLatLngDistance(latlngs[latlngs.length - 1], item.exitLatLng);
                            if (firstDistance < lastDistance) latlngs = [...latlngs].reverse();
                        }

                        const halo = L.polyline(latlngs, {
                            color: '#ffffff',
                            weight: 7,
                            opacity: 0.9,
                            dashArray: item.type === 'tarwia_exit' ? '10 8' : null,
                            className: 'route-line-halo'
                        }).addTo(routeLayerGroup);

                        const polyline = L.polyline(latlngs, {
                            color: color,
                            weight: 4,
                            opacity: 0.95,
                            dashArray: item.type === 'tarwia_exit' ? '10 8' : null,
                            className: 'route-line'
                        }).addTo(routeLayerGroup);

                        bindPopupToLayer(halo, row, item);
                        bindPopupToLayer(polyline, row, item);
                        if (showDetailedMapLabels) {
                            const areaLabel = getAreaLabel(row, item);
                            const midpoint = getMidpointLatLng(latlngs);
                            if (areaLabel && midpoint && item.type !== 'external') {
                                addMapLabel(midpoint, areaLabel, 'map-line-label', 'center');
                            }
                        }
                    }
                }
            });

            if (connectedLineSequence.length > 1 && shouldRenderRouteConnectors(row)) {
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
    const periodMetricDef = CHART_METRIC_DEFS[selectedChartMetrics.period] || CHART_METRIC_DEFS.pilgrims;
    const entranceMetricDef = CHART_METRIC_DEFS[selectedChartMetrics.entrance] || CHART_METRIC_DEFS.pilgrims;
    const pathMetricDef = CHART_METRIC_DEFS[selectedChartMetrics.path] || CHART_METRIC_DEFS.pilgrims;
    const districtMetricDef = CHART_METRIC_DEFS[selectedChartMetrics.district] || CHART_METRIC_DEFS.pilgrims;
    const periodMetricStats = buildChartMetricStats(selectedChartMetrics.period);
    const entranceMetricStats = buildChartMetricStats(selectedChartMetrics.entrance);
    const pathMetricStats = buildChartMetricStats(selectedChartMetrics.path);
    const districtMetricStats = buildChartMetricStats(selectedChartMetrics.district);
    const periodTitle = document.getElementById('periodChartTitle');
    const entranceTitle = document.getElementById('entranceChartTitle');
    const pathTitle = document.getElementById('pathChartTitle');
    const districtTitle = document.getElementById('districtChartTitle');
    if (periodTitle) periodTitle.textContent = periodMetricDef.periodTitle;
    if (entranceTitle) entranceTitle.textContent = entranceMetricDef.entranceTitle;
    if (pathTitle) pathTitle.textContent = pathMetricDef.pathTitle;
    if (districtTitle) districtTitle.textContent = districtMetricDef.districtTitle;

    // Period Chart
    const periodLabels = Object.keys(periodMetricStats.periodCounts).sort();
    const periodValues = periodLabels.map(l => periodMetricStats.periodCounts[l]);
    const periodPlotEl = document.getElementById('periodChart');
    if (periodPlotEl) {
        if (periodChartInstance) { periodChartInstance.destroy(); periodChartInstance = null; }
        let periodCanvas = periodPlotEl.querySelector('canvas');
        if (!periodCanvas) { periodCanvas = document.createElement('canvas'); periodPlotEl.replaceChildren(periodCanvas); }
        periodChartInstance = new Chart(periodCanvas, {
            type: 'bar',
            data: {
                labels: periodLabels,
                datasets: [{
                    data: periodValues,
                    backgroundColor: 'rgba(16, 116, 70, 0.82)',
                    borderColor: 'rgba(16, 116, 70, 1)',
                    borderWidth: 1,
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                layout: {
                    padding: { bottom: 8 }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        rtl: true,
                        textDirection: 'rtl',
                        callbacks: { label: ctx => periodMetricDef.label + ': ' + Number(ctx.raw || 0).toLocaleString() }
                    }
                },
                scales: {
                    x: {
                        afterFit: scale => { scale.height = Math.max(scale.height, 48); },
                        ticks: {
                            color: chartTheme.text,
                            autoSkip: false,
                            maxRotation: 0,
                            minRotation: 0,
                            padding: 8,
                            font: { family: "'IBM Plex Sans Arabic', system-ui, sans-serif", size: 11, weight: '700' }
                        },
                        grid: { display: false }
                    },
                    y: { ticks: { color: chartTheme.text }, grid: { color: chartTheme.grid } }
                },
                onClick: (e, elements) => {
                    if (!elements.length) return;
                    const label = periodLabels[elements[0].index];
                    const periodValue = String(label).replace('الفترة ', '').trim();
                    const filterEl = document.getElementById('periodFilter');
                    filterEl.value = filterEl.value === periodValue ? 'all' : periodValue;
                    selectedPlanId = null;
                    applyFilters();
                }
            }
        });
    }

    // أنماط النقل — share of buses per mode, doubling as the transport filter.
    const transportFilter = document.getElementById("transportFilter");
    const transportLabels = transportFilter
        ? Array.from(transportFilter.options).filter(o => o.value !== "all").map(o => o.value)
        : Object.keys(stats.transportCounts);
    const transportRamp = chartRamp(Math.max(transportLabels.length, 1));
    renderSegmentedFilter('transportCharts', {
        title: 'نمط النقل',
        segments: transportLabels.map((label, i) => ({
            value: label,
            label,
            amount: stats.transportCounts[label] || 0,
            color: transportRamp[i % transportRamp.length],
        })),
        selected: transportFilter && transportFilter.value !== 'all' ? transportFilter.value : null,
        onSelect: (value) => {
            if (!transportFilter) return;
            transportFilter.value = value || 'all';
            selectedPlanId = null;
            selectedEntranceName = null;
            selectedPathName = null;
            selectedDistrict = null;
            applyFilters();
        },
    });

    const entranceLabels = Object.keys(entranceMetricStats.entranceCounts).sort();
    const periodsArray = Array.from(entranceMetricStats.allPeriodsForEntrance).sort((a, b) => Number(a) - Number(b));

    const colors = [
        'rgba(16, 116, 70, 0.72)',
        'rgba(99, 182, 76, 0.72)',
        'rgba(131, 117, 78, 0.72)',
        'rgba(121, 28, 42, 0.72)',
        'rgba(13, 77, 81, 0.72)'
    ];

    const entranceDatasets = periodsArray.map((period, index) => {
        const data = entranceLabels.map(ent => entranceMetricStats.entranceCounts[ent][period] || 0);
        return {
            label: `الفترة ${period}`,
            data: data,
            backgroundColor: colors[index % colors.length],
            borderWidth: 0
        };
    });

    // Short labels for display: strip leading "مدخل " to save space
    const entranceShortLabels = entranceLabels.map(l => l.replace(/^مدخل\s+/, ''));
    const entranceShortToFull = Object.fromEntries(entranceLabels.map((f, i) => [entranceShortLabels[i], f]));

    // Entrance Chart
    const entrancePlotEl = document.getElementById('entranceChart');
    if (entrancePlotEl) {
        if (entranceChartInstance) { entranceChartInstance.destroy(); entranceChartInstance = null; }
        let entranceCanvas = entrancePlotEl.querySelector('canvas');
        if (!entranceCanvas) { entranceCanvas = document.createElement('canvas'); entrancePlotEl.replaceChildren(entranceCanvas); }
        entranceChartInstance = new Chart(entranceCanvas, {
            type: 'bar',
            data: {
                labels: entranceShortLabels,
                datasets: entranceDatasets.map(ds => ({ ...ds, borderRadius: 3 }))
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                layout: {
                    padding: { bottom: 118 }
                },
                plugins: {
                    legend: { display: false },
                    angledXAxisLabels: {
                        labels: entranceShortLabels,
                        color: chartTheme.text,
                        maxLength: 28,
                        angle: -55,
                        bottomOffset: 12
                    },
                    tooltip: {
                        rtl: true,
                        textDirection: 'rtl',
                        callbacks: {
                            title: items => entranceLabels[items[0]?.dataIndex] || items[0]?.label || '',
                            label: ctx => `${ctx.dataset.label}: ${Number(ctx.raw || 0).toLocaleString()}`
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: {
                            display: false
                        },
                        grid: { display: false }
                    },
                    y: { ticks: { color: chartTheme.text }, grid: { color: chartTheme.grid } }
                },
                onClick: (e, elements) => {
                    if (!elements.length) return;
                    const short = entranceShortLabels[elements[0].index];
                    const label = entranceShortToFull[short] || short;
                    selectedEntranceName = selectedEntranceName === label ? null : label;
                    selectedPlanId = null;
                    applyFilters();
                }
            },
            plugins: [angledXAxisLabelsPlugin]
        });
    }

    renderEntranceFloatingLegend(periodsArray, colors);

    // Path Chart
    const pathLabels = Object.keys(pathMetricStats.pathCounts).sort((a, b) => pathMetricStats.pathCounts[b] - pathMetricStats.pathCounts[a]);
    const pathValues = pathLabels.map(l => pathMetricStats.pathCounts[l]);

    const pathPlotEl = document.getElementById('pathChart');
    if (pathPlotEl) {
        if (pathChartInstance) { pathChartInstance.destroy(); pathChartInstance = null; }
        let pathCanvas = pathPlotEl.querySelector('canvas');
        if (!pathCanvas) { pathCanvas = document.createElement('canvas'); pathPlotEl.replaceChildren(pathCanvas); }
        pathChartInstance = new Chart(pathCanvas, {
            type: 'bar',
            data: {
                labels: pathLabels,
                datasets: [{
                    data: pathValues,
                    backgroundColor: 'rgba(99, 182, 76, 0.82)',
                    borderColor: 'rgba(99, 182, 76, 1)',
                    borderWidth: 1,
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                layout: {
                    padding: { bottom: 122 }
                },
                plugins: {
                    legend: { display: false },
                    angledXAxisLabels: {
                        labels: pathLabels,
                        color: chartTheme.text,
                        maxLength: 30,
                        angle: -55,
                        bottomOffset: 12
                    },
                    tooltip: {
                        rtl: true,
                        textDirection: 'rtl',
                        callbacks: { label: ctx => pathMetricDef.label + ': ' + Number(ctx.raw || 0).toLocaleString() }
                    }
                },
                scales: {
                    x: {
                        ticks: {
                            display: false
                        },
                        grid: { display: false }
                    },
                    y: { ticks: { color: chartTheme.text }, grid: { color: chartTheme.grid } }
                },
                onClick: (e, elements) => {
                    if (!elements.length) return;
                    const label = pathLabels[elements[0].index];
                    selectedPathName = selectedPathName === label ? null : label;
                    selectedPlanId = null;
                    applyFilters();
                }
            },
            plugins: [angledXAxisLabelsPlugin]
        });
    }

    renderCompletionSummaryChart(stats, chartTheme);
    renderResidenceAssignmentChart(chartTheme);

    const distLabels = Object.keys(districtMetricStats.districtCounts).sort((a, b) => districtMetricStats.districtCounts[b] - districtMetricStats.districtCounts[a]);
    const distValues = distLabels.map(l => districtMetricStats.districtCounts[l]);

    if (districtChartInstance && districtChartTheme === chartTheme.title) {
        districtChartInstance.data.labels = distLabels;
        districtChartInstance.data.datasets[0].data = distValues;
        districtChartInstance.update('none');
    } else {
        if (districtChartInstance) districtChartInstance.destroy();
        districtChartTheme = chartTheme.title;
        const ctxDist = document.getElementById('districtChart').getContext('2d');
        districtChartInstance = new Chart(ctxDist, {
        type: 'doughnut',
        data: {
            labels: distLabels,
            datasets: [{
                data: distValues,
                backgroundColor: [
                    'rgba(127, 117, 107, 0.72)',
                    'rgba(29, 87, 81, 0.72)',
                    'rgba(16, 116, 70, 0.72)',
                    'rgba(121, 28, 42, 0.72)',
                    'rgba(99, 182, 76, 0.72)',
                    'rgba(131, 117, 78, 0.72)',
                    'rgba(13, 77, 81, 0.72)'
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
                        font: { size: 9, family: "'IBM Plex Sans Arabic', system-ui, sans-serif", weight: '600' },
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
                            return `${label} - ${districtMetricDef.label}: ${value.toLocaleString()}`;
                        }
                    }
                },
                segmentPct: { display: false }
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
    const baseForCompletion = (planTypeBaseData.length ? planTypeBaseData : rawData)
        .filter(d => matchesCompanyOwnerFilters(d['owner_company_name'], d['owner_office_number']));
    const summaryStats = buildCompletionStats(baseForCompletion);
    const rowsByLabel = new Map(Object.values(summaryStats.completionByPlanType).map(row => [row.label, row]));
    const labels = getAvailablePlanTypeLabelsForCurrentContext();
    const rows = labels
        .map(label => rowsByLabel.get(label) || { planTypeCode: normalizePlanTypeCode(label), label, planned: 0, target: 0 })
        .sort((a, b) => getPlanTypeRingOrderIndex(a) - getPlanTypeRingOrderIndex(b) || b.target - a.target);

    const ramp = chartRamp(Math.max(rows.length, 1));
    // Every pilgrim moves in every phase, so the target is the same figure for
    // each plan type and a share of the total would read as a flat 25/25/25/25.
    // Each segment instead reports its planned pilgrims against that target.
    renderSegmentedFilter('completionSummaryCharts', {
        title: 'نوع الخطة',
        equalWidth: true,
        segments: rows.map((row, i) => {
            const planned = row.planned || 0;
            const target = row.target || 0;
            const pct = target > 0 ? Math.min(planned / target, 1) * 100 : 0;
            return {
                value: row.label,
                label: row.label,
                amount: planned,
                pct,
                tooltip: `${row.label} — مخطط ${planned.toLocaleString('ar-EG')} من ${target.toLocaleString('ar-EG')} حاج (${Math.round(pct)}%)`,
                color: ramp[i % ramp.length],
            };
        }),
        selected: selectedPlanTypes.size === 1 ? [...selectedPlanTypes][0] : null,
        onSelect: (value) => {
            selectedPlanTypes.clear();
            if (value) selectedPlanTypes.add(value);
            syncPlanTypeSelectValue();
            selectedPlanId = null;
            selectedEntranceName = null;
            selectedPathName = null;
            selectedDistrict = null;
            applyFilters();
        },
    });
}

function renderResidenceAssignmentChart(chartTheme) {
    const mix = getResidenceMixStats();
    const ramp = chartRamp(3);
    const segments = [
        { value: 'tarwiyah', label: 'تروية', amount: mix.tarwiyahOnly, color: ramp[0] },
        { value: 'direct', label: 'تصعيد مباشر', amount: mix.directTaseedOnly, color: ramp[1] },
        { value: 'mixed', label: 'مختلط', amount: mix.mixed, color: ramp[2] },
    ];

    renderSegmentedFilter('residenceAssignmentCharts', {
        title: 'المساكن',
        segments,
        selected: selectedResidenceMixFilter === 'all' ? null : selectedResidenceMixFilter,
        onSelect: (value) => {
            selectedResidenceMixFilter = value || 'all';
            selectedPlanId = null;
            applyFilters();
        },
    });
}

let selectedTripServiceCenter = null;

function removePlanLocally(planId) {
    for (let i = rawData.length - 1; i >= 0; i--) {
        if (rawData[i]['plan_id'] === planId) rawData.splice(i, 1);
    }
}

function closePlanEditor() {
    document.getElementById('planEditorBackdrop')?.remove();
}

// The CSV carries display names, not the foreign keys, so the current value of a
// dropdown has to be matched back to an option.
function currentOptionValue(field, plan) {
    const options = dbPermissions.options || {};
    if (field.name === 'transport_type_id') {
        const match = (options.transport_types || [])
            .find(t => t.name === plan['transport_type_name']);
        return match ? match.id : '';
    }
    if (field.name === 'timing_id') {
        const start = String(plan['timing_start_at'] || '').slice(0, 5);
        const end = String(plan['timing_end_at'] || '').slice(0, 5);
        const match = (options.timings || []).find(t =>
            t.plan_type_code === plan['plan_type_code'] && t.start_at === start && t.end_at === end);
        return match ? match.id : '';
    }
    if (field.name === 'get_parking' || field.name === 'set_parking') {
        const prefix = field.name === 'get_parking' ? 'get' : 'set';
        const name = plan[`${prefix}_parking_name`];
        const source = plan[`${prefix}_type_parking`];
        const match = (options.parking || []).find(o => o.name === name && o.source === source);
        return match ? match.value : '';
    }
    return '';
}

// Timings belong to a plan type, so only offer the ones valid for this plan.
function optionsForField(field, plan) {
    const options = dbPermissions.options || {};
    if (field.options === 'transport_types') {
        return (options.transport_types || []).map(t => ({ value: t.id, label: t.name }));
    }
    if (field.options === 'timings') {
        return (options.timings || [])
            .filter(t => !plan['plan_type_code'] || t.plan_type_code === plan['plan_type_code'])
            .map(t => ({ value: t.id, label: t.label }));
    }
    if (field.options === 'parking') {
        return (options.parking || []).map(o => ({ value: o.value, label: o.name }));
    }
    return [];
}

function planEditorFieldHtml(field, plan) {
    if (field.type === 'number') {
        return `
            <label class="plan-editor-field">
                <span>${escapeHtml(field.label)}</span>
                <input type="number" min="0" step="1" name="${field.name}"
                       value="${Number(plan[field.name]) || 0}" required>
            </label>`;
    }
    const selected = currentOptionValue(field, plan);
    const choices = optionsForField(field, plan);
    return `
        <label class="plan-editor-field wide">
            <span>${escapeHtml(field.label)}</span>
            <select name="${field.name}">
                <option value="">—</option>
                ${choices.map(c => `
                    <option value="${escapeHtml(c.value)}" ${c.value === selected ? 'selected' : ''}>
                        ${escapeHtml(c.label)}
                    </option>`).join('')}
            </select>
        </label>`;
}

function openPlanEditor(plan) {
    const fields = editablePlanFields();
    if (!fields || !fields.length) return;
    closePlanEditor();

    const backdrop = document.createElement('div');
    backdrop.id = 'planEditorBackdrop';
    backdrop.className = 'plan-editor-backdrop';
    backdrop.innerHTML = `
        <div class="plan-editor" role="dialog" aria-modal="true" aria-labelledby="planEditorTitle">
            <h3 id="planEditorTitle">تعديل الخطة</h3>
            <p class="plan-editor-sub">${escapeHtml(plan['owner_company_name'] || '')} — ${escapeHtml(plan['camp_label'] || '')}</p>
            <form id="planEditorForm">
                ${fields.map(field => planEditorFieldHtml(field, plan)).join('')}
                <p class="plan-editor-error" id="planEditorError" hidden></p>
                <div class="plan-editor-actions">
                    <button type="button" class="plan-editor-btn ghost" id="planEditorCancel">إلغاء</button>
                    <button type="submit" class="plan-editor-btn primary" id="planEditorSave">حفظ</button>
                </div>
            </form>
        </div>`;

    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closePlanEditor(); });
    document.getElementById('planEditorCancel').addEventListener('click', closePlanEditor);
    backdrop.querySelector('input, select')?.focus();

    document.getElementById('planEditorForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const saveBtn = document.getElementById('planEditorSave');
        const errorEl = document.getElementById('planEditorError');
        const form = new FormData(e.target);

        const patch = {};
        fields.forEach(field => {
            const raw = form.get(field.name);
            if (field.type === 'number') patch[field.name] = Number(raw);
            else patch[field.name] = raw ?? '';
        });

        saveBtn.disabled = true;
        saveBtn.textContent = 'جاري الحفظ...';
        try {
            const response = await fetch(`/maan-dashboard/api/db/plans/${plan['plan_id']}`, {
                method: 'PATCH',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(patch),
            });
            const payload = await response.json();
            if (!response.ok) throw new Error((payload.rejected || [payload.error]).join('، '));

            closePlanEditor();
            // Dropdowns change display names the CSV carries, so refetch rather
            // than trying to reconcile ids back to labels locally.
            await loadDatasetsFromDatabase();
            loadData();
        } catch (error) {
            errorEl.textContent = `تعذر الحفظ: ${error.message}`;
            errorEl.hidden = false;
            saveBtn.disabled = false;
            saveBtn.textContent = 'حفظ';
        }
    });
}

async function deletePlan(plan) {
    const label = `${plan['owner_company_name'] || ''} — ${plan['camp_label'] || ''}`;
    if (!confirm(`حذف هذه الخطة نهائياً؟\n${label}\n\nلا يمكن التراجع عن هذا الإجراء.`)) return;

    try {
        const response = await fetch(`/maan-dashboard/api/db/plans/${plan['plan_id']}`, {
            method: 'DELETE',
            headers: authHeaders(),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);

        removePlanLocally(plan['plan_id']);
        if (selectedPlanId === plan['plan_id']) selectedPlanId = null;
        applyFilters();
    } catch (error) {
        alert(`تعذر حذف الخطة: ${error.message}`);
    }
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
        const haj = Number(plan['number_of_haj']) || 0;
        const planType = plan['plan_type_name'] || plan['plan_type_code'] || 'غير معروف';
        const transportType = plan['transport_type_name'] || 'غير معروف';
        const transportCompany = plan['transport_company_name'] || 'غير محدد';
        // The mashaers file is the centre's bus roster (one row per bus), so a
        // plan shows the centre's supplier mix: lead company (most buses) with
        // "+N" more, and on hover every company with its bus count.
        const transportCompanyCount = Number(plan['transport_company_count']) || 0;
        const transportBusCount = Number(plan['transport_bus_count']) || 0;
        const transportCompanyLabel = transportCompanyCount > 1
            ? `${transportCompany} +${transportCompanyCount - 1}`
            : transportCompany;
        const busesNote = transportBusCount ? ` · ${transportBusCount.toLocaleString('ar-EG')} حافلة` : '';
        const transportCompanyTitle = transportCompanyCount > 1
            ? `شركات النقل (${transportCompanyCount})${busesNote}: ${plan['transport_companies'] || ''}`
            : `شركة النقل: ${transportCompany}${busesNote}`;
        const company = plan['owner_company_name'] || 'غير معروف';
        const centerNum = plan['owner_office_number'] || '';

        div.innerHTML = `
            <div class="plan-header">
                <span class="plan-company">${escapeHtml(company)}</span>
                <span class="plan-time">${escapeHtml(plan['timing_start_at'] || '')} - ${escapeHtml(plan['timing_end_at'] || '')}</span>
            </div>
            <div class="plan-details">
                <div class="plan-stat" title="عدد الحافلات"><i class="fa-solid fa-bus" aria-hidden="true"></i>${buses.toLocaleString()}</div>
                <div class="plan-stat" title="عدد الرحلات"><i class="fa-solid fa-route" aria-hidden="true"></i>${trips.toLocaleString()}</div>
                <div class="plan-stat" title="عدد الحجاج"><i class="fa-solid fa-users" aria-hidden="true"></i>${haj.toLocaleString()}</div>
                <div class="plan-stat" title="الفترة"><i class="fa-solid fa-clock" aria-hidden="true"></i>${escapeHtml(plan['period'] || '')}</div>
                <div class="plan-stat plan-type-stat" title="نوع الخطة: ${escapeHtml(planType)}"><i class="fa-solid fa-clipboard-list" aria-hidden="true"></i>${escapeHtml(planType)}</div>
                <div class="plan-stat plan-type-stat transport-type-stat" title="نمط النقل: ${escapeHtml(transportType)}"><i class="fa-solid fa-van-shuttle" aria-hidden="true"></i>${escapeHtml(transportType)}</div>
                <div class="plan-stat plan-type-stat transport-company-stat" title="${escapeHtml(transportCompanyTitle)}"><i class="fa-solid fa-building" aria-hidden="true"></i>${escapeHtml(transportCompanyLabel)}</div>
            </div>
            <div class="plan-route">
                <div class="plan-route-leg">
                    <i class="fa-solid fa-circle-dot" aria-hidden="true"></i>
                    <span class="plan-route-label">من</span>
                    <span class="plan-route-point">${escapeHtml(plan['start_point_name'] || 'غير متوفر')}</span>
                </div>
                <div class="plan-route-leg">
                    <i class="fa-solid fa-location-dot" aria-hidden="true"></i>
                    <span class="plan-route-label">إلى</span>
                    <span class="plan-route-point">${escapeHtml(plan['end_point_name'] || 'غير متوفر')}</span>
                </div>
            </div>
            ${centerNum ? `
            <div class="plan-center-row">
                <button type="button" class="plan-service-center-btn" data-company="${escapeHtml(company)}" data-center="${escapeHtml(centerNum)}">
                    <i class="fa-solid fa-location-dot" aria-hidden="true"></i>
                    <span>مركز الخدمة: ${escapeHtml(company)} / ${escapeHtml(centerNum)}</span>
                </button>
            </div>
            ` : ''}
            ${canEditPlansNow() ? `
            <div class="plan-actions">
                <button type="button" class="plan-action-btn plan-edit-btn" title="تعديل الخطة" aria-label="تعديل الخطة">
                    <i class="fa-solid fa-pen-to-square"></i> تعديل
                </button>
                <button type="button" class="plan-action-btn plan-delete-btn" title="حذف الخطة" aria-label="حذف الخطة">
                    <i class="fa-solid fa-trash-can"></i> حذف
                </button>
            </div>
            ` : ''}
        `;

        div.addEventListener('click', (e) => {
            if (e.target.closest('.plan-service-center-btn, .plan-action-btn')) {
                e.stopPropagation();
                return;
            }
            selectedPlanId = (selectedPlanId === plan['plan_id']) ? null : plan['plan_id'];
            selectedTripServiceCenter = null;
            applyFilters();
        });

        div.querySelector('.plan-edit-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            openPlanEditor(plan);
        });
        div.querySelector('.plan-delete-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            deletePlan(plan);
        });

        const centerBtn = div.querySelector('.plan-service-center-btn');
        if (centerBtn) {
            centerBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                selectedTripServiceCenter = {
                    company: centerBtn.dataset.company,
                    centerNumber: centerBtn.dataset.center
                };
                selectedPlanId = null;
                applyFilters();
            });
        }

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
