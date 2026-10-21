import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Home,
  BarChart3,
  Settings,
  List,
  Bell,
  LogOut,
  Menu,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Avatar, AvatarFallback } from '../ui/avatar';
import { Separator } from '../ui/separator';
import { Badge } from '../ui/badge';
import { useAuthStore } from '../../store/auth';
import { useUiStore } from '../../store/ui';
import { UserRole } from '../../types';
import * as api from '../../lib/api';

const menuItems = [
  { to: '/', icon: Home, label: '仪表盘', end: true },
  { to: '/charts', icon: BarChart3, label: '图表' },
  { to: '/system', icon: Settings, label: '系统设置' },
  { to: '/logs/operations', icon: List, label: '操作日志' },
  { to: '/logs/alarms', icon: Bell, label: '报警中心' },
];

export function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout, isAuthenticated } = useAuthStore();
  const { sidebarOpen, toggleSidebar, setSidebarOpen } = useUiStore();
  const { data: alarmSummary } = useQuery({
    queryKey: ['sidebar-alarm-summary'],
    queryFn: () => api.logs.alarms({ page: 1, pageSize: 1, resolved: false }),
    enabled: isAuthenticated,
    refetchOnWindowFocus: false,
    refetchInterval: 5000,
    refetchIntervalInBackground: true,
    staleTime: 3000,
  });
  const unresolvedAlarmCount = Number(alarmSummary?.total ?? 0);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname, setSidebarOpen]);

  const initials = user?.name?.slice(0, 2).toUpperCase() || 'ZH';
  const roleLabel =
    user?.role === UserRole.ADMIN
      ? '超级管理员'
      : user?.role === UserRole.BOSS
        ? '管理员'
        : '用户';

  return (
    <div className="flex h-screen bg-background">
      {sidebarOpen && (
        <button
          type="button"
          aria-label="关闭侧边栏遮罩"
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex h-full flex-col border-r bg-card transition-transform duration-200 md:static md:z-auto',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
          'w-[80vw] max-w-[256px] md:w-[13rem]'
        )}
      >
        <div className="flex h-14 items-center justify-between px-3">
          <span className="text-xl font-bold tracking-tight">ZHIRAI</span>
        </div>

        <Separator />

        <nav className="flex-1 space-y-1 p-1.5">
          {menuItems.map(({ to, icon: Icon, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  'justify-start md:w-auto'
                )
              }
              onClick={() => setSidebarOpen(false)}
            >
              <Icon className="h-5 w-5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {to === '/logs/alarms' && unresolvedAlarmCount > 0 ? (
                <Badge
                  variant="destructive"
                  className="h-5 min-w-5 rounded-full px-1 text-[10px] leading-none"
                >
                  {unresolvedAlarmCount > 99 ? '99+' : unresolvedAlarmCount}
                </Badge>
              ) : null}
            </NavLink>
          ))}
        </nav>

        <Separator />

        <div className="p-1.5">
          <div
            className={cn(
              'flex items-center gap-3 rounded-md p-2 justify-start'
            )}
          >
            <Avatar className="h-9 w-9">
              <AvatarFallback className="text-sm">{initials}</AvatarFallback>
            </Avatar>
            <div className="flex flex-1 flex-col overflow-hidden">
              <span className="truncate text-sm font-medium">
                {user?.name || 'User'}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {(user?.username || '') + (user?.username ? ' · ' : '') + roleLabel}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleLogout}
              title="退出登录"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-12 items-center border-b px-3 md:hidden">
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleSidebar}
              className="-ml-1"
              title="打开菜单"
            >
              <Menu className="h-5 w-5" />
            </Button>
          </div>
        </header>

        <main className="flex-1 overflow-auto p-2.5 sm:p-3 md:p-3.5">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
