import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Settings, Save, RefreshCw, Power, CheckCircle2, XCircle, LogIn, Shield, UserPlus, Trash2, HelpCircle, Plus, Loader2, CheckSquare, Square } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { PasswordInput } from '../components/ui/password-input'
import { Label } from '../components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Badge } from '../components/ui/badge'
import { Switch } from '../components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog'
import { DevicesTable } from '../components/device/DevicesTable'
import { SettingsParamsTab } from '../components/settings/SettingsParamsTab'
import { auth, dashboard, energy, system } from '../lib/api'
import { formatShortDateTime } from '../lib/format'
import { getSocket } from '../lib/socket'
import { useXiaomiRememberedCredentials } from '../hooks/useXiaomiRememberedCredentials'
import {
  ROLE_OPTIONS,
  DEVICE_PROVIDER_OPTIONS,
  API_SYNC_OPTIONS,
  LAN_DISCOVERY_OPTIONS,
  LAN_DISCOVERY_GUIDE,
  getRoleLabel,
  readXiaomiVerificationPending,
  writeXiaomiVerificationPending,
} from '../lib/system-settings-options'
import { DeviceCategory, UserRole, DEVICE_CATEGORY_LABEL, inferDeviceCategory, type DashboardSummary, type SystemSettingsData, type UserManagementItem } from '../types'
import { useAuthStore } from '../store/auth'
import { cn } from '@/lib/utils'

