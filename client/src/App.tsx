import { Routes, Route, Navigate } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/query';
import { TooltipProvider } from './components/ui/tooltip';
import { Toaster } from './components/ui/toast';
import { ProtectedRoute } from './components/layout/ProtectedRoute';
import { AppLayout } from './components/layout/AppLayout';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { ChartsPage } from './pages/ChartsPage';
import { RoomDetailPage } from './pages/RoomDetailPage';
import { EnergyLimitsPage } from './pages/EnergyLimitsPage';
import { SystemSettingsPage } from './pages/SystemSettingsPage';
import { OperationLogsPage } from './pages/OperationLogsPage';
import { AlarmCenterPage } from './pages/AlarmCenterPage';
import { ForcePasswordChangePage } from './pages/ForcePasswordChangePage';
import { NetworkDevicePage } from './pages/NetworkDevicePage';

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/force-change-password"
            element={
              <ProtectedRoute>
                <ForcePasswordChangePage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <AppLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<DashboardPage />} />
            <Route path="charts" element={<ChartsPage />} />
            <Route path="rooms/:roomId" element={<RoomDetailPage />} />
            <Route path="energy-limits" element={<EnergyLimitsPage />} />
            <Route path="system" element={<SystemSettingsPage />} />
            <Route path="network-devices/:did" element={<NetworkDevicePage />} />
            <Route path="logs/operations" element={<OperationLogsPage />} />
            <Route path="logs/alarms" element={<AlarmCenterPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
