const ROLE_KEY  = 'noshow_role';
const TOKEN_KEY = 'noshow_token';

export function saveRole(role)   { localStorage.setItem(ROLE_KEY, role); }
export function getRole()        { return localStorage.getItem(ROLE_KEY); }
export function clearRole()      { localStorage.removeItem(ROLE_KEY); }

export function saveToken(token) { localStorage.setItem(TOKEN_KEY, token); }
export function getToken()       { return localStorage.getItem(TOKEN_KEY); }
export function clearToken()     { localStorage.removeItem(TOKEN_KEY); }

export function isLoggedIn()   { return !!(getRole() && getToken()); }
export function isSupervisor() { return getRole() === 'supervisor'; }

export function logout() {
  clearRole();
  clearToken();
}
