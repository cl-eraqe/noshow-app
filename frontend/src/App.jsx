import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import LoginPage   from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import Dashboard   from './pages/Dashboard';
import NewReport   from './pages/NewReport';
import Analytics   from './pages/Analytics';
import AccessManagement from './pages/AccessManagement';
import FlightManager from './pages/FlightManager';
import SharePicker from './pages/SharePicker';
import UsersPage   from './pages/UsersPage';
import PrivateRoute from './components/PrivateRoute';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

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

        <Route path="/users" element={
          <PrivateRoute supervisorOnly><UsersPage /></PrivateRoute>
        } />

        <Route path="/share-pick" element={
          <PrivateRoute><SharePicker /></PrivateRoute>
        } />

        {/* Default redirect */}
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
