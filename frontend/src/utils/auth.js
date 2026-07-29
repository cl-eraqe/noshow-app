const ROLE_KEY     = 'noshow_role';
const TOKEN_KEY    = 'noshow_token';
const USERNAME_KEY = 'noshow_username';
// Which terminal ('T1' | 'North') this account belongs to — empty string for
// the supervisor, who isn't scoped to one. Distinct from the flight-derived
// terminal lookup in utils/api.js (getTerminal/needsBus), hence the
// "OwnerTerminal" naming to avoid any confusion between the two.
const OWNER_TERMINAL_KEY = 'noshow_owner_terminal';

export function saveRole(role)         { localStorage.setItem(ROLE_KEY, role); }
export function getRole()              { return localStorage.getItem(ROLE_KEY); }
export function clearRole()            { localStorage.removeItem(ROLE_KEY); }

export function saveToken(token)       { localStorage.setItem(TOKEN_KEY, token); }
export function getToken()             { return localStorage.getItem(TOKEN_KEY); }
export function clearToken()           { localStorage.removeItem(TOKEN_KEY); }

export function saveUsername(name)     { localStorage.setItem(USERNAME_KEY, name || ''); }
export function getUsername()          { return localStorage.getItem(USERNAME_KEY) || ''; }
export function clearUsername()        { localStorage.removeItem(USERNAME_KEY); }

export function saveOwnerTerminal(t)   { localStorage.setItem(OWNER_TERMINAL_KEY, t || ''); }
export function getOwnerTerminal()     { return localStorage.getItem(OWNER_TERMINAL_KEY) || ''; }
export function clearOwnerTerminal()   { localStorage.removeItem(OWNER_TERMINAL_KEY); }

export function isLoggedIn()           { return !!(getRole() && getToken()); }
export function isSupervisor()         { return getRole() === 'supervisor'; }

export function logout() {
  clearRole();
  clearToken();
  clearOwnerTerminal();
}