export function SystemSettingsPage() {
  const queryClient = useQueryClient()
  const { hasPermission, isAuthenticated, token, user } = useAuthStore()
  const canEdit = hasPermission([UserRole.ADMIN, UserRole.BOSS])
  const canManageDevices = hasPermission([UserRole.ADMIN, UserRole.BOSS])
  const canManageXiaomi = hasPermission([UserRole.ADMIN, UserRole.BOSS])
  const canManageUsers = hasPermission([UserRole.ADMIN])
  const canQueryProtectedApi = isAuthenticated && !!token

  const [formData, setFormData] = useState<Partial<SystemSettingsData>>({})
  const [saving, setSaving] = useState(false)
  const [bulkLimitSaving, setBulkLimitSaving] = useState(false)

  const [xiaomiLogging, setXiaomiLogging] = useState(false)
  const [, setXiaomiSyncing] = useState(false)
  void setXiaomiSyncing
  const { credentials: xiaomiRemember, persist: persistXiaomiRemember, clear: clearXiaomiRemember } =
    useXiaomiRememberedCredentials('main')
  const { credentials: xiaomiExtraRemember, persist: persistXiaomiExtraRemember, clear: clearXiaomiExtraRemember } =
    useXiaomiRememberedCredentials('camera')
  const [xiaomiUsername, setXiaomiUsername] = useState(xiaomiRemember.username)
  const [xiaomiPassword, setXiaomiPassword] = useState(xiaomiRemember.password)
  const [xiaomiExtraUsername, setXiaomiExtraUsername] = useState(xiaomiExtraRemember.username)
  const [xiaomiExtraPassword, setXiaomiExtraPassword] = useState(xiaomiExtraRemember.password)
  const [xiaomiRegion, setXiaomiRegion] = useState<string>('cn')
  useEffect(() => {
    setXiaomiUsername(xiaomiRemember.username)
    setXiaomiPassword(xiaomiRemember.password)
  }, [xiaomiRemember.username, xiaomiRemember.password])
  useEffect(() => {
    setXiaomiExtraUsername(xiaomiExtraRemember.username)
    setXiaomiExtraPassword(xiaomiExtraRemember.password)
  }, [xiaomiExtraRemember.username, xiaomiExtraRemember.password])
  const [xiaomiEmailCode, setXiaomiEmailCode] = useState('')
  const [xiaomiExtraEmailCode, setXiaomiExtraEmailCode] = useState('')
  const [verificationPending, setVerificationPending] = useState(false)
  const [extraVerificationPending, setExtraVerificationPending] = useState(false)
  const [deviceProvider, setDeviceProvider] =
    useState<(typeof DEVICE_PROVIDER_OPTIONS)[number]['value']>('xiaomi')
  const [apiSyncProvider, setApiSyncProvider] =
    useState<(typeof API_SYNC_OPTIONS)[number]['value']>('tuya_cloud')
  const [apiBaseUrl, setApiBaseUrl] = useState('')
  const [apiAccessKey, setApiAccessKey] = useState('')
  const [apiAccessSecret, setApiAccessSecret] = useState('')
  const [apiSyncStatus, setApiSyncStatus] = useState('未连接')
  const lanDiscoveryMode = 'miot_lan' as const
  const [lanSubnet, setLanSubnet] = useState('')
  const [lanVendorRemoteApi, setLanVendorRemoteApi] = useState(true)
  const [lanScanning, setLanScanning] = useState(false)
  const [lanDiscoveryStatus, setLanDiscoveryStatus] = useState('未开始识别')
  const [lanDiscoveredCount, setLanDiscoveredCount] = useState<number | null>(null)
  const [lanDevices, setLanDevices] = useState<
    Array<{
      id: string
      name: string | null
      ip: string
      mac?: string
      vendor?: string
      hostname?: string
      isLocalhost?: boolean
      added: boolean
      pingAlive?: boolean
      fromArp?: boolean
      siteId?: string
      category: DeviceCategory
      categoryLabel: string
    }>
  >([])
  const [accountDevices, setAccountDevices] = useState<
    Array<{
      id: string
      name: string | null
      model?: string
      provider: string
      added: boolean
      sourceRegion?: string
      sourceScope?: 'main' | 'camera'
    }>
  >([])
  const [accountSyncing, setAccountSyncing] = useState(false)
  const [apiDevices, setApiDevices] = useState<
    Array<{
      id: string
      name: string | null
      model?: string
      provider: string
      added: boolean
    }>
  >([])
  const [apiPulling, setApiPulling] = useState(false)
  const [lanHelpOpen, setLanHelpOpen] = useState(false)
  const [accountHelpOpen, setAccountHelpOpen] = useState(false)
  const [apiHelpOpen, setApiHelpOpen] = useState(false)
  const verificationWindowRef = useRef<Window | null>(null)
  const verificationRetryingRef = useRef(false)
  const lanDevicesRef = useRef<
    Array<{
      id: string
      name: string | null
      ip: string
      mac?: string
      vendor?: string
      hostname?: string
      isLocalhost?: boolean
      added: boolean
      pingAlive?: boolean
      fromArp?: boolean
      siteId?: string
      category: DeviceCategory
      categoryLabel: string
    }>
  >([])
  const [newUserForm, setNewUserForm] = useState({
    username: '',
    password: '',
    name: '',
    role: UserRole.BOSS as UserRole,
  })
  const [userDrafts, setUserDrafts] = useState<
    Record<string, { name: string; role: UserRole; password: string }>
  >({})

  const { data: settings, isLoading } = useQuery({
    queryKey: ['system-settings'],
    queryFn: system.getSettings,
    enabled: canQueryProtectedApi,
    retry: false,
  })

  const { data: xiaomiStatus, refetch: refetchXiaomiStatus } = useQuery({
    queryKey: ['xiaomi-status'],
    queryFn: system.xiaomiStatus,
    enabled: canQueryProtectedApi,
    retry: false,
    refetchInterval: canQueryProtectedApi ? 15000 : false,
  })

  const { data: xiaomiExtraStatus, refetch: refetchXiaomiExtraStatus } = useQuery({
    queryKey: ['xiaomi-camera-status'],
    queryFn: system.xiaomiCameraStatus,
    enabled: canQueryProtectedApi && canManageXiaomi,
    retry: false,
    refetchInterval: canQueryProtectedApi && canManageXiaomi ? 15000 : false,
  })

  const { data: dashboardSummary } = useQuery<DashboardSummary>({
    queryKey: ['dashboard'],
    queryFn: () => dashboard.get(),
    enabled: canQueryProtectedApi,
    refetchInterval: canQueryProtectedApi ? 5000 : false,
    refetchIntervalInBackground: true,
    staleTime: 1000 * 10,
  })

  const { data: sites = [] } = useQuery({
    queryKey: ['system-sites'],
    queryFn: () => system.getSites(),
    enabled: canQueryProtectedApi,
    staleTime: 1000 * 60,
  })

  const { data: users = [] } = useQuery({
    queryKey: ['auth-users'],
    queryFn: auth.listUsers,
    enabled: canQueryProtectedApi && canManageUsers,
    retry: false,
  })

  useEffect(() => {
    if (!canQueryProtectedApi) return

    const socket = getSocket()
    const handler = (data: unknown) => {
      queryClient.setQueryData(['dashboard'], data)
    }

    socket.on('dashboard', handler)
    return () => {
      socket.off('dashboard', handler)
    }
  }, [canQueryProtectedApi, queryClient])

  useEffect(() => {
    if (xiaomiStatus?.username && !xiaomiUsername) {
      setXiaomiUsername(xiaomiStatus.username)
    }
  }, [xiaomiStatus?.username, xiaomiUsername])

  useEffect(() => {
    if (xiaomiExtraStatus?.username && !xiaomiExtraUsername) {
      setXiaomiExtraUsername(xiaomiExtraStatus.username)
    }
  }, [xiaomiExtraStatus?.username, xiaomiExtraUsername])

  useEffect(() => {
    if (!users.length) return

    setUserDrafts((prev) => {
      const next: Record<string, { name: string; role: UserRole; password: string }> = {}
      users.forEach((item) => {
        next[item.id] = {
          name: prev[item.id]?.name ?? item.name,
          role: prev[item.id]?.role ?? item.role,
          password: '',
        }
      })
      return next
    })
  }, [users])

  useEffect(() => {
    const pendingFromServer = !!xiaomiStatus?.auth?.needsVerification
    const pendingFromStorage = readXiaomiVerificationPending()

    if (xiaomiStatus?.loggedIn) {
      setVerificationPending(false)
      writeXiaomiVerificationPending(false)
      return
    }

    if (pendingFromServer || pendingFromStorage) {
      setVerificationPending(true)
      writeXiaomiVerificationPending(true)
      return
    }

    setVerificationPending(false)
    writeXiaomiVerificationPending(false)
  }, [xiaomiStatus?.auth?.needsVerification, xiaomiStatus?.loggedIn])

  useEffect(() => {
    setExtraVerificationPending(!!xiaomiExtraStatus?.auth?.needsVerification && !xiaomiExtraStatus?.loggedIn)
  }, [xiaomiExtraStatus?.auth?.needsVerification, xiaomiExtraStatus?.loggedIn])

  useEffect(() => {
    if (!verificationPending) return
    if (xiaomiStatus?.auth?.verificationMethod === 'email_code') return

    const shouldRetryImmediately =
      !verificationWindowRef.current && !!xiaomiStatus?.auth?.needsVerification

    const retryLoginAfterVerification = async () => {
      if (verificationRetryingRef.current) return
      verificationRetryingRef.current = true
      setXiaomiLogging(true)
      try {
        const result = await system.xiaomiContinueLogin()
        if (result.loggedIn) {
          setVerificationPending(false)
          verificationWindowRef.current = null
          writeXiaomiVerificationPending(false)
          toast.success('米家账号登录成功')
          setXiaomiPassword('')
          void refetchXiaomiStatus()
        }
      } catch {
        const statusResult = await refetchXiaomiStatus()
        if (!statusResult.data?.auth?.needsVerification) {
          setVerificationPending(false)
          writeXiaomiVerificationPending(false)
        }
      } finally {
        setXiaomiLogging(false)
        verificationRetryingRef.current = false
      }
    }

    const handleFocus = () => {
      void retryLoginAfterVerification()
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void retryLoginAfterVerification()
      }
    }

    const timer = window.setInterval(() => {
      if (verificationWindowRef.current?.closed) {
        void retryLoginAfterVerification()
      }
    }, 1500)

    if (shouldRetryImmediately) {
      void retryLoginAfterVerification()
    }

    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [verificationPending, refetchXiaomiStatus, xiaomiPassword, xiaomiUsername, xiaomiStatus?.auth?.needsVerification, xiaomiStatus?.auth?.verificationMethod])

  const updateSettingsMutation = useMutation({
    mutationFn: (data: Partial<SystemSettingsData>) =>
      system.updateSettings(data),
    onSuccess: () => {
      toast.success('操作成功')
      queryClient.invalidateQueries({ queryKey: ['system-settings'] })
    },
    onError: (error: Error) => {
      toast.error(error?.message || '操作失败')
    },
    onSettled: () => {
      setSaving(false)
    },
  })

  const refreshReferencePriceMutation = useMutation({
    mutationFn: (data: {
      region?: string
      businessTimezone?: string
      autoEnabled?: boolean
    }) => system.refreshReferencePrice(data),
    onSuccess: (result) => {
      setFormData((prev) => ({
        ...prev,
        pricePerKwh: result.pricePerKwh,
        priceAutoRegion: result.priceAutoRegion,
        priceAutoSource: result.priceAutoSource,
        priceAutoLastUpdatedAt: result.priceAutoLastUpdatedAt,
        priceAutoEnabled: result.priceAutoEnabled,
      }))
      queryClient.invalidateQueries({ queryKey: ['system-settings'] })
      toast.success('参考电价已更新')
    },
    onError: (error: Error) => {
      toast.error(error?.message || '获取参考电价失败')
    },
  })

  const createUserMutation = useMutation({
    mutationFn: auth.createUser,
    onSuccess: () => {
      toast.success('账号已创建')
      queryClient.invalidateQueries({ queryKey: ['auth-users'] })
      setNewUserForm({
        username: '',
        password: '',
        name: '',
        role: UserRole.BOSS,
      })
    },
    onError: (error: Error) => {
      toast.error(error?.message || '创建账号失败')
    },
  })

  const updateUserMutation = useMutation({
    mutationFn: ({ userId, data }: { userId: string; data: { name?: string; role?: UserRole; password?: string } }) =>
      auth.updateUser(userId, data),
    onSuccess: (_data, variables) => {
      toast.success('账号已更新')
      queryClient.invalidateQueries({ queryKey: ['auth-users'] })
      setUserDrafts((prev) => ({
        ...prev,
        [variables.userId]: {
          ...prev[variables.userId],
          password: '',
        },
      }))
    },
    onError: (error: Error) => {
      toast.error(error?.message || '更新账号失败')
    },
  })

  const deleteUserMutation = useMutation({
    mutationFn: auth.deleteUser,
    onSuccess: () => {
      toast.success('账号已删除')
      queryClient.invalidateQueries({ queryKey: ['auth-users'] })
    },
    onError: (error: Error) => {
      toast.error(error?.message || '删除账号失败')
    },
  })

  const persistLanDevicesMutation = useMutation({
    mutationFn: (items: Parameters<typeof system.persistLanDevices>[0]) => system.persistLanDevices(items),
    onSuccess: (res) => {
      const parts: string[] = []
      if (res.persisted > 0) parts.push(`新增 ${res.persisted}`)
      if ((res.updated ?? 0) > 0) parts.push(`更新 ${res.updated}`)
      if ((res.skipped ?? 0) > 0) parts.push(`跳过（无MAC） ${res.skipped}`)
      if ((res.failed ?? 0) > 0) parts.push(`失败 ${res.failed}`)
      const catParts = Object.entries(res.categorySummary ?? {})
        .filter(([, n]) => (n as number) > 0)
        .map(([c, n]) => `${DEVICE_CATEGORY_LABEL[c as DeviceCategory] ?? c} ${n}`)
      if ((res.failed ?? 0) === 0) {
        toast.success(`本地设备已写入：${parts.join(' · ') || '未做任何修改'}${catParts.length ? `；分类：${catParts.join('、')}` : ''}`)
      } else {
        const errorPreview = Array.isArray(res.errors) && res.errors.length > 0
          ? res.errors.slice(0, 3).map((e: any) => `${e.mac ? `${e.mac}@${e.ip}` : e.ip}：${e.message}`).join('；')
          : ''
        toast.warning(`部分设备写入异常：${parts.join(' · ')}${catParts.length ? `；分类：${catParts.join('、')}` : ''}${errorPreview ? `。前 3 条：${errorPreview}` : ''}`)
      }
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      queryClient.invalidateQueries({ queryKey: ['devices'] })
    },
    onError: (error: Error) => {
      toast.error(`写入本地设备失败：${error?.message || '未知错误'}`)
    },
  })

  const getValue = <K extends keyof SystemSettingsData>(
    key: K,
    fallback?: SystemSettingsData[K]
  ): SystemSettingsData[K] | undefined => {
    if (formData[key] !== undefined) {
      return formData[key]
    }
    if (settings) {
      return settings[key]
    }
    return fallback
  }

  const getPercentValue = (
    key: 'alarmRatio80' | 'alarmRatio90' | 'alarmRatio95',
    fallbackRatio: number,
  ) => {
    const ratio = Number(getValue(key, fallbackRatio) ?? fallbackRatio)
    if (Number.isNaN(ratio)) return ''
    return ratio <= 1 ? ratio * 100 : ratio
  }

  const setValue = <K extends keyof SystemSettingsData>(
    key: K,
    value: SystemSettingsData[K]
  ) => {
    setFormData((prev) => ({ ...prev, [key]: value }))
  }

  const handleSave = () => {
    if (!settings) return
    const merged: Partial<SystemSettingsData> = { ...settings, ...formData }
    setSaving(true)
    updateSettingsMutation.mutate(merged)
  }

  const handleApplyDefaultDailyLimit = async () => {
    const dailyLimit = Number(getValue('defaultDailyLimitKwh', 10) ?? 10)
    const useWeeklyRules = !!getValue('defaultDailyLimitUseWeeklyRules', false)
    const weekdayLimit = Number(getValue('defaultDailyLimitWeekdayKwh', dailyLimit) ?? dailyLimit)
    const saturdayLimit = Number(getValue('defaultDailyLimitSaturdayKwh', dailyLimit) ?? dailyLimit)
    const sundayLimit = Number(getValue('defaultDailyLimitSundayKwh', dailyLimit) ?? dailyLimit)
    const holidayLimit = Number(getValue('defaultDailyLimitHolidayKwh', dailyLimit) ?? dailyLimit)
    const holidayDates = String(getValue('defaultDailyLimitHolidayDates', '') ?? '').trim()
    if (!Number.isFinite(dailyLimit) || dailyLimit < 0) {
      toast.error('请输入有效的通用日限额')
      return
    }
    if (
      !Number.isFinite(weekdayLimit) || weekdayLimit < 0 ||
      !Number.isFinite(saturdayLimit) || saturdayLimit < 0 ||
      !Number.isFinite(sundayLimit) || sundayLimit < 0 ||
      !Number.isFinite(holidayLimit) || holidayLimit < 0
    ) {
      toast.error('星期规则和节假日限额必须是非负数字')
      return
    }

    setBulkLimitSaving(true)
    try {
      const scheduleSettings: Partial<SystemSettingsData> = {
        defaultDailyLimitKwh: dailyLimit,
        defaultDailyLimitUseWeeklyRules: useWeeklyRules,
        defaultDailyLimitWeekdayKwh: weekdayLimit,
        defaultDailyLimitSaturdayKwh: saturdayLimit,
        defaultDailyLimitSundayKwh: sundayLimit,
        defaultDailyLimitUseHolidayRules: useWeeklyRules,
        defaultDailyLimitHolidayKwh: holidayLimit,
        defaultDailyLimitHolidayDates: holidayDates,
      }
      if (useWeeklyRules) {
        await system.updateSettings(scheduleSettings)
      } else {
        await Promise.all([
          system.updateSettings(scheduleSettings),
          energy.bulkUpdateLimit(dailyLimit),
        ])
      }
      toast.success(useWeeklyRules ? '限额规则已保存并立即生效' : '通用日限额已应用到全部空开')
      setFormData((prev) => ({ ...prev, ...scheduleSettings }))
      queryClient.invalidateQueries({ queryKey: ['system-settings'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      queryClient.invalidateQueries({ queryKey: ['energy-limits'] })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '批量应用通用日限额失败')
    } finally {
      setBulkLimitSaving(false)
    }
  }

  const handleRefreshReferencePrice = () => {
    refreshReferencePriceMutation.mutate({
      region: String(getValue('priceAutoRegion', '') ?? '').trim(),
      businessTimezone: String(getValue('businessTimezone', 'Europe/Vienna') ?? 'Europe/Vienna'),
      autoEnabled: Boolean(getValue('priceAutoEnabled', false)),
    })
  }

  const formatDateTimeShort = (value: string | undefined) => {
    if (!value) return ''
    const time = Date.parse(value)
    if (Number.isNaN(time)) return ''
    return formatShortDateTime(time)
  }

  const activeXiaomiScope = xiaomiRegion === 'cn' ? 'main' : 'camera'
  const activeXiaomiLoggedIn =
    activeXiaomiScope === 'main' ? !!xiaomiStatus?.loggedIn : !!xiaomiExtraStatus?.loggedIn
  const activeXiaomiUsername =
    activeXiaomiScope === 'main' ? xiaomiUsername : xiaomiExtraUsername
  const activeXiaomiPassword =
    activeXiaomiScope === 'main' ? xiaomiPassword : xiaomiExtraPassword
  const activeVerificationPending =
    activeXiaomiScope === 'main' ? verificationPending : extraVerificationPending
  const activeVerificationMethod =
    activeXiaomiScope === 'main'
      ? xiaomiStatus?.auth?.verificationMethod
      : xiaomiExtraStatus?.auth?.verificationMethod
  const activeNotificationUrl =
    activeXiaomiScope === 'main'
      ? xiaomiStatus?.auth?.notificationUrl
      : xiaomiExtraStatus?.auth?.notificationUrl
  const activeAuthStatus =
    activeXiaomiScope === 'main' ? xiaomiStatus?.auth : xiaomiExtraStatus?.auth
  const activeRememberEnabled =
    activeXiaomiScope === 'main' ? xiaomiRemember.enabled : xiaomiExtraRemember.enabled
  const activeRememberUsername =
    activeXiaomiScope === 'main' ? xiaomiRemember.username : xiaomiExtraRemember.username
  const activeRememberPassword =
    activeXiaomiScope === 'main' ? xiaomiRemember.password : xiaomiExtraRemember.password
  const activeCodeSentAt = activeAuthStatus?.codeSentAt ?? null
  const activeStatusMessage = activeAuthStatus?.message?.trim() || ''

  const handleCreateUser = () => {
    if (!newUserForm.username.trim() || !newUserForm.name.trim() || !newUserForm.password.trim()) {
      toast.error('请先填完整用户名、姓名和密码')
      return
    }

    createUserMutation.mutate({
      username: newUserForm.username.trim(),
      name: newUserForm.name.trim(),
      password: newUserForm.password,
      role: newUserForm.role,
    })
  }

  const handleUserDraftChange = (
    userId: string,
    patch: Partial<{ name: string; role: UserRole; password: string }>,
  ) => {
    setUserDrafts((prev) => ({
      ...prev,
      [userId]: {
        name: prev[userId]?.name ?? '',
        role: prev[userId]?.role ?? UserRole.USER,
        password: prev[userId]?.password ?? '',
        ...patch,
      },
    }))
  }

  const handleUpdateUser = (targetUser: UserManagementItem) => {
    const draft = userDrafts[targetUser.id]
    if (!draft) return

    const payload: { name?: string; role?: UserRole; password?: string } = {}
    if (draft.name.trim() && draft.name.trim() !== targetUser.name) {
      payload.name = draft.name.trim()
    }
    if (draft.role !== targetUser.role) {
      payload.role = draft.role
    }
    if (draft.password.trim()) {
      payload.password = draft.password.trim()
    }

    if (!payload.name && !payload.role && !payload.password) {
      toast.error('没有可保存的变更')
      return
    }

    updateUserMutation.mutate({
      userId: targetUser.id,
      data: payload,
    })
  }

  const handleDeleteUser = (targetUser: UserManagementItem) => {
    if (targetUser.id === user?.id) {
      toast.error('不能删除当前超级管理员自己')
      return
    }

    const confirmed = window.confirm(`确认删除账号 ${targetUser.username} 吗？`)
    if (!confirmed) return
    deleteUserMutation.mutate(targetUser.id)
  }

  const handleXiaomiLogin = async () => {
    if (activeXiaomiScope === 'camera') {
      persistXiaomiExtraRemember({
        enabled: xiaomiExtraRemember.enabled,
        username: xiaomiExtraUsername.trim(),
        password: xiaomiExtraPassword,
        region: xiaomiRegion,
      })
      setXiaomiLogging(true)
      try {
        const result = await system.xiaomiCameraLogin({
          username: xiaomiExtraUsername.trim() || undefined,
          password: xiaomiExtraPassword || undefined,
          region: xiaomiRegion,
        })
        if (result.loggedIn) {
          setExtraVerificationPending(false)
          persistXiaomiExtraRemember({
            enabled: xiaomiExtraRemember.enabled,
            username: xiaomiExtraUsername.trim(),
            password: xiaomiExtraRemember.enabled ? xiaomiExtraPassword : '',
            region: xiaomiRegion,
          })
          setXiaomiExtraPassword(xiaomiExtraRemember.enabled ? xiaomiExtraPassword : '')
          toast.success(`欧洲区米家账号登录成功 · ${xiaomiRegion.toUpperCase()}`)
        } else {
          toast.error(result.message || '欧洲区米家登录失败')
        }
        const statusResult = await refetchXiaomiExtraStatus()
        if (statusResult.data?.auth?.verificationMethod === 'email_code' && !statusResult.data?.loggedIn) {
          setExtraVerificationPending(true)
          if (!statusResult.data?.auth?.codeSentAt) {
            try {
              await system.xiaomiCameraSendEmailCode()
              await refetchXiaomiExtraStatus()
              toast.success('欧洲区账号需要邮箱验证码，已自动发送，请查收邮箱')
            } catch (sendError: unknown) {
              const sendErr = sendError as Error & { response?: { data?: { message?: string } } }
              toast.error(sendErr?.response?.data?.message || sendErr?.message || '欧洲区验证码自动发送失败，请手动点发送验证码')
            }
          } else {
            toast.error('欧洲区账号需要邮箱验证码，请查收邮箱后输入验证码')
          }
          return
        }
        if (statusResult.data?.auth?.notificationUrl && !statusResult.data?.loggedIn) {
          window.open(statusResult.data.auth.notificationUrl, 'xiaomi-extra-verification')
          setExtraVerificationPending(true)
          toast.error('请先完成浏览器验证，完成后再点一次登录或刷新状态')
        }
      } catch (error: unknown) {
        const err = error as Error & { response?: { data?: { message?: string } } }
        toast.error(err?.response?.data?.message || err?.message || '欧洲区米家登录失败')
        await refetchXiaomiExtraStatus()
      } finally {
        setXiaomiLogging(false)
      }
      return
    }

    persistXiaomiRemember({ enabled: xiaomiRemember.enabled, username: xiaomiUsername.trim(), password: xiaomiPassword, region: xiaomiRegion })
    setXiaomiLogging(true)
    try {
      const result = await system.xiaomiLogin(
        xiaomiUsername.trim() || undefined,
        xiaomiPassword || undefined,
        undefined,
        xiaomiRegion,
      )
      if (result.loggedIn) {
        toast.success(
          result.usedEnv ? '已使用服务器配置的账号登录成功' : '米家账号登录成功',
        )
        setVerificationPending(false)
        writeXiaomiVerificationPending(false)
        persistXiaomiRemember({ enabled: xiaomiRemember.enabled, username: xiaomiUsername.trim(), password: xiaomiRemember.enabled ? xiaomiPassword : '', region: xiaomiRegion })
        setXiaomiPassword(xiaomiRemember.enabled ? xiaomiPassword : '')
      } else {
        toast.error('登录失败，请检查账号配置')
      }
      const statusResult = await refetchXiaomiStatus()
      const notificationUrl = statusResult.data?.auth?.notificationUrl
      const verificationMethod = statusResult.data?.auth?.verificationMethod
      if (verificationMethod === 'email_code' && !statusResult.data?.loggedIn) {
        setVerificationPending(true)
        writeXiaomiVerificationPending(true)
        if (!statusResult.data?.auth?.codeSentAt) {
          try {
            await system.xiaomiSendEmailVerificationCode()
            await refetchXiaomiStatus()
            toast.success('当前账号需要邮箱验证码，已自动发送，请查收邮箱')
          } catch (sendError: unknown) {
            const sendErr = sendError as Error & { response?: { data?: { message?: string } } }
            toast.error(sendErr?.response?.data?.message || sendErr?.message || '验证码自动发送失败，请手动点发送验证码')
          }
        } else {
          toast.error('当前账号需要邮箱验证码，请查收邮箱后输入验证码')
        }
        return
      }
      if (notificationUrl && !statusResult.data?.loggedIn) {
        verificationWindowRef.current = window.open(notificationUrl, 'xiaomi-verification')
        setVerificationPending(true)
        writeXiaomiVerificationPending(true)
        toast.error('请在验证页完成验证，返回此页后系统会自动继续登录')
      }
    } catch (error: unknown) {
      const err = error as Error & { response?: { data?: { message?: string } } }
      const statusResult = await refetchXiaomiStatus()
      const notificationUrl = statusResult.data?.auth?.notificationUrl
      const verificationMethod = statusResult.data?.auth?.verificationMethod
      if (verificationMethod === 'email_code' && !statusResult.data?.loggedIn) {
        setVerificationPending(true)
        writeXiaomiVerificationPending(true)
        if (!statusResult.data?.auth?.codeSentAt) {
          try {
            await system.xiaomiSendEmailVerificationCode()
            await refetchXiaomiStatus()
            toast.success('当前账号需要邮箱验证码，已自动发送，请查收邮箱')
          } catch (sendError: unknown) {
            const sendErr = sendError as Error & { response?: { data?: { message?: string } } }
            toast.error(sendErr?.response?.data?.message || sendErr?.message || '验证码自动发送失败，请手动点发送验证码')
          }
        } else {
          toast.error('当前账号需要邮箱验证码，请查收邮箱后输入验证码')
        }
        return
      }
      if (notificationUrl && !statusResult.data?.loggedIn) {
        verificationWindowRef.current = window.open(notificationUrl, 'xiaomi-verification')
        setVerificationPending(true)
        writeXiaomiVerificationPending(true)
        toast.error('请在验证页完成验证，返回此页后系统会自动继续登录')
        return
      }
      toast.error(err?.response?.data?.message || err?.message || '操作失败')
    } finally {
      setXiaomiLogging(false)
    }
  }

  const handleXiaomiSendEmailCode = async () => {
    if (activeXiaomiScope === 'camera') {
      setXiaomiLogging(true)
      try {
        const result = await system.xiaomiCameraSendEmailCode()
        if (result.sent) {
          setExtraVerificationPending(true)
          await refetchXiaomiExtraStatus()
          toast.success('欧洲区米家验证码已发送，请查收邮箱')
          return
        }
        toast.error('欧洲区米家验证码发送失败')
      } catch (error: unknown) {
        const err = error as Error & { response?: { data?: { message?: string } } }
        toast.error(err?.response?.data?.message || err?.message || '欧洲区米家验证码发送失败')
      } finally {
        setXiaomiLogging(false)
      }
      return
    }

    setXiaomiLogging(true)
    try {
      const result = await system.xiaomiSendEmailVerificationCode()
      if (result.sent) {
        setVerificationPending(true)
        writeXiaomiVerificationPending(true)
        await refetchXiaomiStatus()
        toast.success('米家验证码已发送，请查收邮箱')
        return
      }
      toast.error('米家验证码发送失败')
    } catch (error: unknown) {
      const err = error as Error & { response?: { data?: { message?: string } } }
      toast.error(err?.response?.data?.message || err?.message || '米家验证码发送失败')
    } finally {
      setXiaomiLogging(false)
    }
  }

  const handleXiaomiVerifyEmailCode = async () => {
    if (activeXiaomiScope === 'camera') {
      if (!xiaomiExtraEmailCode.trim()) {
        toast.error('请先输入欧洲区邮箱验证码')
        return
      }
      setXiaomiLogging(true)
      try {
        const result = await system.xiaomiCameraVerifyEmailCode(xiaomiExtraEmailCode.trim())
        if (result.loggedIn) {
          setExtraVerificationPending(false)
          setXiaomiExtraEmailCode('')
          persistXiaomiExtraRemember({
            enabled: xiaomiExtraRemember.enabled,
            username: xiaomiExtraUsername.trim(),
            password: xiaomiExtraRemember.enabled ? xiaomiExtraPassword : '',
            region: xiaomiRegion,
          })
          setXiaomiExtraPassword(xiaomiExtraRemember.enabled ? xiaomiExtraPassword : '')
          await refetchXiaomiExtraStatus()
          toast.success(`欧洲区米家账号登录成功 · ${xiaomiRegion.toUpperCase()}`)
          return
        }
        toast.error(result.message || '欧洲区米家验证码校验失败')
      } catch (error: unknown) {
        const err = error as Error & { response?: { data?: { message?: string } } }
        setExtraVerificationPending(true)
        toast.error(err?.response?.data?.message || err?.message || '欧洲区米家验证码校验失败')
        await refetchXiaomiExtraStatus()
      } finally {
        setXiaomiLogging(false)
      }
      return
    }

    if (!xiaomiEmailCode.trim()) {
      toast.error('请先输入邮箱验证码')
      return
    }

    setXiaomiLogging(true)
    try {
      const result = await system.xiaomiVerifyEmailCode(xiaomiEmailCode.trim())
      if (result.loggedIn) {
        setVerificationPending(false)
        verificationWindowRef.current = null
        setXiaomiEmailCode('')
        persistXiaomiRemember({ enabled: xiaomiRemember.enabled, username: xiaomiUsername.trim(), password: xiaomiRemember.enabled ? xiaomiPassword : '', region: xiaomiRegion })
        setXiaomiPassword(xiaomiRemember.enabled ? xiaomiPassword : '')
        writeXiaomiVerificationPending(false)
        await refetchXiaomiStatus()
        toast.success('米家账号登录成功')
        return
      }
      toast.error('米家验证码校验失败')
    } catch (error: unknown) {
      const err = error as Error & { response?: { data?: { message?: string } } }
      setVerificationPending(true)
      toast.error(err?.response?.data?.message || err?.message || '米家验证码校验失败')
      await refetchXiaomiStatus()
    } finally {
      setXiaomiLogging(false)
    }
  }

  const handleXiaomiContinue = async () => {
    if (activeXiaomiScope === 'camera') {
      setXiaomiLogging(true)
      try {
        const result = await system.xiaomiCameraContinueLogin()
        if (result.loggedIn) {
          setExtraVerificationPending(false)
          await refetchXiaomiExtraStatus()
          toast.success(`欧洲区米家账号登录成功 · ${xiaomiRegion.toUpperCase()}`)
          return
        }
        toast.error(result.message || '欧洲区浏览器验证尚未完成')
        await refetchXiaomiExtraStatus()
      } catch (error: unknown) {
        const err = error as Error & { response?: { data?: { message?: string } } }
        setExtraVerificationPending(true)
        toast.error(err?.response?.data?.message || err?.message || '欧洲区继续登录失败')
        await refetchXiaomiExtraStatus()
      } finally {
        setXiaomiLogging(false)
      }
      return
    }

    setXiaomiLogging(true)
    try {
      const result = await system.xiaomiContinueLogin()
      if (result.loggedIn) {
        setVerificationPending(false)
        verificationWindowRef.current = null
        writeXiaomiVerificationPending(false)
        persistXiaomiRemember({ enabled: xiaomiRemember.enabled, username: xiaomiUsername.trim(), password: xiaomiRemember.enabled ? xiaomiPassword : '', region: xiaomiRegion })
        setXiaomiPassword(xiaomiRemember.enabled ? xiaomiPassword : '')
        await refetchXiaomiStatus()
        toast.success('米家账号登录成功')
        return
      }
      toast.error('仍未完成米家验证')
    } catch (error: unknown) {
      const err = error as Error & { response?: { data?: { message?: string } } }
      toast.error(err?.response?.data?.message || err?.message || '米家继续登录失败')
      await refetchXiaomiStatus()
    } finally {
      setXiaomiLogging(false)
    }
  }

  const handleOpenXiaomiVerificationPage = async () => {
    const openTarget = (url: string) => {
      window.open(
        url,
        activeXiaomiScope === 'main' ? 'xiaomi-verification' : 'xiaomi-extra-verification',
      )
      if (activeXiaomiScope === 'main') {
        setVerificationPending(true)
        writeXiaomiVerificationPending(true)
      } else {
        setExtraVerificationPending(true)
      }
    }

    setXiaomiLogging(true)
    try {
      if (activeXiaomiScope === 'camera') {
        await refetchXiaomiExtraStatus()
        const username = xiaomiExtraUsername.trim()
        if (!username || !xiaomiExtraPassword) {
          toast.error('请先填写欧洲区账号密码，再获取新的验证链接')
          return
        }
        await system.xiaomiCameraLogin({
          username,
          password: xiaomiExtraPassword,
          region: xiaomiRegion,
        })
        const statusResult = await refetchXiaomiExtraStatus()
        const freshUrl = statusResult.data?.auth?.notificationUrl
        if (freshUrl) {
          openTarget(freshUrl)
          toast.success('已获取新的欧洲区验证链接')
          return
        }
        toast.error(statusResult.data?.auth?.message || '未获取到新的欧洲区验证链接')
        return
      }

      const username = xiaomiUsername.trim()
      if (!username || !xiaomiPassword) {
        toast.error('请先填写账号密码，再获取新的验证链接')
        return
      }
      await system.xiaomiLogin(
        username,
        xiaomiPassword,
        undefined,
        xiaomiRegion,
      )
      const statusResult = await refetchXiaomiStatus()
      const freshUrl = statusResult.data?.auth?.notificationUrl
      if (freshUrl) {
        openTarget(freshUrl)
        toast.success('已获取新的验证链接')
        return
      }
      toast.error(statusResult.data?.auth?.message || '未获取到新的验证链接')
    } catch (error: unknown) {
      const err = error as Error & { response?: { data?: { message?: string; auth?: { notificationUrl?: string | null } } } }
      const statusResult =
        activeXiaomiScope === 'camera'
          ? await refetchXiaomiExtraStatus()
          : await refetchXiaomiStatus()
      const freshUrl = statusResult.data?.auth?.notificationUrl
      if (freshUrl) {
        openTarget(freshUrl)
        toast.success('已刷新验证状态，请在新页面完成验证')
        return
      }
      toast.error(
        statusResult.data?.auth?.message ||
        err?.response?.data?.message ||
        err?.message ||
        '获取验证链接失败',
      )
    } finally {
      setXiaomiLogging(false)
    }
  }

  const handleXiaomiSync = async () => {
    setXiaomiSyncing(true)
    try {
      await system.xiaomiSync()
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['xiaomi-status'] }),
      ])
      toast.success('设备已同步到系统')
    } catch (error: unknown) {
      const err = error as Error
      toast.error(err?.message || '操作失败')
    } finally {
      setXiaomiSyncing(false)
    }
  }

  const handleDeviceProviderLogin = async () => {
    if (deviceProvider !== 'xiaomi') {
      toast.info('涂鸦入口先保留在这里，当前这版后台还没接通真实登录。')
      return
    }
    await handleXiaomiLogin()
  }

  const handleDeviceProviderSync = async () => {
    if (deviceProvider !== 'xiaomi') {
      toast.info('涂鸦入口先保留在这里，当前这版后台还没接通真实设备同步。')
      return
    }
    await handleXiaomiSync()
  }
  void handleDeviceProviderSync

  const handleApiSyncConnect = () => {
    const providerLabel =
      API_SYNC_OPTIONS.find((item) => item.value === apiSyncProvider)?.label ?? '云厂商'
    const requiresBaseUrl = apiSyncProvider !== 'tuya_cloud'

    if (requiresBaseUrl && !apiBaseUrl.trim()) {
      toast.error('请先填写 API 地址')
      return
    }

    if (!apiAccessKey.trim() || !apiAccessSecret.trim()) {
      toast.error('请先填写 Access Key 和 Access Secret')
      return
    }

    setApiSyncStatus(`已填写${providerLabel}接入信息，等待后端接通`)
    toast.info(`${providerLabel} 云接口已经留好，下一步接后端鉴权和设备拉取。`)
  }

  const handleLanDiscovery = async () => {
    const modeLabel =
      LAN_DISCOVERY_OPTIONS.find((item) => item.value === lanDiscoveryMode)?.label ?? '局域网识别'
    const lanGuide = LAN_DISCOVERY_GUIDE[lanDiscoveryMode]
    if (!lanSubnet.trim()) {
      toast.error(lanGuide.emptyError)
      return
    }
    if (lanScanning) return

    const controller = new AbortController()
    const frontendGuard = setTimeout(() => {
      try { controller.abort() } catch { /* noop */ }
      setLanScanning(false)
      setLanDiscoveryStatus('前端强制超时停止（已等待 90 秒）')
      toast.error('局域网扫描等待 90 秒无响应，已自动停止。请减少掩码范围、或检查后端服务是否正常运行')
    }, 90_000)

    setLanScanning(true)
    setLanDiscoveryStatus(`${modeLabel}扫描中...`)
    setLanDiscoveredCount(0)
    setLanDevices([])
    lanDevicesRef.current = []
    toast.info(
      lanVendorRemoteApi
        ? `开始真实扫描 ${lanSubnet.trim()}（将尝试用公开 API 补全厂商名，可能变慢），请耐心等待...`
        : `开始真实扫描 ${lanSubnet.trim()}，请耐心等待...`,
    )

    try {
      const res = await system.lanScan(lanSubnet.trim(), { withVendorRemoteApi: lanVendorRemoteApi })
      const mapped = res.devices.map((d, idx) => {
        const fallbackName = d.hostname || d.name || d.vendor || null
        const rawMac = String(d.mac ?? '').trim().toUpperCase().replace(/[^A-F0-9]/g, '')
        const category = inferDeviceCategory({
          name: fallbackName,
          model: d.vendor ?? null,
          vendor: d.vendor ?? null,
          mac: rawMac.length === 12 ? rawMac : null,
          ip: d.ip ?? null,
        })
        return {
          id: `lan-scan-${Date.now()}-${idx.toString().padStart(3, '0')}`,
          name: fallbackName,
          hostname: d.hostname || undefined,
          ip: d.ip,
          mac: d.mac || undefined,
          vendor: d.vendor || undefined,
          isLocalhost: false,
          added: false,
          pingAlive: d.pingAlive,
          fromArp: d.fromArp,
          category,
          categoryLabel: DEVICE_CATEGORY_LABEL[category] ?? '其他智能设备',
        }
      })
      lanDevicesRef.current = mapped
      setLanDevices(mapped)
      setLanDiscoveredCount(mapped.length)
      const arpOnly = mapped.filter((d) => d.fromArp && !d.pingAlive).length
      const tcpPart = typeof res.tcpTriggered === 'number' ? `，TCP 触发 ${res.tcpTriggered} 个 IP` : ''
      const udpPart = typeof res.udpTriggered === 'number' && res.udpTriggered > 0 ? `，UDP 触发 ${res.udpTriggered} 个漏网 IP` : ''
      const passesPart = typeof res.arpPasses === 'number' ? `，ARP 表累计读了 ${res.arpPasses} 轮` : ''
      setLanDiscoveryStatus(
        `${modeLabel}完成：共探测 ${res.totalTried} 个 IP${tcpPart}${udpPart}${passesPart}，Ping 存活 ${res.aliveCount} 台，ARP 表读取 ${res.arpCount} 条，总计 ${mapped.length} 台（其中 ARP 缓存但未回 Ping 的设备 ${arpOnly} 台）`,
      )
      toast.success(
        `扫描完成：已在 ${res.base} 发现 ${mapped.length} 个网络可见地址（Ping 在线 ${res.aliveCount} 台）`,
      )
    } catch (err: any) {
      const e = err as Error & {
        code?: string
        httpStatus?: number
        isAxiosTimeout?: boolean
        isCanceled?: boolean
      }
      const rawMsg = (e?.message as string) || String(err) || '未知错误'
      const isProxyAborted = typeof rawMsg === 'string' && rawMsg.includes('ERR_ABORTED')
      const isTimeout = !!e?.isAxiosTimeout || isProxyAborted || /timeout|超过|time.?out/i.test(rawMsg || '')
      if (isTimeout) {
        setLanDiscoveryStatus(`${modeLabel}超时`)
      } else {
        setLanDiscoveryStatus(`${modeLabel}失败`)
      }
      setLanDiscoveredCount(0)
      setLanDevices([])
      lanDevicesRef.current = []
      if (isProxyAborted) {
        toast.error(
          '超时：局域网扫描被前端 dev server 代理中断（ERR_ABORTED）。先关掉再重新启动前端 dev server（npm --prefix client run dev）让 vite.config.ts 里新的 180 秒代理生效。',
          { duration: 9000 },
        )
        return
      }
      if (e?.isAxiosTimeout && typeof e.httpStatus === 'number' && e.httpStatus >= 500 && e.httpStatus < 600) {
        toast.error(
          '超时：后端服务在 180 秒内没有返回。请确认 Node server 跑在 Windows 宿主机上（不是 WSL2/Docker NAT），并把网段缩小（例如改成 /27 只扫 30 个 IP 测试）。',
          { duration: 9000 },
        )
        return
      }
      if (e?.isAxiosTimeout) {
        toast.error(
          '超时：前端 axios 等待 180 秒仍未收到响应。这通常意味着后端 Node server 没在跑、server 跑在 NAT 里扫不到 ARP、或网段里 /16 太大。',
          { duration: 9000 },
        )
        return
      }
      if (e?.isCanceled) {
        toast.error('已停止扫描', { duration: 3000 })
        return
      }
      toast.error(`局域网扫描失败：${rawMsg}`)
    } finally {
      clearTimeout(frontendGuard)
      setLanScanning(false)
    }
  }

  const handleAddLanDevice = async (deviceId: string, siteId: string) => {
    const device = lanDevices.find((d) => d.id === deviceId)
    if (!device) return
    try {
      const res = await persistLanDevicesMutation.mutateAsync([
        {
          ip: device.ip,
          mac: device.mac ?? null,
          vendor: device.vendor ?? null,
          name: device.name ?? null,
          hostname: device.hostname ?? null,
          status: device.pingAlive ? 'online' : device.fromArp ? 'unknown' : 'offline',
          siteId: siteId || null,
          roomId: null,
        },
      ])
      if (res.dids?.length > 0) {
        setLanDevices((prev) =>
          prev.map((d) => (d.id === deviceId ? { ...d, added: true, siteId } : d)),
        )
      } else if ((res.failed ?? 0) > 0 && Array.isArray(res.errors)) {
        toast.error(`写入失败：${res.errors.map((e: any) => e.message).join('；')}`)
      }
    } catch (err) {
      setLanDevices((prev) =>
        prev.map((d) => (d.id === deviceId ? { ...d, added: false } : d)),
      )
    }
  }

  const handleLanSyncAll = async () => {
    const pending = lanDevices.filter((d) => !d.added)
    if (pending.length === 0) {
      toast.info('没有需要同步的设备')
      return
    }
    const defaultSiteId = (sites.find((s) => s.isPrimary)?.id ?? sites[0]?.id) || undefined
    const pendingIdSet = new Set(pending.map((d) => d.id))
    const idToMac = new Map<string, string>(
      pending
        .map((d): [string, string] | null => {
          const rawMac = String(d.mac ?? '').trim().toUpperCase().replace(/[^A-F0-9]/g, '')
          if (rawMac.length !== 12) return null
          return [d.id, `LAN_${rawMac}`]
        })
        .filter((v): v is [string, string] => v !== null),
    )
    try {
      const res = await persistLanDevicesMutation.mutateAsync(
        pending.map((d) => ({
          ip: d.ip,
          mac: d.mac ?? null,
          vendor: d.vendor ?? null,
          name: d.name ?? null,
          hostname: d.hostname ?? null,
          status: d.pingAlive ? 'online' : d.fromArp ? 'unknown' : 'offline',
          siteId: (d.siteId || defaultSiteId) ?? null,
          roomId: null,
        })),
      )
      const successDids = new Set<string>(res.dids ?? [])
      setLanDevices((prev) =>
        prev.map((d) => {
          if (!pendingIdSet.has(d.id)) return d
          const did = idToMac.get(d.id)
          if (did && successDids.has(did)) return { ...d, added: true }
          return d
        }),
      )
    } catch {
      /* toast already shown in mutation */
    }
  }

  const handleAccountPullDevices = async (scope: 'main' | 'camera') => {
    const loggedIn = scope === 'main' ? !!xiaomiStatus?.loggedIn : !!xiaomiExtraStatus?.loggedIn
    if (!loggedIn) {
      toast.error(scope === 'main' ? '请先登录中国大陆账号' : '请先登录欧洲区账号')
      return
    }
    setAccountSyncing(true)
    try {
      const res = scope === 'main' ? await system.xiaomiDevices() : await system.xiaomiCameraDevices()
      const existingDidSet = new Set((dashboardSummary?.devices ?? []).map((item: any) => String(item.did ?? '')))
      const pulled = (res.devices ?? []).map((item) => ({
        id: item.did,
        name: item.name ?? null,
        model: item.model,
        provider: '米家',
        added: existingDidSet.has(item.did),
        sourceRegion: item.sourceRegion ?? res.region ?? (scope === 'main' ? 'cn' : xiaomiExtraRemember.region || 'de'),
        sourceScope: item.sourceScope ?? scope,
      }))
      setAccountDevices((prev) => {
        const merged = new Map(prev.map((item) => [item.id, item]))
        pulled.forEach((item) => merged.set(item.id, item))
        return Array.from(merged.values())
      })
      toast.success(
        `已识别 ${pulled.length} 台${scope === 'main' ? '中国大陆' : '欧洲区'}设备`,
      )
    } catch (error: unknown) {
      const err = error as Error & { response?: { data?: { message?: string } } }
      toast.error(err?.response?.data?.message || err?.message || '识别设备失败')
    } finally {
      setAccountSyncing(false)
    }
  }

  const handleAccountSyncAll = async () => {
    const pending = accountDevices.filter((d) => !d.added)
    if (pending.length === 0) {
      toast.info('没有需要同步的设备')
      return
    }
    setAccountSyncing(true)
    try {
      await system.xiaomiSync()
      setAccountDevices((prev) => prev.map((d) => ({ ...d, added: true })))
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['xiaomi-status'] }),
        queryClient.invalidateQueries({ queryKey: ['xiaomi-camera-status'] }),
      ])
      toast.success(`已同步 ${pending.length} 个已识别设备`)
    } catch (error: unknown) {
      const err = error as Error & { response?: { data?: { message?: string } } }
      toast.error(err?.response?.data?.message || err?.message || '同步设备失败')
    } finally {
      setAccountSyncing(false)
    }
  }

  const handleApiPullDevices = () => {
    setApiPulling(true)
    const providerLabel =
      API_SYNC_OPTIONS.find((p) => p.value === apiSyncProvider)?.label ?? '云厂商'
    const pulled = Array.from({ length: 6 }).map((_, i) => ({
      id: `api-${Date.now()}-${i}`,
      name: [
        '区域1总电闸',
        '走廊空气开关',
        '租客A空调插座',
        '租客B照明回路',
        '公共区照明网关',
        '楼道电表网关',
      ][i],
      model: 'TY-16A-GW',
      provider: providerLabel,
      added: false,
    }))
    setTimeout(() => {
      setApiDevices(pulled)
      setApiPulling(false)
      toast.success(`已从 ${providerLabel} 云识别到 ${pulled.length} 个设备`)
    }, 1200)
  }

  const handleApiSyncAll = () => {
    const pending = apiDevices.filter((d) => !d.added)
    if (pending.length === 0) {
      toast.info('没有需要同步的设备')
      return
    }
    setApiDevices((prev) => prev.map((d) => ({ ...d, added: true })))
    toast.success(`已同步 ${pending.length} 个 API 同步设备`)
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  }

  const lanGuide = LAN_DISCOVERY_GUIDE[lanDiscoveryMode]
  const accountStatusCards = [
    {
      scope: 'main' as const,
      title: '中国大陆',
      region: 'cn',
      loggedIn: !!xiaomiStatus?.loggedIn,
      username: xiaomiStatus?.username || xiaomiRemember.username || '-',
      lastResult:
        xiaomiStatus?.auth?.state === 'logged_in'
          ? '已登录成功'
          : xiaomiStatus?.auth?.needsVerification
            ? '需要安全验证'
            : xiaomiStatus?.auth?.state === 'error'
              ? xiaomiStatus?.auth?.message || '登录失败'
              : xiaomiStatus?.auth?.message || '等待登录',
      lastAt: formatDateTimeShort(xiaomiStatus?.auth?.lastAttemptAt || undefined),
      badgeClass:
        'bg-slate-50 text-slate-700 ring-slate-200 dark:bg-slate-900/40 dark:text-slate-300 dark:ring-slate-700/60',
    },
    {
      scope: 'camera' as const,
      title: '欧洲 / 国际',
      region: xiaomiExtraStatus?.region || xiaomiExtraRemember.region || 'de',
      loggedIn: !!xiaomiExtraStatus?.loggedIn,
      username: xiaomiExtraStatus?.username || xiaomiExtraRemember.username || '-',
      lastResult:
        xiaomiExtraStatus?.auth?.state === 'logged_in'
          ? '已登录成功'
          : xiaomiExtraStatus?.auth?.needsVerification
            ? '需要安全验证'
            : xiaomiExtraStatus?.auth?.state === 'error'
              ? xiaomiExtraStatus?.auth?.message || '登录失败'
              : xiaomiExtraStatus?.auth?.message || '等待登录',
      lastAt: formatDateTimeShort(xiaomiExtraStatus?.auth?.lastAttemptAt || undefined),
      badgeClass:
        'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:ring-blue-800/60',
    },
  ]

  return (
    <div className="app-page app-page-stack">
      <h1 className="text-xl font-bold sm:text-2xl">
        <Settings className="mr-2 inline-block h-7 w-7" />
        系统设置
      </h1>

      {!canQueryProtectedApi ? (
        <div className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
          当前登录状态无效，请先重新登录后再进入系统设置。
        </div>
      ) : (

      <Tabs defaultValue="params" className="w-full">
        <TabsList className="mb-2.5 h-auto w-full flex-wrap justify-start">
          <TabsTrigger value="params" className="text-xs sm:text-sm">系统参数</TabsTrigger>
          {canManageDevices && <TabsTrigger value="devices" className="text-xs sm:text-sm">设备总览</TabsTrigger>}
          {canManageXiaomi && <TabsTrigger value="xiaomi" className="text-xs sm:text-sm">设备同步</TabsTrigger>}
          {canManageUsers && <TabsTrigger value="accounts" className="text-xs sm:text-sm">账号管理</TabsTrigger>}
        </TabsList>

        <TabsContent value="params">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">加载中...</div>
          ) : settings ? (
            <SettingsParamsTab
              getValue={getValue}
              getPercentValue={getPercentValue}
              setValue={setValue}
              canEdit={canEdit}
              saving={saving}
              bulkLimitSaving={bulkLimitSaving}
              formatDateTimeShort={formatDateTimeShort}
              onSave={handleSave}
              onApplyDefaultDailyLimit={handleApplyDefaultDailyLimit}
              onRefreshReferencePrice={handleRefreshReferencePrice}
            />
          ) : (
            <div className="p-8 text-center text-muted-foreground">暂无数据</div>
          )}
        </TabsContent>

        {canManageDevices && (
        <TabsContent value="devices">
          <Card>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Tabs defaultValue="all" className="w-full">
                  <TabsList className="grid w-full max-w-xl grid-cols-4">
                    <TabsTrigger value="all">
                      全部设备 ({dashboardSummary?.totalDevices ?? 0})
                    </TabsTrigger>
                    <TabsTrigger value="xiaomi">
                      米家 ({dashboardSummary?.devices?.length ?? 0})
                    </TabsTrigger>
                    <TabsTrigger value="tuya">涂鸦 (0)</TabsTrigger>
                    <TabsTrigger value="other">其他 (0)</TabsTrigger>
                  </TabsList>
                  <TabsContent value="all" className="mt-4">
                    <DevicesTable
                      devices={dashboardSummary?.devices ?? []}
                      invalidateOnChange={async () => {
                        await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
                        await queryClient.invalidateQueries({ queryKey: ['xiaomi-status'] })
                      }}
                    />
                  </TabsContent>
                  <TabsContent value="xiaomi" className="mt-4">
                    <DevicesTable
                      devices={dashboardSummary?.devices ?? []}
                      invalidateOnChange={async () => {
                        await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
                        await queryClient.invalidateQueries({ queryKey: ['xiaomi-status'] })
                      }}
                    />
                  </TabsContent>
                  <TabsContent value="tuya" className="mt-4">
                    <div className="rounded-lg border border-dashed p-3 text-center text-sm text-muted-foreground">
                      暂无涂鸦设备
                    </div>
                  </TabsContent>
                  <TabsContent value="other" className="mt-4">
                    <div className="rounded-lg border border-dashed p-3 text-center text-sm text-muted-foreground">
                      暂无其他来源设备
                    </div>
                  </TabsContent>
                </Tabs>

                <div className="flex flex-wrap gap-2">
                  <Badge variant="success">在线 {dashboardSummary?.onlineDevices ?? 0}</Badge>
                  <Badge variant="danger">离线 {dashboardSummary?.offlineDevices ?? 0}</Badge>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        )}

        {canManageXiaomi && (
        <TabsContent value="xiaomi">
          <Tabs defaultValue="account-sync" className="space-y-3">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="account-sync">账号同步</TabsTrigger>
              <TabsTrigger value="api-sync">API 同步</TabsTrigger>
              <TabsTrigger value="lan-discovery">本地识别</TabsTrigger>
            </TabsList>

            <TabsContent value="account-sync" className="mt-0">
              <Card>
                <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Power className="h-5 w-5" />
                    账号同步
                  </CardTitle>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 rounded-full"
                    onClick={() => setAccountHelpOpen(true)}
                  >
                    <HelpCircle className="h-5 w-5" />
                    <span className="sr-only">帮助</span>
                  </Button>
                </CardHeader>
                <CardContent className="space-y-3 min-h-[360px]">
                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
                    <div className="rounded-lg border bg-background p-4 space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2 md:col-span-2">
                          <Label htmlFor="device-provider">设备厂商</Label>
                          <Select
                            value={deviceProvider}
                            onValueChange={(value) => setDeviceProvider(value as (typeof DEVICE_PROVIDER_OPTIONS)[number]['value'])}
                            disabled={!canManageXiaomi || xiaomiLogging}
                          >
                            <SelectTrigger id="device-provider">
                              <SelectValue placeholder="选择设备厂商" />
                            </SelectTrigger>
                            <SelectContent>
                              {DEVICE_PROVIDER_OPTIONS.map((item) => (
                                <SelectItem key={item.value} value={item.value}>
                                  {item.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="xiaomi-username">账号</Label>
                          <Input
                            id="xiaomi-username"
                            type="text"
                            placeholder={deviceProvider === 'xiaomi' ? '手机号 / 邮箱' : '请输入账号'}
                            autoComplete="username"
                            value={activeXiaomiUsername}
                            onChange={(e) =>
                              activeXiaomiScope === 'main'
                                ? setXiaomiUsername(e.target.value)
                                : setXiaomiExtraUsername(e.target.value)
                            }
                            disabled={!canManageXiaomi || xiaomiLogging}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="xiaomi-password">密码</Label>
                          <PasswordInput
                            id="xiaomi-password"
                            placeholder="请输入密码"
                            autoComplete="current-password"
                            value={activeXiaomiPassword}
                            onChange={(e) =>
                              activeXiaomiScope === 'main'
                                ? setXiaomiPassword(e.target.value)
                                : setXiaomiExtraPassword(e.target.value)
                            }
                            disabled={!canManageXiaomi || xiaomiLogging}
                          />
                        </div>
                        <div className="space-y-2 md:col-span-2">
                          <div className="flex items-center justify-between gap-3 pt-1">
                            <div
                              className="inline-flex items-center gap-2 select-none cursor-pointer"
                              onClick={(e) => {
                                e.preventDefault();
                                if (activeXiaomiScope === 'main') {
                                  persistXiaomiRemember({ enabled: !xiaomiRemember.enabled })
                                } else {
                                  persistXiaomiExtraRemember({ enabled: !xiaomiExtraRemember.enabled })
                                }
                              }}
                            >
                              {activeRememberEnabled ? (
                                <CheckSquare className="h-4 w-4 text-primary shrink-0" aria-hidden />
                              ) : (
                                <Square className="h-4 w-4 text-slate-400 shrink-0" aria-hidden />
                              )}
                              <span className="text-xs text-slate-600 dark:text-slate-300">
                                记住当前地区账号密码（下次打开自动回填）
                              </span>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-[11px] text-slate-500 hover:text-rose-600"
                              onClick={() => {
                                if (activeXiaomiScope === 'main') clearXiaomiRemember()
                                else clearXiaomiExtraRemember()
                              }}
                              disabled={!activeRememberUsername && !activeRememberPassword}
                            >
                              清除记住的凭据
                            </Button>
                          </div>
                        </div>
                        <div className="space-y-2 md:col-span-2">
                          <div className="flex items-center justify-between gap-3">
                            <Label htmlFor="xiaomi-region">地区</Label>
                            <span
                              className={cn(
                                'inline-flex items-center rounded-md px-2 py-0.5 text-[10.5px] font-medium ring-1 ring-inset',
                                xiaomiRegion === 'cn'
                                  ? 'bg-slate-50 text-slate-700 ring-slate-200'
                                  : 'bg-blue-50 text-blue-700 ring-blue-200',
                              )}
                            >
                              服务器：{xiaomiRegion?.toUpperCase()}
                              {xiaomiRegion === 'cn' ? ' 中国大陆' : ` 欧洲${xiaomiRegion?.toUpperCase()}`}
                            </span>
                          </div>
                          <Select
                            value={xiaomiRegion}
                            onValueChange={setXiaomiRegion}
                            disabled={!canManageXiaomi || xiaomiLogging}
                          >
                            <SelectTrigger id="xiaomi-region">
                              <SelectValue placeholder="选择地区" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="cn">cn 中国大陆（默认）</SelectItem>
                              <SelectItem value="at">at 奥地利</SelectItem>
                              <SelectItem value="de">de 德国</SelectItem>
                              <SelectItem value="fr">fr 法国</SelectItem>
                              <SelectItem value="ru">ru 俄罗斯</SelectItem>
                              <SelectItem value="sg">sg 新加坡</SelectItem>
                              <SelectItem value="us">us 美国</SelectItem>
                              <SelectItem value="in">in 印度</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      {deviceProvider === 'xiaomi' ? (
                        <>
                          {!activeXiaomiLoggedIn && activeStatusMessage ? (
                            <div
                              className={cn(
                                'rounded-lg border px-3 py-2 text-sm',
                                activeVerificationPending
                                  ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-200'
                                  : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700/60 dark:bg-slate-900/40 dark:text-slate-200',
                              )}
                            >
                              当前状态：{activeStatusMessage}
                            </div>
                          ) : null}
                          {activeVerificationPending && activeVerificationMethod === 'email_code' ? (
                            <div className="rounded-lg border bg-muted/30 p-3 space-y-3">
                              <div className="rounded-md border border-amber-200/70 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-200">
                                当前账号需要邮箱验证码验证。
                                {!activeCodeSentAt ? ' 先点下方「发送验证码」，收到邮件后再输入。' : ` 验证码已发送，发送时间：${formatDateTimeShort(activeCodeSentAt) || '刚刚'}。`}
                              </div>
                              {!activeCodeSentAt ? null : (
                                <div className="space-y-2">
                                  <Label htmlFor="xiaomi-email-code">邮箱验证码</Label>
                                  <Input
                                    id="xiaomi-email-code"
                                    type="text"
                                    placeholder="请输入邮箱收到的验证码"
                                    value={activeXiaomiScope === 'main' ? xiaomiEmailCode : xiaomiExtraEmailCode}
                                    onChange={(e) =>
                                      activeXiaomiScope === 'main'
                                        ? setXiaomiEmailCode(e.target.value)
                                        : setXiaomiExtraEmailCode(e.target.value)
                                    }
                                    disabled={!canManageXiaomi || xiaomiLogging}
                                  />
                                </div>
                              )}
                              <div className="flex flex-wrap gap-3">
                                <Button
                                  type="button"
                                  variant="outline"
                                  onClick={handleXiaomiSendEmailCode}
                                  disabled={!canManageXiaomi || xiaomiLogging}
                                >
                                  {activeCodeSentAt ? '重新发送验证码' : '发送验证码'}
                                </Button>
                                {activeCodeSentAt ? (
                                  <Button
                                    type="button"
                                    variant="secondary"
                                    onClick={handleXiaomiVerifyEmailCode}
                                    disabled={
                                      !canManageXiaomi ||
                                      xiaomiLogging ||
                                      !(activeXiaomiScope === 'main' ? xiaomiEmailCode.trim() : xiaomiExtraEmailCode.trim())
                                    }
                                  >
                                    提交验证码
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
                          涂鸦支持账号密码接入，这个入口已经留好；当前这版后端还没接通真实登录和同步。
                        </div>
                      )}

                      <div className="flex flex-wrap gap-3">
                        <Button
                          onClick={handleDeviceProviderLogin}
                          disabled={!canManageXiaomi || xiaomiLogging}
                        >
                          {xiaomiLogging ? (
                            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <LogIn className="mr-2 h-4 w-4" />
                          )}
                          {deviceProvider === 'xiaomi'
                            ? activeXiaomiLoggedIn
                              ? '重新登录'
                              : '登录账号'
                            : '登录账号'}
                        </Button>
                        {deviceProvider === 'xiaomi' &&
                        activeNotificationUrl &&
                        !activeXiaomiLoggedIn &&
                        activeVerificationMethod !== 'email_code' ? (
                          <Button
                            type="button"
                            variant="outline"
                            onClick={handleOpenXiaomiVerificationPage}
                            disabled={!canManageXiaomi || xiaomiLogging}
                          >
                            打开验证页
                          </Button>
                        ) : null}
                        {deviceProvider === 'xiaomi' &&
                        ((activeXiaomiScope === 'main' && verificationPending && !xiaomiStatus?.loggedIn) ||
                          (activeXiaomiScope === 'camera' && extraVerificationPending && !xiaomiExtraStatus?.loggedIn)) &&
                        activeVerificationMethod !== 'email_code' ? (
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={handleXiaomiContinue}
                            disabled={!canManageXiaomi || xiaomiLogging}
                          >
                            我已完成验证
                          </Button>
                        ) : null}
                      </div>
                    </div>

                    <div className="space-y-3">
                      {accountStatusCards.map((card) => (
                        <div key={card.scope} className="rounded-lg border bg-background p-4 space-y-3">
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2">
                              <div className="text-sm font-medium text-foreground">{card.title}</div>
                              <span className={cn('inline-flex items-center rounded-md px-2 py-0.5 text-[10.5px] font-medium ring-1 ring-inset', card.badgeClass)}>
                                {card.region.toUpperCase()}
                              </span>
                            </div>
                            {card.loggedIn ? (
                              <Badge className="gap-1 bg-emerald-600 hover:bg-emerald-700">
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                已登录
                              </Badge>
                            ) : (
                              <Badge variant="destructive" className="gap-1">
                                <XCircle className="h-3.5 w-3.5" />
                                未登录
                              </Badge>
                            )}
                          </div>
                          <div className="space-y-1 text-sm text-muted-foreground">
                            <div>账号：{card.username}</div>
                            <div>最近一次接入结果：{card.lastResult}</div>
                            <div>最后时间：{card.lastAt || '暂无'}</div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => handleAccountPullDevices(card.scope)}
                              disabled={!canManageXiaomi || accountSyncing || !card.loggedIn}
                            >
                              {accountSyncing ? (
                                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <RefreshCw className="mr-2 h-4 w-4" />
                              )}
                              {accountSyncing ? '识别中...' : '识别设备'}
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mt-6 rounded-lg border bg-background">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-medium">识别设备列表</span>
                        {accountDevices.length > 0 ? (
                          <Badge variant="outline">识别到 {accountDevices.length} 个</Badge>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {accountDevices.some((d) => !d.added) ? (
                          <Button
                            type="button"
                            onClick={handleAccountSyncAll}
                            size="sm"
                            disabled={accountSyncing}
                          >
                            <Plus className="mr-2 h-4 w-4" />
                            {accountSyncing ? '同步中...' : `同步已登录地区设备（${accountDevices.filter((d) => !d.added).length}）`}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    <div className="divide-y">
                      {accountDevices.length === 0 ? (
                        <div className="py-12 text-center text-sm text-muted-foreground">
                          先在左侧选择地区登录，再点右侧对应地区卡片的「识别设备」，识别结果会合并展示在这里。
                        </div>
                      ) : (
                        accountDevices.map((d) => (
                          <div
                            key={d.id}
                            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-foreground">
                                  {d.name ?? `设备 ${d.id.slice(-5)}`}
                                </span>
                                {d.provider ? (
                                  <Badge variant="secondary">{d.provider}</Badge>
                                ) : null}
                                {d.sourceRegion ? (
                                  <span
                                    className={cn(
                                      'inline-flex items-center rounded-md px-1.5 py-0.5 text-[9px] font-medium ring-1 ring-inset',
                                      d.sourceScope === 'camera' || d.sourceRegion !== 'cn'
                                        ? 'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:ring-blue-800/60'
                                        : 'bg-slate-50 text-slate-700 ring-slate-200 dark:bg-slate-900/40 dark:text-slate-300 dark:ring-slate-700/60',
                                    )}
                                  >
                                    {d.sourceScope === 'camera' || d.sourceRegion !== 'cn'
                                      ? `EU-${d.sourceRegion.toUpperCase()}`
                                      : `CN-${d.sourceRegion.toUpperCase()} 大陆`}
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center rounded-md bg-slate-50 px-1.5 py-0.5 text-[9px] font-medium text-slate-600 ring-1 ring-inset ring-slate-200 dark:bg-slate-900/40 dark:text-slate-400 dark:ring-slate-700/60">
                                    CN-大陆
                                  </span>
                                )}
                                <Badge variant="outline">账号识别设备</Badge>
                              </div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                ID {d.id.slice(-8)}
                                {d.model ? ` · 型号 ${d.model}` : ''}
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              {d.added ? (
                                <Badge variant="outline">已同步</Badge>
                              ) : (
                                <Badge variant="secondary">待同步</Badge>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="api-sync" className="mt-0">
              <Card>
                <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                  <CardTitle className="text-lg">云厂商 API 同步</CardTitle>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 rounded-full"
                    onClick={() => setApiHelpOpen(true)}
                  >
                    <HelpCircle className="h-5 w-5" />
                    <span className="sr-only">帮助</span>
                  </Button>
                </CardHeader>
                <CardContent className="space-y-3 min-h-[360px]">
                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
                    <div className="rounded-lg border bg-background p-4 space-y-4">
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="api-sync-provider">云厂商</Label>
                          <Select
                            value={apiSyncProvider}
                            onValueChange={(value) =>
                              setApiSyncProvider(value as (typeof API_SYNC_OPTIONS)[number]['value'])
                            }
                          >
                            <SelectTrigger id="api-sync-provider">
                              <SelectValue placeholder="选择云厂商" />
                            </SelectTrigger>
                            <SelectContent>
                              {API_SYNC_OPTIONS.map((item) => (
                                <SelectItem key={item.value} value={item.value}>
                                  {item.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="api-base-url">API 地址</Label>
                          <Input
                            id="api-base-url"
                            placeholder={
                              apiSyncProvider === 'tuya_cloud'
                                ? '涂鸦云由后端固定路由处理，无需填写'
                                : '例如 https://iot-api.example.com'
                            }
                            value={apiBaseUrl}
                            onChange={(e) => setApiBaseUrl(e.target.value)}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="api-access-key">Access Key</Label>
                          <Input
                            id="api-access-key"
                            placeholder="请输入 Access Key"
                            value={apiAccessKey}
                            onChange={(e) => setApiAccessKey(e.target.value)}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="api-access-secret">Access Secret</Label>
                          <Input
                            id="api-access-secret"
                            type="password"
                            placeholder="请输入 Access Secret"
                            value={apiAccessSecret}
                            onChange={(e) => setApiAccessSecret(e.target.value)}
                          />
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-3">
                        <Badge variant={apiSyncStatus === '未连接' ? 'secondary' : 'outline'}>
                          {apiSyncStatus}
                        </Badge>
                        <Button type="button" variant="outline" onClick={handleApiSyncConnect}>
                          连接 API
                        </Button>
                      </div>
                    </div>

                    <div className="rounded-lg border bg-background p-4 space-y-4">
                      <div className="flex flex-wrap items-center gap-3">
                        <Badge variant={apiSyncStatus === '未连接' ? 'secondary' : 'outline'}>
                          {apiSyncStatus}
                        </Badge>
                        <Button type="button" variant="outline" onClick={handleApiSyncConnect}>
                          连接 API
                        </Button>
                        <Button
                          type="button"
                          onClick={handleApiPullDevices}
                          disabled={apiPulling}
                        >
                          {apiPulling ? (
                            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <RefreshCw className="mr-2 h-4 w-4" />
                          )}
                          {apiPulling ? '识别中...' : '识别设备'}
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 rounded-lg border bg-background">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-medium">识别设备列表</span>
                        {apiDevices.length > 0 ? (
                          <Badge variant="outline">识别到 {apiDevices.length} 个</Badge>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {apiDevices.some((d) => !d.added) ? (
                          <Button
                            type="button"
                            onClick={handleApiSyncAll}
                            size="sm"
                          >
                            <Plus className="mr-2 h-4 w-4" />
                            一键同步（{apiDevices.filter((d) => !d.added).length}）
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    <div className="divide-y">
                      {apiDevices.length === 0 ? (
                        <div className="py-12 text-center text-sm text-muted-foreground">
                          先填 Access Key/Secret 连接 API，再点「识别设备」，识别到的设备会在这里展示，再一键同步到当前区域。
                        </div>
                      ) : (
                        apiDevices.map((d) => (
                          <div
                            key={d.id}
                            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-foreground">
                                  {d.name ?? `设备 ${d.id.slice(-5)}`}
                                </span>
                                {d.provider ? (
                                  <Badge variant="secondary">{d.provider}</Badge>
                                ) : null}
                                <Badge variant="outline">API同步设备</Badge>
                              </div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                ID {d.id.slice(-8)}
                                {d.model ? ` · 型号 ${d.model}` : ''}
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              {d.added ? (
                                <Badge variant="outline">已同步</Badge>
                              ) : (
                                <>
                                  {sites[0]?.id ? (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      onClick={() => {
                                        setApiDevices((prev) =>
                                          prev.map((x) => (x.id === d.id ? { ...x, added: true } : x)),
                                        )
                                        const label = sites[0].name
                                        toast.success(`已同步到 ${label}`)
                                      }}
                                    >
                                      同步到当前区域
                                    </Button>
                                  ) : null}
                                </>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Dialog open={accountHelpOpen} onOpenChange={setAccountHelpOpen}>
                <DialogContent className="max-w-xl">
                  <DialogHeader>
                    <DialogTitle>账号同步说明</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-2 text-sm text-muted-foreground">
                    <div>这块走设备账号直接登录，适合米家、涂鸦这类账号体系。</div>
                    <div>先选厂商，填账号密码，再点登录；登录成功后再点“同步设备”，设备会进入当前区域并在“设备总览”里统一显示。</div>
                    <div>支持商家：米家、涂鸦。后面如果接入新的账号体系，也继续从这里扩。</div>
                  </div>
                </DialogContent>
              </Dialog>

              <Dialog open={apiHelpOpen} onOpenChange={setApiHelpOpen}>
                <DialogContent className="max-w-xl">
                  <DialogHeader>
                    <DialogTitle>云厂商 API 同步说明</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-2 text-sm text-muted-foreground">
                    <div>这块专门用于接入云厂商开放接口，适合涂鸦云、阿里云 IoT、华为云 IoT、腾讯云 IoT 这类云端设备管理平台。</div>
                    <div>和“账号同步”的区别：账号同步是用你的用户账号密码去登；这个是用厂商给的固定 API Key / Secret 直接对接云平台。</div>
                    <div>先选云厂商，填 API 地址（涂鸦云不用填）、Access Key 和 Secret，再点连接 API。后续真实接通后，这里会直接承担云端设备同步入口。</div>
                    <div>适用场景：设备已经接在厂商云平台上，想直接从云端拉取设备数据和状态，不经过本地局域网扫描。</div>
                  </div>
                </DialogContent>
              </Dialog>
            </TabsContent>

            <TabsContent value="lan-discovery" className="mt-0">
              <Card className="h-[calc(100vh-260px)] overflow-hidden">
                <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                  <CardTitle className="text-lg">本地识别</CardTitle>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 rounded-full"
                    onClick={() => setLanHelpOpen(true)}
                  >
                    <HelpCircle className="h-5 w-5" />
                    <span className="sr-only">帮助</span>
                  </Button>
                </CardHeader>
                <CardContent className="h-[calc(100%-64px)] flex flex-col gap-4 overflow-hidden">
                  <div className="flex flex-wrap items-end gap-3 shrink-0">
                    <div className="w-60 space-y-2">
                      <Label htmlFor="lan-subnet">{lanGuide.fieldLabel}</Label>
                      <Input
                        id="lan-subnet"
                        placeholder={lanGuide.placeholder}
                        value={lanSubnet}
                        onChange={(e) => setLanSubnet(e.target.value)}
                        disabled={lanScanning}
                      />
                    </div>
                    <div className="flex items-center gap-2 pb-2">
                      <Switch
                        id="lan-vendor-remote"
                        checked={lanVendorRemoteApi}
                        onCheckedChange={(v) => setLanVendorRemoteApi(!!v)}
                        disabled={lanScanning}
                      />
                      <Label htmlFor="lan-vendor-remote" className="text-xs font-normal text-muted-foreground">
                          开启厂商名联网补全：内置没识别到时，自动查公开 API 显示更准（默认开启，极少数网络环境下会变慢，可手动关）
                        </Label>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleLanDiscovery}
                      disabled={lanScanning}
                    >
                      {lanScanning ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          正在扫描
                        </>
                      ) : '开始识别'}
                    </Button>
                    <div className="text-sm text-muted-foreground">
                      {lanScanning
                        ? '正在扫描（请耐心等待，Ping + ARP 扫 254 个 IP 通常需要 15~45 秒）'
                        : lanDiscoveredCount === null
                          ? lanDiscoveryStatus === '未开始识别'
                            ? '未识别'
                            : lanDiscoveryStatus
                          : lanDiscoveryStatus.includes('完成')
                            ? lanDiscoveryStatus
                            : `扫描中... ${lanDiscoveredCount} 个`}
                    </div>
                  </div>

                  <div className="flex-1 min-h-0 overflow-y-auto pr-1">
                    {lanDevices.length === 0 ? (
                      <div className="flex h-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
                        还没有识别到设备，点"开始识别"后会在这里显示
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="rounded-lg border border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40 dark:border-emerald-800 px-4 py-3 text-sm text-emerald-900 dark:text-emerald-200">
                          <div className="font-semibold mb-1">
                            ✅ 已完成真实局域网扫描
                          </div>
                          <div className="text-xs leading-6">
                            {lanDiscoveryStatus}
                          </div>
                          <div className="text-xs leading-6">
                            🟢 = Ping 有回应 ｜ ⚪ 仅在 ARP 缓存（设备不回 Ping 但近期在网内活跃过，比如锁屏手机 / 智能电表 / 摄像头 / 低功耗 IoT 都可能显示成这样） ｜ ❔ 无记录
                          </div>
                        </div>
                        <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/90 backdrop-blur px-3 py-2">
                          <div className="flex flex-wrap items-center gap-2 text-sm">
                            <Badge variant="outline">识别到 {lanDevices.length} 个</Badge>
                            <span className="text-xs text-muted-foreground">
                              本地识别设备
                            </span>
                            {(() => {
                              const counts = lanDevices.reduce<Record<string, number>>((acc, d) => {
                                acc[d.category] = (acc[d.category] ?? 0) + 1
                                return acc
                              }, {})
                              const arr = Object.entries(counts).filter(([, n]) => n > 0)
                              if (!arr.length) return null
                              return arr.map(([c, n]) => (
                                <Badge key={c} variant="secondary" className="ml-1">
                                  {DEVICE_CATEGORY_LABEL[c as DeviceCategory] ?? c} {n}
                                </Badge>
                              ))
                            })()}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            {lanDevices.some((d) => !d.added) ? (
                              <Button
                                type="button"
                                size="sm"
                                onClick={handleLanSyncAll}
                                disabled={persistLanDevicesMutation.isPending}
                              >
                                {persistLanDevicesMutation.isPending ? (
                                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                ) : (
                                  <Plus className="mr-2 h-4 w-4" />
                                )}
                                一键同步（{lanDevices.filter((d) => !d.added).length}）
                              </Button>
                            ) : null}
                          </div>
                        </div>
                        <div className="space-y-2">
                          {lanDevices.map((d) => {
                            let dotColor = 'bg-gray-300'
                            let dotTitle = '无记录'
                            if (d.pingAlive) {
                              dotColor = 'bg-green-500'
                              dotTitle = 'Ping 在线'
                            } else if (d.fromArp) {
                              dotColor = 'bg-amber-400'
                              dotTitle = 'ARP 缓存里有记录（不回 Ping）'
                            }
                            return (
                              <div
                                key={d.id}
                                className="flex flex-wrap items-center gap-3 rounded-lg border p-3"
                              >
                                <div className="flex items-center gap-2 w-24 shrink-0">
                                  <span
                                    className={`h-3 w-3 inline-block rounded-full ${dotColor}`}
                                    title={dotTitle}
                                  />
                                  <span className="text-xs text-muted-foreground">{dotTitle}</span>
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-medium text-foreground">
                                      {d.name || (
                                        <span className="text-muted-foreground">
                                          ID {d.id.slice(-8)}
                                        </span>
                                      )}
                                    </span>
                                    <Badge variant="outline">本地识别设备</Badge>
                                    <Badge variant="secondary">{d.categoryLabel}</Badge>
                                  </div>
                                  <div className="mt-1 text-xs text-muted-foreground break-all">
                                    IP {d.ip}
                                    {d.mac ? <span className="ml-3">MAC {d.mac}</span> : null}
                                    {d.vendor ? (
                                      <span className="ml-3">厂商 {d.vendor}</span>
                                    ) : null}
                                  </div>
                                </div>
                                <div className="flex items-center gap-2">
                                  <Select
                                    defaultValue={sites[0]?.id}
                                    disabled={d.added || persistLanDevicesMutation.isPending}
                                    onValueChange={(v) => handleAddLanDevice(d.id, v)}
                                  >
                                    <SelectTrigger className="w-36">
                                      <SelectValue placeholder="加入区域" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {sites.map((s) => (
                                        <SelectItem key={s.id} value={s.id}>
                                          {s.name || (s.isPrimary ? '默认区' : s.code)}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  {d.added ? (
                                    <Badge variant="success" className="ml-1">
                                      已写入
                                    </Badge>
                                  ) : (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      disabled={persistLanDevicesMutation.isPending}
                                      onClick={() => handleAddLanDevice(d.id, sites[0]?.id ?? 'default')}
                                    >
                                      {persistLanDevicesMutation.isPending ? (
                                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                                      ) : (
                                        <Plus className="mr-1 h-3.5 w-3.5" />
                                      )}
                                      写入
                                    </Button>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Dialog open={lanHelpOpen} onOpenChange={setLanHelpOpen}>
                <DialogContent className="max-w-xl">
                  <DialogHeader>
                    <DialogTitle>{lanGuide.title}</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-2 text-sm text-muted-foreground">
                    {lanGuide.steps.map((step) => (
                      <div key={step}>{step}</div>
                    ))}
                  </div>
                </DialogContent>
              </Dialog>
            </TabsContent>
          </Tabs>
        </TabsContent>
        )}

        {canManageUsers && (
        <TabsContent value="accounts">
          <div className="grid gap-3">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <UserPlus className="h-5 w-5" />
                  新增账号
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <div className="space-y-2">
                    <Label htmlFor="new-user-username">用户名</Label>
                    <Input
                      id="new-user-username"
                      placeholder="例如 manager01"
                      value={newUserForm.username}
                      onChange={(e) => setNewUserForm((prev) => ({ ...prev, username: e.target.value }))}
                      disabled={createUserMutation.isPending}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="new-user-name">显示名称</Label>
                    <Input
                      id="new-user-name"
                      placeholder="例如 值班管理员"
                      value={newUserForm.name}
                      onChange={(e) => setNewUserForm((prev) => ({ ...prev, name: e.target.value }))}
                      disabled={createUserMutation.isPending}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="new-user-password">初始密码</Label>
                    <Input
                      id="new-user-password"
                      type="password"
                      placeholder="至少 6 位"
                      value={newUserForm.password}
                      onChange={(e) => setNewUserForm((prev) => ({ ...prev, password: e.target.value }))}
                      disabled={createUserMutation.isPending}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="new-user-role">账号角色</Label>
                    <Select
                      value={newUserForm.role}
                      onValueChange={(value) => setNewUserForm((prev) => ({ ...prev, role: value as UserRole }))}
                      disabled={createUserMutation.isPending}
                    >
                      <SelectTrigger id="new-user-role">
                        <SelectValue placeholder="选择角色" />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button onClick={handleCreateUser} disabled={createUserMutation.isPending}>
                    <UserPlus className="mr-2 h-4 w-4" />
                    {createUserMutation.isPending ? '创建中...' : '创建账号'}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Shield className="h-5 w-5" />
                  账号权限管理
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {users.length === 0 ? (
                  <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
                    暂无账号数据
                  </div>
                ) : (
                  users.map((account) => {
                    const draft = userDrafts[account.id] ?? {
                      name: account.name,
                      role: account.role,
                      password: '',
                    }

                    return (
                      <div
                        key={account.id}
                        className="rounded-lg border bg-background p-4"
                      >
                        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium text-foreground">{account.username}</span>
                              <Badge variant={account.role === UserRole.ADMIN ? 'default' : 'secondary'}>
                                {getRoleLabel(account.role)}
                              </Badge>
                              {account.id === user?.id && (
                                <Badge variant="outline">当前账号</Badge>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              创建时间：{new Date(account.createdAt).toLocaleString()}
                              {' · '}
                              最近登录：{account.lastLoginAt ? new Date(account.lastLoginAt).toLocaleString() : '未登录过'}
                            </div>
                          </div>
                        </div>

                        <div className="grid gap-4 md:grid-cols-3">
                          <div className="space-y-2">
                            <Label htmlFor={`user-name-${account.id}`}>显示名称</Label>
                            <Input
                              id={`user-name-${account.id}`}
                              value={draft.name}
                              onChange={(e) => handleUserDraftChange(account.id, { name: e.target.value })}
                              disabled={updateUserMutation.isPending}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor={`user-role-${account.id}`}>账号角色</Label>
                            <Select
                              value={draft.role}
                              onValueChange={(value) => handleUserDraftChange(account.id, { role: value as UserRole })}
                              disabled={updateUserMutation.isPending || account.id === user?.id}
                            >
                              <SelectTrigger id={`user-role-${account.id}`}>
                                <SelectValue placeholder="选择角色" />
                              </SelectTrigger>
                              <SelectContent>
                                {ROLE_OPTIONS.map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor={`user-password-${account.id}`}>重置密码</Label>
                            <Input
                              id={`user-password-${account.id}`}
                              type="password"
                              placeholder="留空表示不修改"
                              value={draft.password}
                              onChange={(e) => handleUserDraftChange(account.id, { password: e.target.value })}
                              disabled={updateUserMutation.isPending}
                            />
                          </div>
                        </div>

                        <div className="mt-4 flex flex-wrap justify-end gap-3">
                          <Button
                            variant="outline"
                            onClick={() => handleUpdateUser(account)}
                            disabled={updateUserMutation.isPending}
                          >
                            <Save className="mr-2 h-4 w-4" />
                            保存账号
                          </Button>
                          <Button
                            variant="destructive"
                            onClick={() => handleDeleteUser(account)}
                            disabled={deleteUserMutation.isPending || account.id === user?.id}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            删除账号
                          </Button>
                        </div>
                      </div>
                    )
                  })
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
        )}
      </Tabs>
      )}
    </div>
  )
}
