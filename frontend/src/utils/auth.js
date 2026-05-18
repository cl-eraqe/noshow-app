const ROLE_KEY = 'noshow_role';

export function saveRole(role)   { localStorage.setItem(ROLE_KEY, role); }
export function getRole()        { return localStorage.getItem(ROLE_KEY); }
export function clearRole()      { localStorage.removeItem(ROLE_KEY); }

// Token is now in an HttpOnly cookie — not accessible from JS.
// isLoggedIn checks localStorage role as a UI hint only; the real auth
// check happens server-side on every request.
export function isLoggedIn()   { return !!getRole(); }
export function isSupervisor() { return getRole() === 'supervisor'; }

export function logout() {
  clearRole();
}
