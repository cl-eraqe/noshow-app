const ROLE_KEY = 'noshow_role';

export function saveRole(role) {
  localStorage.setItem(ROLE_KEY, role);
}

export function getRole() {
  return localStorage.getItem(ROLE_KEY); // 'staff' | 'supervisor' | null
}

export function clearRole() {
  localStorage.removeItem(ROLE_KEY);
}

export function isLoggedIn() {
  return !!getRole();
}

export function isSupervisor() {
  return getRole() === 'supervisor';
}
