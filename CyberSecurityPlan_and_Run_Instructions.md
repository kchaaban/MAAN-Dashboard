
### User Management and Cybersecurity Plan: Maan Dashboard

**Current State Assessment:**
Currently, the Maan Dashboard operates as a client-side Vite/React application where data files (like `assign_camps.js` and other statistics) are loaded directly into the frontend. This means anyone who can access the URL can potentially download the raw transportation and pilgrim data.

**Objective:**
To secure sensitive Hajj transport operations data by migrating from a static frontend architecture to a secure, backend-served, and authentication-protected environment using JWTs and Role-Based Access Control (RBAC).

#### Phase 1: Architectural Security Redesign
1. **Backend Integration:** Introduce a lightweight Node.js/Express backend (or integrate with your existing backend).
2. **Data Migration:** Move all sensitive data files (`data/`, `assign_camps.js`, and data generation scripts) out of the Vite public/frontend directory and strictly into the backend server environment.
3. **API creation:** Replace direct file imports in `app.js` with secure API endpoints (e.g., `/api/v1/dashboard/stats`, `/api/v1/dashboard/camps`).

#### Phase 2: Authentication & User Management (JWT)
1. **Login Interface:** Develop a secure login screen for the React frontend.
2. **JWT Implementation:** Implement JSON Web Token (JWT) based authentication. Upon successful login, the backend will issue a short-lived access token and an HTTP-only refresh token.
3. **Route Protection:** Protect the React dashboard routes using a higher-order component or router guards, redirecting unauthenticated users to the login screen.

#### Phase 3: Role-Based Access Control (RBAC)
1. **Define Roles:** Establish user tiers based on operational needs:
   - *Viewer:* Can see high-level KPIs (Total Pilgrims, Buses).
   - *Operations Manager:* Can view detailed camp assignments and fraction data.
   - *Administrator:* Can manage users and system settings.
2. **Endpoint Authorization:** Enforce role checks on the backend API endpoints so users cannot bypass frontend restrictions via direct API calls.

#### Phase 4: Integration & Hardening (Iframe / Portal)
1. **Secure Embedding (Optional):** If the Maan Dashboard will be embedded inside a larger platform, we will set up secure, authenticated iframe communications to verify the parent window's JWT before rendering the dashboard.
2. **CORS & Headers:** Implement strict Cross-Origin Resource Sharing (CORS) policies to only accept API requests from authorized domains. Apply security headers (Helmet) to prevent XSS and Clickjacking.
3. **Audit Logging:** Implement backend logging for all data access requests to maintain an audit trail of who viewed sensitive transportation data.

### Here is what was done:

**I have implemented the plan in the cybersecurity-implementation branch of maan-dashboard repo.**

1. **Architectural Redesign & Data Security (Phase 1 & 3):**
   - I created a lightweight Node.js/Express backend inside a new `server` directory.
   - All sensitive data files (like `data.js`, `assign_camps.js`, `assign_residences.js`) and data generation scripts have been moved out of the public frontend and securely isolated into `server/data/` and `server/scripts/`.

2. **Authentication & User Management (Phase 2):**
   - I implemented JWT-based authentication in the Express server.
   - On the frontend, I replaced the direct global data `<script>` tags with a new script `auth.js`.
   - `auth.js` creates a dark-themed login modal overlay. The dashboard interface will not load or display until the user is successfully authenticated.
   - Once authenticated, `auth.js` securely requests the data files via API using the JWT Bearer token and injects them securely before initializing `app.js`.

3. **Role-Based Access Control (Phase 4):**
   - Implemented three testing roles with hardcoded mock credentials on the backend:
     - **Administrator** (`admin` / `password`): Full access to all KPIs and detailed data.
     - **Operations Manager** (`manager` / `password`): Full access to all KPIs and detailed data.
     - **Viewer** (`viewer` / `password`): General KPI access. (Specifically, they are blocked from downloading the sensitive `assign_camps.js` and `assign_residences.js` detailed datasets; the backend gracefully intercepts and returns an empty payload instead).

---

### How to Run the Secured Project

I've already modified the backend code (`server/index.js`) to automatically serve your frontend application, and updated the `auth.js` to use relative API paths. This means your Express backend will now handle both the API and serving the dashboard interface over a single port!

Since the project now features a client-server architecture, you need to run both the frontend and the backend from terminal of the bus-data-analysis VM. Please clone the repo in the VM and follow the steps:

### 1. Build the Frontend
We need to bundle your Vite React application into optimized static HTML/JS files that Express can serve. In your VM terminal, run:
```bash
# Make sure you are in the root directory
cd /Users/firstcity/GIT/maan-dashboard

# Install any missing frontend dependencies
npm install

# Build the production bundle (creates a /dist folder)
npm run build
```

### 2. Keep the Server Running with PM2
Instead of running `node index.js` which will stop as soon as you close your SSH session, we will use a process manager called `pm2` to keep it running in the background indefinitely.

```bash
# Install PM2 globally
sudo npm install -g pm2

# Navigate to the server folder
cd /Users/firstcity/GIT/maan-dashboard/server

# Start the server using PM2
pm2 start index.js --name "maan-dashboard"

# (Optional) Tell PM2 to automatically restart the server if the VM reboots
pm2 startup
pm2 save
```

### 3. Access the Dashboard
You can now access your application from any browser using your Azure VM's Public IP address!
```
http://<YOUR_AZURE_VM_PUBLIC_IP>:3000
```
