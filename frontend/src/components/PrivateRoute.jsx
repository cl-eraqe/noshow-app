import { Navigate } from 'react-router-dom';
import { isLoggedIn, isSupervisor } from '../utils/auth';

export default function PrivateRoute({ children, supervisorOnly = false }) {
  if (!isLoggedIn()) return <Navigate to="/login" replace />;
  if (supervisorOnly && !isSupervisor()) return <Navigate to="/dashboard" replace />;
  return children;
}
