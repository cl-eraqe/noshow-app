import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import LoginPage   from './pages/LoginPage';
import Dashboard   from './pages/Dashboard';
import NewReport   from './pages/NewReport';
import Analytics   from './pages/Analytics';
import AccessManagement from './pages/AccessManagement';
import FlightManager from './pages/FlightManager';
import PrivateRoute from './components/PrivateRoute';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        <Route path="/dashboard" element={
          <PrivateRoute><Dashboard /></PrivateRoute>
        } />

        <Route path="/new-report" element={
          <PrivateRoute><NewReport /></PrivateRoute>
        } />

        <Route path="/edit-report/:id" element={
          <PrivateRoute><NewReport editMode /></PrivateRoute>
        } />

        <Route path="/analytics" element={
          <PrivateRoute supervisorOnly><Analytics /></PrivateRoute>
        } />

        <Route path="/access-management" element={
          <PrivateRoute supervisorOnly><AccessManagement /></PrivateRoute>
        } />

        <Route path="/flight-manager" element={
          <PrivateRoute supervisorOnly><FlightManager /></PrivateRoute>
        } />

        {/* Default redirect */}
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
