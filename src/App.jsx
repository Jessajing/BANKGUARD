import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./App.css";
import { customerSupabase, adminSupabase } from "./supabase";

// Approximate city-center fallbacks for ambiguous Philippine place names.
// These are map display coordinates only; they are not the device's exact location.
const APPROXIMATE_CITY_COORDINATES = {
  "iloilo": [10.7202, 122.5621], // Iloilo City center
  "iloilo city": [10.7202, 122.5621],
};

function validCoordinates(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= -90 && latitude <= 90 &&
    longitude >= -180 && longitude <= 180;
}

function SecurityLocationMap({ events }) {
  const mapElementRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(null);
  const [mapMessage, setMapMessage] = useState("Preparing approximate event locations...");

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current) return;

    const map = L.map(mapElementRef.current, {
      scrollWheelZoom: true,
      zoomControl: true,
    }).setView([12.8797, 121.7740], 5);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    mapRef.current = map;
    markersRef.current = L.featureGroup().addTo(map);
    const resizeTimer = window.setTimeout(() => map.invalidateSize(), 150);

    return () => {
      window.clearTimeout(resizeTimer);
      map.remove();
      mapRef.current = null;
      markersRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function plotEvents() {
      const map = mapRef.current;
      const markerGroup = markersRef.current;
      if (!map || !markerGroup) return;

      markerGroup.clearLayers();
      const placeGroups = new Map();

      for (const event of events || []) {
        const place = [event.city, event.region, event.country]
          .filter((part) => typeof part === "string" && part.trim())
          .join(", ");
        if (!place) continue;
        if (!placeGroups.has(place)) placeGroups.set(place, []);
        placeGroups.get(place).push(event);
      }

      const places = [...placeGroups.entries()].slice(0, 12);
      if (!places.length) {
        setMapMessage("No location details are available for the recorded events yet.");
        map.setView([12.8797, 121.7740], 5);
        return;
      }

      setMapMessage("Finding approximate city locations...");
      const bounds = [];
      let plotted = 0;

      for (const [place, placeEvents] of places) {
        if (cancelled) return;
        const first = placeEvents[0];
        // Prefer coordinates already stored with the event. Check all events
        // in the group instead of assuming the first event has coordinates.
        const eventWithCoordinates = placeEvents.find((event) => {
          const lat = Number(event.metadata?.latitude ?? event.latitude);
          const lon = Number(event.metadata?.longitude ?? event.longitude);
          return validCoordinates(lat, lon);
        });

        let coordinates = null;
        if (eventWithCoordinates) {
          coordinates = [
            Number(eventWithCoordinates.metadata?.latitude ?? eventWithCoordinates.latitude),
            Number(eventWithCoordinates.metadata?.longitude ?? eventWithCoordinates.longitude),
          ];
        }

        // "Iloilo" is ambiguous: a general text search can return another
        // municipality in Iloilo Province (such as Mina or Pototan).
        // For this dashboard, use Iloilo City's approximate center instead.
        if (!coordinates) {
          const cityKey = String(first.city || "").trim().toLowerCase();
          const normalizedPlace = place.toLowerCase();
          const iloiloMatch = cityKey === "iloilo" || cityKey === "iloilo city" ||
            normalizedPlace.includes("iloilo, western visayas") ||
            normalizedPlace.includes("iloilo city");
          if (iloiloMatch) {
            coordinates = APPROXIMATE_CITY_COORDINATES.iloilo;
          } else if (APPROXIMATE_CITY_COORDINATES[cityKey]) {
            coordinates = APPROXIMATE_CITY_COORDINATES[cityKey];
          }
        }

        // For other cities without saved coordinates, ask for the city together
        // with its region and country to reduce ambiguous search results.
        if (!coordinates) {
          try {
            const searchPlace = [first.city, first.region, first.country]
              .filter((part) => typeof part === "string" && part.trim())
              .join(", ");
            const response = await fetch(
              `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&q=${encodeURIComponent(searchPlace)}`,
              { signal: AbortSignal.timeout(8000) }
            );
            if (response.ok) {
              const results = await response.json();
              if (results?.[0]) {
                const lat = Number(results[0].lat);
                const lon = Number(results[0].lon);
                if (validCoordinates(lat, lon)) coordinates = [lat, lon];
              }
            }
          } catch (error) {
            console.warn("Could not locate event city on map:", place, error);
          }
        }

        if (cancelled) return;
        if (coordinates) {
          const eventLines = placeEvents.slice(0, 8).map((event) => {
            const kind = (event.event_type || "security event").replaceAll("_", " ");
            const time = event.created_at ? new Date(event.created_at).toLocaleString() : "Time unavailable";
            return `<div><strong>${kind}</strong><br/>${escapeMapText(event.attempted_email || "Unknown account")}<br/><small>${escapeMapText(time)}</small></div>`;
          }).join('<hr style="border:0;border-top:1px solid #ddd;margin:6px 0"/>');
          const marker = L.marker(coordinates).bindPopup(
            `<strong>${escapeMapText(place)}</strong><br/><small>${placeEvents.length} recorded event(s)</small><hr style="border:0;border-top:1px solid #ddd;margin:6px 0"/>${eventLines}`
          );
          marker.addTo(markerGroup);
          bounds.push(coordinates);
          plotted += 1;
        }

        // Respect the public geocoding service's low-volume usage expectations.
        if (places.length > 1) await new Promise((resolve) => window.setTimeout(resolve, 1100));
      }

      if (cancelled) return;
      if (bounds.length === 1) map.setView(bounds[0], 10);
      else if (bounds.length > 1) map.fitBounds(bounds, { padding: [28, 28], maxZoom: 10 });
      setMapMessage(plotted
        ? `Showing ${plotted} approximate location(s) from the latest security events.`
        : "The recorded locations could not be plotted. Try refreshing the dashboard later.");
    }

    plotEvents();
    return () => { cancelled = true; };
  }, [events]);

  return (
    <section className="admin-map-card">
      <div className="admin-events-heading">
        <div>
          <h3>Security Event Locations</h3>
          <p>Approximate city-level locations based on recorded IP information</p>
        </div>
        <span>Up to 12 locations</span>
      </div>
      <div ref={mapElementRef} className="admin-security-map" aria-label="Map of approximate security event locations" />
      <p className="admin-map-note">{mapMessage} Location pins are approximate city/region estimates, not exact device or home addresses. VPNs and mobile networks may affect accuracy.</p>
    </section>
  );
}

