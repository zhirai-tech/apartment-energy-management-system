import { useState, useEffect, type FormEvent, type ChangeEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { auth } from '../lib/api';
import { useAuthStore } from '../store/auth';
import type { LoginRequest } from '../types';

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const setAuth = useAuthStore((state) => state.setAuth);
  const logout = useAuthStore((state) => state.logout);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const persistedRemember = useAuthStore((state) => state.remember);
  const persistedRemembered = useAuthStore((state) => state.remembered);

  const [loading, setLoading] = useState(false);
  const [remember, setRemember] = useState<boolean>(() => !!persistedRemember);
  const [form, setForm] = useState<LoginRequest>(() => {
    const creds = persistedRemembered;
    if (persistedRemember && creds) {
      return { username: creds.username ?? '', password: creds.password ?? '' };
    }
    try {
      const savedUser = localStorage.getItem('zaem_saved_username');
      return { username: savedUser ?? '', password: '' };
    } catch {
      return { username: '', password: '' };
    }
  });

  useEffect(() => {
    if (isAuthenticated) {
      const from = (location.state as { from?: Location })?.from;
      const redirect = from?.pathname ?? '/';
      navigate(redirect, { replace: true });
    } else {
      try {
        logout();
      } catch {
      }
    }
  }, [isAuthenticated, navigate, location.state, logout]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.username || !form.password) {
      toast.error('请输入用户名和密码');
      return;
    }
    setLoading(true);
    try {
      const res = await auth.login(form);
      const credentials = remember ? { username: form.username, password: form.password } : undefined;
      setAuth(res.token, res.user, remember, credentials);
      try {
        if (remember) {
          localStorage.setItem('zaem_remember_me', '1');
          localStorage.setItem('zaem_saved_username', form.username);
        } else {
          localStorage.removeItem('zaem_remember_me');
          localStorage.removeItem('zaem_saved_username');
        }
      } catch {
      }
      toast.success('登录成功');
      if (res.user.mustChangePassword) {
        navigate('/force-change-password', { replace: true });
        return;
      }
      const from = (location.state as { from?: Location })?.from;
      navigate(from?.pathname ?? '/', { replace: true });
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string } } };
      toast.error(error?.response?.data?.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">ZHIRAI</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">用户名</Label>
              <Input
                id="username"
                value={form.username}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, username: e.target.value })}
                placeholder="请输入用户名"
                autoComplete="username"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                value={form.password}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, password: e.target.value })}
                placeholder="请输入密码"
                autoComplete="current-password"
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border px-3 py-2">
              <div className="flex items-center gap-2">
                <Switch
                  id="remember-me"
                  checked={remember}
                  onCheckedChange={(val) => setRemember(val)}
                />
                <Label htmlFor="remember-me" className="cursor-pointer text-sm">
                  记住登录
                </Label>
              </div>
            </div>

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? '登录中...' : '登录'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