function escapeMapText(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
}

function hasAdminRole(data) {
  if (!data) return false;
  
  // Kung ang gipasa kay string nga "admin" na daan
  if (typeof data === 'string') {
    return data.trim().toLowerCase() === "admin";
  }
  
  // Kung ang gipasa kay tibuok user object
  return data?.app_metadata?.role === "admin" || data?.role === "admin";
}

function App() {
  const [loginType, setLoginType] = useState(() =>
    window.location.pathname.replace(/\/$/, "") === "/admin-login" ? "admin" : "customer"
  );
  // Each portal uses its own Supabase client and browser storage key.
  const authClient = loginType === "admin" ? adminSupabase : customerSupabase;
  const [page, setPage] = useState("login");
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminChecking, setAdminChecking] = useState(false);
  const [securityData, setSecurityData] = useState(null);
  const [securityError, setSecurityError] = useState("");

  const [bankAccount, setBankAccount] = useState(null);
  const [bankAccountLoading, setBankAccountLoading] = useState(false);
  const [bankAccountError, setBankAccountError] = useState("");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  async function loadAdminSecurityData() {
    setAdminChecking(true);
    setSecurityError("");
    const { data, error } = await authClient.functions.invoke(
      "admin-security-dashboard",
      { body: {} }
    );

    if (error || !data?.success) {
      console.error("Admin security dashboard error:", error || data);
      setSecurityData(null);
      setSecurityError(
        data?.error || error?.message ||
          "Unable to verify administrator access. Please sign in again."
      );
      setAdminChecking(false);
      return false;
    }

    setSecurityData(data);
    setIsAdmin(true);
    setAdminChecking(false);
    return true;
  }

  // Restore the signed-in session and verify administrator access server-side.
  useEffect(() => {
    let mounted = true;

    async function restoreSession() {
      const { data, error } = await authClient.auth.getSession();
      if (!mounted) return;

      if (error) console.error("Session error:", error.message);
      const restoredUser = data?.session?.user ?? null;

      if (restoredUser && loginType === "admin") {
        if (!hasAdminRole(restoredUser.app_metadata?.role)) {
          await authClient.auth.signOut({ scope: "local" });
          if (!mounted) return;
          setUser(null);
          setIsAdmin(false);
          setSecurityError("This is not an administrator account. Please use Customer Login.");
        } else {
          setUser(restoredUser);
          const { data: adminData, error: adminError } =
            await authClient.functions.invoke("admin-security-dashboard", { body: {} });

          if (!mounted) return;
          if (!adminError && adminData?.success) {
            setSecurityData(adminData);
            setIsAdmin(true);
          } else {
            console.error("Administrator session verification failed:", adminError || adminData);
            await authClient.auth.signOut({ scope: "local" });
            if (!mounted) return;
            setUser(null);
            setIsAdmin(false);
            setSecurityError("Administrator verification failed. Please sign in again.");
          }
        }
      } else if (restoredUser && hasAdminRole(restoredUser.app_metadata?.role)) {
        await authClient.auth.signOut({ scope: "local" });
        if (!mounted) return;
        setUser(null);
        setIsAdmin(false);
      } else {
        setUser(restoredUser);
        setIsAdmin(false);
      }
      if (mounted) setAuthLoading(false);
    }

    restoreSession();

    const {
      data: { subscription },
    } = authClient.auth.onAuthStateChange((_event, session) => {
      if (mounted) setUser(session?.user ?? null);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [loginType]);

  // Load the signed-in customer's bank account.
  useEffect(() => {
    let cancelled = false;

    async function loadBankAccount() {
      if (!user || hasAdminRole(user.app_metadata?.role)) {
        setBankAccount(null);
        setBankAccountError("");
        setBankAccountLoading(false);
        return;
      }

      setBankAccountLoading(true);
      setBankAccountError("");
      const { data, error } = await authClient
        .from("bank_accounts")
        .select("account_number, balance, currency, account_status")
        .eq("user_id", user.id)
        .maybeSingle();

      if (cancelled) return;
      if (error) {
        console.error("Bank account loading error:", error);
        setBankAccount(null);
        setBankAccountError("Unable to load your bank account. Please refresh and try again.");
      } else {
        setBankAccount(data);
      }
      setBankAccountLoading(false);
    }

    loadBankAccount();
    return () => { cancelled = true; };
  }, [user]);

  function clearFields() {
    setEmail("");
    setPassword("");
    setFullName("");
    setConfirmPassword("");
  }

  function changeLoginType(type) {
    setLoginType(type);
    setPage("login");
    setSecurityError("");
    clearFields();
  }

  async function handleLogin(event) {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();


    try {
      setLoading(true);

      if (loginType === "admin") {
        // Authenticate normally, then require the protected server endpoint to
        // confirm app_metadata.role before showing any security information.
        const { data, error } = await authClient.auth.signInWithPassword({
          email: normalizedEmail,
          password,
        });
        if (error) throw error;

        const { data: adminData, error: adminError } =
          await authClient.functions.invoke("admin-security-dashboard", {
            body: {},
          });

        // if (adminError || !adminData?.success) {
        //   await authClient.auth.signOut({ scope: "local" });
        //   throw new Error(
        //     adminData?.error ||
        //       "This account is not authorized to access the Administrator Dashboard."
        //   );
        // }

        setUser(data.user);
        setSecurityData(adminData);
        setIsAdmin(true);
        setPage("dashboard");
        clearFields();
        return;
      }

      // Existing customer lockout check.
      const { data: lockoutData, error: lockoutError } =
        await authClient.functions.invoke("log-security-event", {
          body: {
            action: "check_lockout",
            attempted_email: normalizedEmail,
          },
        });

      // if (lockoutError || !lockoutData) {
      //   console.error("BankGuard lockout check failed:", lockoutError);
      //   throw new Error(
      //     "BankGuard could not verify your account security status. Please try again later."
      //   );
      // }

      // if (lockoutData.locked === true) {
      //   alert("Your login is temporarily locked because of repeated failed attempts. Please wait 5 minutes before trying again.");
      //   return;
      // }

      const { data, error } = await authClient.auth.signInWithPassword({
        email: normalizedEmail,
        password,
      });

            if (error) {
        let failureData = null;
        try {
          const response = await authClient.functions.invoke("log-security-event", {
            body: {
              action: "login_failed",
              attempted_email: normalizedEmail,
            },
          });
          failureData = response.data;
        } catch (err) {
          console.error("Failed to invoke edge function:", err);
        }

        // Kung ang edge function ni-return og locked status
        if (failureData?.locked === true) {
          throw new Error("Your account is now temporarily locked after 5 failed login attempts. Please wait 5 minutes before trying again.");
        }

        // Kung ni-return og attempts, ipakita. Kung wala, default sa 0.
        const attempts = Number(failureData?.attempts || 0);
        
        if (attempts > 0) {
          throw new Error(`The email or password is incorrect. Failed attempts: ${attempts} of 5.`);
        } else {
          throw new Error("The email or password is incorrect."); 
        }
      }
      const { error: successLogError } =
        await authClient.functions.invoke("log-security-event", {
          body: {
            action: "login_success",
            attempted_email: normalizedEmail,
          },
        });

      if (successLogError) {
        console.error("BankGuard successful-login logging error:", successLogError);
        alert("Login successful, but BankGuard could not update the security log. Please inform the administrator.");
      }

      if (hasAdminRole(data.user?.app_metadata?.role)) {
        await authClient.auth.signOut({ scope: "local" });
        throw new Error("Administrator accounts must sign in through Admin Login.");
      }

      setUser(data.user);
      setIsAdmin(false);
      clearFields();
      setPage("dashboard");
    } catch (error) {
      alert(error.message || "Unable to sign in. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(event) {
    event.preventDefault();
    if (password !== confirmPassword) {
      alert("Passwords do not match. Please try again.");
      return;
    }
    if (password.length < 8) {
      alert("Your password must contain at least 8 characters.");
      return;
    }

    try {
      setLoading(true);
      const { data, error } = await authClient.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: { full_name: fullName.trim(), account_type: "customer" },
        },
      });
      if (error) throw error;
      if (!data.user) throw new Error("Registration could not be completed.");
      if (data.session) await authClient.auth.signOut({ scope: "local" });

      setUser(null);
      clearFields();
      setLoginType("customer");
      setPage("login");
      alert("Registration successful! Check your email if confirmation is required. You can now sign in.");
    } catch (error) {
      alert(error.message || "Registration failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function openRegistration() {
    clearFields();
    setPage("register");
  }

  function backToLogin() {
    clearFields();
    setPage("login");
  }

  async function handleLogout() {
    try {
      setLoading(true);
      const { error } = await authClient.auth.signOut({ scope: "local" });
      if (error) throw error;
      setUser(null);
      setIsAdmin(false);
      setSecurityData(null);
      setSecurityError("");
      setPage("login");
      clearFields();
    } catch (error) {
      alert(error.message || "Unable to log out. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function refreshAdminDashboard() {
    await loadAdminSecurityData();
  }

  const customerName =
    user?.user_metadata?.full_name ||
    user?.email?.split("@")[0] ||
    "Customer";

  const formattedBalance = bankAccount
    ? new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: bankAccount.currency || "PHP",
      }).format(Number(bankAccount.balance ?? 0))
    : "—";

  if (authLoading) {
    return (
      <main className="loading-page">
        <div className="loading-brand">B</div>
        <p>Loading BankGuard...</p>
      </main>
    );
  }

  if (user && hasAdminRole(user.app_metadata?.role) && !isAdmin) {
    return (
      <main className="loading-page">
        <div className="loading-brand">B</div>
        <p>{securityError || "Verifying administrator access..."}</p>
      </main>
    );
  }

  // ADMINISTRATOR SECURITY DASHBOARD
  if (user && isAdmin) {
    const summary = securityData?.summary || {};
    const events = securityData?.events || [];
    return (
      <main className="dashboard-page admin-dashboard">
        <header className="dashboard-header">
          <div className="dashboard-brand">
            <div className="dashboard-brand-icon">B</div>
            <div>
              <h1>BankGuard</h1>
              <p>Administrator Security Monitoring</p>
            </div>
          </div>
          <div className="admin-header-actions">
            <button className="refresh-button" onClick={refreshAdminDashboard} disabled={adminChecking}>
              {adminChecking ? "Refreshing..." : "↻ Refresh"}
            </button>
            <button className="logout-button" onClick={handleLogout} disabled={loading}>
              {loading ? "Logging out..." : "Log Out"}
            </button>
          </div>
        </header>

        <section className="dashboard-content">
          <div className="welcome-section">
            <div>
              <p className="eyebrow">ADMINISTRATOR PORTAL</p>
              <h2>Security Overview</h2>
              <p>Monitor authentication activity recorded by BankGuard.</p>
            </div>
            <div className="account-status"><span className="status-dot"></span> Admin verified</div>
          </div>

          {securityError && <div className="admin-error">{securityError}</div>}

          <div className="admin-summary-grid">
            <section className="admin-stat-card">
              <span>Failed Logins · 24 hours</span>
              <strong>{summary.failed_logins ?? 0}</strong>
            </section>
            <section className="admin-stat-card">
              <span>Successful Logins · 24 hours</span>
              <strong>{summary.successful_logins ?? 0}</strong>
            </section>
            <section className="admin-stat-card">
              <span>Locked Attempts · 24 hours</span>
              <strong>{summary.locked_attempts ?? 0}</strong>
            </section>
            <section className="admin-stat-card">
              <span>IP Block Events · 24 hours</span>
              <strong>{summary.ip_blocked ?? 0}</strong>
            </section>
          </div>

          <SecurityLocationMap events={events} />

          <section className="admin-events-card">
            <div className="admin-events-heading">
              <div>
                <h3>Recent Security Events</h3>
                <p>Latest recorded authentication and security activity</p>
              </div>
              <span>{events.length} records</span>
            </div>

            {adminChecking ? (
              <div className="admin-empty">Loading security events...</div>
            ) : events.length === 0 ? (
              <div className="admin-empty">No security events have been recorded yet.</div>
            ) : (
              <div className="admin-table-wrap">
                <table className="admin-events-table">
                  <thead>
                    <tr>
                      <th>Event</th>
                      <th>Email</th>
                      <th>IP Address</th>
                      <th>Location / ISP</th>
                      <th>Browser / OS</th>
                      <th>Date &amp; Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((event) => (
                      <tr key={event.id}>
                        <td><span className={`event-pill ${event.event_type}`}>{event.event_type.replaceAll("_", " ")}</span></td>
                        <td>{event.attempted_email || "—"}</td>
                        <td>{event.ip_address || "—"}</td>
                        <td>{[event.city, event.region, event.country].filter(Boolean).join(", ") || "Unknown"}<small>{event.isp || "ISP unavailable"}</small></td>
                        <td>{event.browser || "Unknown"}<small>{event.operating_system || "Unknown"}</small></td>
                        <td>{new Date(event.created_at).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <footer className="dashboard-footer">© 2026 BankGuard. Administrator access is restricted.</footer>
        </section>
      </main>
    );
  }

  // CUSTOMER DASHBOARD
  if (user) {
    return (
      <main className="dashboard-page">
        <header className="dashboard-header">
          <div className="dashboard-brand">
            <div className="dashboard-brand-icon">B</div>
            <div><h1>BankGuard</h1><p>Secure Online Banking</p></div>
          </div>
          <button className="logout-button" onClick={handleLogout} disabled={loading}>
            {loading ? "Logging out..." : "Log Out"}
          </button>
        </header>

        <section className="dashboard-content">
          <div className="welcome-section">
            <div>
              <p className="eyebrow">CUSTOMER PORTAL</p>
              <h2>Welcome, {customerName}!</h2>
              <p>Here's an overview of your BankGuard account.</p>
            </div>
            <div className="account-status"><span className="status-dot"></span> Authenticated</div>
          </div>

          <div className="dashboard-grid">
            <section className="dashboard-card profile-card">
              <div className="card-heading"><div className="card-icon">👤</div><div><h3>Account Profile</h3><p>Your registered account information</p></div></div>
              <div className="profile-details">
                <div><span>Full Name</span><strong>{customerName}</strong></div>
                <div><span>Email Address</span><strong>{user.email}</strong></div>
                <div><span>Account Type</span><strong>Customer</strong></div>
                <div><span>Login Status</span><strong className="active-text">Authenticated</strong></div>
                <div><span>Bank Account Status</span><strong className="active-text">{bankAccountLoading ? "Loading..." : bankAccount?.account_status || "Not available"}</strong></div>
              </div>
            </section>

            <section className="dashboard-card balance-card">
              <div className="card-heading"><div className="card-icon">₱</div><div><h3>Available Balance</h3><p>Simulated banking account</p></div></div>
              <div className="balance-placeholder">
                {bankAccountLoading ? <><span>Loading account...</span><p>Please wait while we retrieve your account details.</p></> :
                  bankAccountError ? <><span>Account unavailable</span><p>{bankAccountError}</p></> :
                  bankAccount ? <><span>{formattedBalance}</span><p>Available simulated balance</p><p>Account Number: <strong>{bankAccount.account_number}</strong></p></> :
                  <><span>Bank account not found</span><p>No bank account record is linked to this customer yet. Please contact the BankGuard administrator.</p></>}
              </div>
            </section>

            <section className="dashboard-card transaction-card">
              <div className="card-heading"><div className="card-icon">↕</div><div><h3>Recent Transactions</h3><p>Your latest banking activities</p></div></div>
              <div className="empty-state"><div className="empty-icon">↔</div><strong>No transactions yet</strong><p>Your transaction history will appear here once transactions are recorded.</p></div>
            </section>

            <section className="dashboard-card security-card">
              <div className="card-heading"><div className="card-icon">🔒</div><div><h3>Account Security</h3><p>Your current login status</p></div></div>
              <div className="security-status"><span className="security-check">✓</span><div><strong>Authenticated Session</strong><p>Your credentials were successfully verified by BankGuard.</p></div></div>
              <div className="security-reminder">Never share your password with anyone.</div>
            </section>
          </div>
          <footer className="dashboard-footer">© 2026 BankGuard. All rights reserved.</footer>
        </section>
      </main>
    );
  }

  // LOGIN AND REGISTRATION
  return (
    <main className="login-page">
      <section className="login-card">
        <div className="brand"><div className="brand-icon">B</div><h1>BankGuard</h1><p>Secure Online Banking</p></div>

        {page === "login" && <>
          <div className="login-heading">
            <h2>{loginType === "admin" ? "Administrator Login" : "Welcome Back"}</h2>
            <p>{loginType === "admin" ? "Sign in to access the administrator security dashboard." : "Sign in to access your banking account."}</p>
          </div>
          <form onSubmit={handleLogin} autoComplete="off">
            <label htmlFor="bankguard-email">Email Address</label>
            <input id="bankguard-email" type="email" name="bankguard-login-email" placeholder="Enter your email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck="false" required />
            <label htmlFor="bankguard-password">Password</label>
            <input id="bankguard-password" type="password" name="bankguard-login-password" placeholder="Enter your password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required />
            <button type="submit" className="login-button" disabled={loading}>{loading ? "Please wait..." : "Sign In"}</button>
          </form>
          {loginType === "customer" && <p className="register-text">Don't have an account? <span onClick={openRegistration}>Register here</span></p>}
          <div className="security-note"><span>🔒</span> Protected by BankGuard Security</div>
        </>}

        {page === "register" && <>
          <div className="login-heading"><h2>Create Account</h2><p>Register for your BankGuard customer account.</p></div>
          <form onSubmit={handleRegister} autoComplete="off">
            <label htmlFor="register-name">Full Name</label>
            <input id="register-name" type="text" name="bankguard-full-name" placeholder="Enter your full name" value={fullName} onChange={(event) => setFullName(event.target.value)} autoComplete="off" required />
            <label htmlFor="register-email">Email Address</label>
            <input id="register-email" type="email" name="bankguard-register-email" placeholder="Enter your email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="off" required />
            <label htmlFor="register-password">Password</label>
            <input id="register-password" type="password" name="bankguard-register-password" placeholder="Create a password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength="8" required />
            <label htmlFor="confirm-password">Confirm Password</label>
            <input id="confirm-password" type="password" name="bankguard-confirm-password" placeholder="Confirm your password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength="8" required />
            <button type="submit" className="login-button" disabled={loading}>{loading ? "Creating Account..." : "Create Account"}</button>
          </form>
          <p className="register-text">Already have an account? <span onClick={backToLogin}>Back to Login</span></p>
          <div className="security-note"><span>🔒</span> Protected by BankGuard Security</div>
        </>}
      </section>
      <footer>© 2026 BankGuard. All rights reserved.</footer>
    </main>
  );
}

export default App;
