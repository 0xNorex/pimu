import { useCallback, useEffect, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import { ChevronRightIcon, Loader2Icon, LogOutIcon, PlugIcon, RefreshCwIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api, ApiError, errMsg } from '@/lib/api'
import { go } from '@/lib/route'
import { getTheme, setTheme, type Theme } from '@/lib/theme'
import type { Goal, Model } from '@/lib/types'
import { every } from '@/lib/format'
import { MemoryEditor } from './MemoryEditor'
import { THINKING, useModels } from './ModelPicker'
import { PageHeader } from './PageHeader'

export const SECTIONS = [
  ['models', '模型'],
  ['extensions', '扩展'],
  ['skills', 'Skills'],
  ['mcp', 'MCP'],
  ['memory', '记忆'],
  ['goals', '主动'],
  ['pimu', 'Pimu'],
] as const
export type Section = (typeof SECTIONS)[number][0]

type Ext = { name: string; path?: string; builtin: boolean; enabled: boolean }
type MCPServer = { command?: string; args?: string[]; url?: string; description?: string; enabled?: boolean; exposure?: string }
type ProviderCfg = { api?: string; baseUrl?: string; apiKey?: string; models?: { id: string; name?: string; input?: string[]; reasoning?: boolean; contextWindow?: number }[] }
type Settings = {
  agentDir: string
  settings: Record<string, unknown> & { defaultProvider?: string; defaultModel?: string; modelThinkingLevels?: Record<string, string>; defaultThinkingLevel?: string }
  settingsMtime: number
  models: { providers?: Record<string, ProviderCfg> }
  mcp: { mcpServers?: Record<string, MCPServer> }
  mcpMtime: number
  extensions: Ext[]
  packages: unknown[] | null
  telegram: { configured: boolean; chat?: string }
  version: string
  piVersion: string
  publicUrl: string
}
type Cmd = { name: string; description?: string; source: 'skill' | 'prompt' | 'extension'; sourceInfo: { path: string; scope: string; source: string } }
type Status = { servers: { name: string; state: string; tools: string[]; error?: string; enabled: boolean }[]; errors: unknown[] }

// Grouped list, iOS-settings style.
function Group({ title, hint, children }: { title?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      {title && <h2 className="px-1 text-[13px] font-medium text-muted-foreground">{title}</h2>}
      <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-soft">{children}</div>
      {hint && <p className="px-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </section>
  )
}
function Row({ title, sub, right, onClick }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; onClick?: () => void }) {
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px]">{title}</div>
        {sub && <div className="mt-0.5 text-xs break-words text-muted-foreground">{sub}</div>}
      </div>
      {right}
      {onClick && <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />}
    </>
  )
  return onClick ? (
    <button type="button" onClick={onClick} className="pressable flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/50">
      {body}
    </button>
  ) : (
    <div className="flex min-h-12 items-center gap-3 px-4 py-2.5">{body}</div>
  )
}
const Mono = ({ children }: { children: ReactNode }) => <span className="font-mono text-[11.5px]">{children}</span>

export function SettingsPage({ section }: { section: Section }) {
  const [s, setS] = useState<Settings | null>(null)
  const load = useCallback(() => {
    api<Settings>('/api/settings').then(setS).catch((e) => toast.error(errMsg(e)))
  }, [])
  useEffect(load, [load])

  // Every write sends the mtime it saw; a 409 means someone else edited the file.
  const patch = async (path: string, body: object) => {
    try {
      setS(await api<Settings>(path, body, 'PATCH'))
      toast.success('已保存，新会话生效')
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast.error('配置文件刚被别处修改，已重新加载')
        load()
      } else toast.error(errMsg(e))
    }
  }

  return (
    <main className="page-in flex min-w-0 flex-1 flex-col">
      <PageHeader title="设置" back="#/" />
      <nav className="flex gap-1 overflow-x-auto border-b px-3 py-2 [scrollbar-width:none]" aria-label="设置分区">
        {SECTIONS.map(([k, label]) => (
          <a
            key={k}
            href={`#/settings/${k}`}
            aria-current={k === section ? 'page' : undefined}
            className="pressable shrink-0 rounded-full px-3.5 py-1.5 text-sm text-muted-foreground hover:bg-muted aria-[current=page]:bg-foreground aria-[current=page]:text-background"
          >
            {label}
          </a>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div key={section} className="msg-in mx-auto flex max-w-2xl flex-col gap-6 p-4 pb-[calc(env(safe-area-inset-bottom)+2rem)]">
          {section === 'memory' ? (
            <MemoryEditor />
          ) : section === 'goals' ? (
            <GoalsSection />
          ) : !s ? (
            [0, 1].map((i) => <Skeleton key={i} className="h-32 rounded-xl" />)
          ) : section === 'models' ? (
            <ModelsSection s={s} patch={patch} />
          ) : section === 'extensions' ? (
            <ExtensionsSection s={s} patch={patch} />
          ) : section === 'skills' ? (
            <SkillsSection s={s} />
          ) : section === 'mcp' ? (
            <MCPSection s={s} patch={patch} />
          ) : (
            <PimuSection s={s} />
          )}
        </div>
      </div>
    </main>
  )
}

type P = { s: Settings; patch: (path: string, body: object) => Promise<void> }

function ModelsSection({ s, patch }: P) {
  const models = useModels(true)
  const cur = s.settings.defaultProvider && s.settings.defaultModel ? `${s.settings.defaultProvider}/${s.settings.defaultModel}` : ''
  const thinking = s.settings.modelThinkingLevels?.[cur] ?? s.settings.defaultThinkingLevel ?? 'medium'
  const set = (key: string, level: string) => {
    const m = models?.find((x) => `${x.provider}/${x.id}` === key)
    if (m) void patch('/api/settings/model', { provider: m.provider, modelId: m.id, thinking: level, mtime: s.settingsMtime })
  }
  const providers = Object.entries(s.models.providers ?? {})
  return (
    <>
      <Group title="默认" hint={<>写入 <Mono>settings.json</Mono> 的 defaultProvider / defaultModel / modelThinkingLevels；已开的会话不受影响。</>}>
        <Row
          title="模型"
          right={
            <Select value={cur} onValueChange={(v) => set(v, thinking)} disabled={!models}>
              <SelectTrigger className="h-9 max-w-[60vw] min-w-40 sm:max-w-72">
                <SelectValue placeholder={models ? '自动' : '加载中…'} />
              </SelectTrigger>
              <SelectContent>
                {(models ?? []).map((m: Model) => (
                  <SelectItem key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                    {m.name} <span className="text-muted-foreground">· {m.provider}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <Row
          title="思考强度"
          right={
            <Select value={thinking} onValueChange={(v) => set(cur, v)} disabled={!cur}>
              <SelectTrigger className="h-9 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THINKING.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </Group>
      {providers.map(([name, p]) => (
        <Group key={name} title={`服务商 · ${name}`} hint={name === providers[providers.length - 1][0] && <>来自 <Mono>models.json</Mono>，只读；密钥已隐藏。改服务商请在终端编辑该文件。</>}>
          <Row title="接口" sub={<Mono>{p.baseUrl ?? '—'}</Mono>} right={p.api && <Badge variant="secondary">{p.api}</Badge>} />
          <Row title="API Key" right={<Mono>{p.apiKey ?? '—'}</Mono>} />
          {(p.models ?? []).map((m) => (
            <Row
              key={m.id}
              title={m.name ?? m.id}
              sub={<Mono>{m.id}</Mono>}
              right={
                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                  {m.input?.includes('image') && <Badge variant="secondary">图片</Badge>}
                  {m.reasoning && <Badge variant="secondary">推理</Badge>}
                  {m.contextWindow && <Badge variant="outline">{m.contextWindow >= 1e6 ? `${m.contextWindow / 1e6}M` : `${Math.round(m.contextWindow / 1e3)}K`}</Badge>}
                </div>
              }
            />
          ))}
        </Group>
      ))}
    </>
  )
}

const BUILTIN_DESC: Record<string, string> = {
  mcp: '连接 mcp.json 里的 MCP 服务器',
  'llama.cpp': '管理本地 llama.cpp 模型',
  codemode: '让模型写代码批量调用工具',
  'tool-search': '工具多时按需搜索工具',
}

function useCommands() {
  const [cmds, setCmds] = useState<Cmd[] | null>(null)
  useEffect(() => {
    api<{ commands: Cmd[] }>('/api/settings/commands')
      .then((r) => setCmds(r.commands))
      .catch((e) => {
        setCmds([])
        toast.error(errMsg(e))
      })
  }, [])
  return cmds
}

function ExtensionsSection({ s, patch }: P) {
  const cmds = useCommands()
  const builtins = s.extensions.filter((e) => e.builtin)
  const files = s.extensions.filter((e) => !e.builtin)
  const extCmds = (cmds ?? []).filter((c) => c.source === 'extension')
  return (
    <>
      <Group title="内置扩展" hint={<>开关写入 settings.json 的 <Mono>extensions</Mono>（<Mono>-builtin:名字</Mono>）。</>}>
        {builtins.map((e) => (
          <Row
            key={e.name}
            title={<Mono>builtin:{e.name}</Mono>}
            sub={BUILTIN_DESC[e.name]}
            right={<Switch checked={e.enabled} onCheckedChange={(v) => void patch('/api/settings/extension', { name: e.name, enabled: v, mtime: s.settingsMtime })} aria-label={`启用 ${e.name}`} />}
          />
        ))}
      </Group>
      <Group title="已安装" hint={<>用户目录 <Mono>{s.agentDir}/extensions/</Mono> 与 settings 里的路径；增删请用 <Mono>pi install</Mono> / <Mono>pi config</Mono>。</>}>
        {files.length === 0 && <Row title="没有" />}
        {files.map((e) => (
          <Row key={e.name} title={e.name} sub={e.path && <Mono>{e.path}</Mono>} right={!e.enabled && <Badge variant="outline">已排除</Badge>} />
        ))}
        {(s.packages ?? []).map((p, i) => (
          <Row key={i} title="包" sub={<Mono>{typeof p === 'string' ? p : JSON.stringify(p)}</Mono>} />
        ))}
      </Group>
      <Group title="扩展提供的命令">
        {!cmds ? <Row title={<Skeleton className="h-4 w-40" />} /> : extCmds.length === 0 ? <Row title="没有" /> : extCmds.map((c) => <Row key={c.name} title={<Mono>/{c.name}</Mono>} sub={c.description} right={<Badge variant="outline">{c.sourceInfo.path.replace(/^.*\//, '')}</Badge>} />)}
      </Group>
    </>
  )
}

function SkillsSection({ s }: { s: Settings }) {
  const cmds = useCommands()
  const [open, setOpen] = useState<Cmd | null>(null)
  const [doc, setDoc] = useState<{ path: string; content: string } | null>(null)
  useEffect(() => {
    if (!open) return
    setDoc(null)
    api<{ path: string; content: string }>(`/api/settings/skill?name=${encodeURIComponent(open.name)}`)
      .then(setDoc)
      .catch((e) => toast.error(errMsg(e)))
  }, [open])
  const list = (cmds ?? []).filter((c) => c.source !== 'extension')
  return (
    <>
      <Group
        title="Skills 与提示模板"
        hint={
          <>
            pi 启动时扫描 <Mono>{s.agentDir}/skills/</Mono>、<Mono>~/.agents/skills/</Mono> 和项目 <Mono>.pi/skills/</Mono>，只把名字和描述放进系统提示，需要时再读全文。新增：把含 <Mono>SKILL.md</Mono> 的目录放进去即可。
          </>
        }
      >
        {!cmds && <Row title={<Skeleton className="h-4 w-40" />} />}
        {cmds && list.length === 0 && <Row title="还没有 skill" sub="上面的目录里还没有 SKILL.md" />}
        {list.map((c) => (
          <Row
            key={c.name}
            title={
              <span className="flex items-center gap-2">
                <Mono>/{c.name}</Mono>
                <Badge variant={c.source === 'skill' ? 'secondary' : 'outline'}>{c.source === 'skill' ? 'skill' : '模板'}</Badge>
                {c.sourceInfo.scope === 'project' && <Badge variant="outline">项目</Badge>}
              </span>
            }
            sub={c.description}
            onClick={() => setOpen(c)}
          />
        ))}
      </Group>
      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle className="font-mono">/{open?.name}</SheetTitle>
            <SheetDescription className="font-mono text-xs break-all">{doc?.path ?? open?.sourceInfo.path}</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-8 text-sm leading-relaxed">{doc ? <div className="prose-pimu"><Markdown remarkPlugins={[remarkGfm]}>{doc.content}</Markdown></div> : <Skeleton className="h-40" />}</div>
        </SheetContent>
      </Sheet>
    </>
  )
}

function MCPSection({ s, patch }: P) {
  const [st, setSt] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const check = async () => {
    setBusy(true)
    try {
      setSt(await api<Status>('/api/settings/mcp/status'))
    } catch (e) {
      toast.error(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  const servers = Object.entries(s.mcp.mcpServers ?? {})
  const builtinOff = s.extensions.some((e) => e.builtin && e.name === 'mcp' && !e.enabled)
  return (
    <>
      {builtinOff && <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm">内置扩展 builtin:mcp 已关闭，下面的服务器都不会连接。</p>}
      <Group
        title={
          <span className="flex items-center">
            <span className="flex-1">服务器</span>
            <Button size="sm" variant="ghost" onClick={() => void check()} disabled={busy} className="-my-1">
              {busy ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
              检测连接
            </Button>
          </span>
        }
        hint={<>来自 <Mono>{s.agentDir}/mcp.json</Mono>；开关写入该服务器的 <Mono>enabled</Mono>。环境变量和 headers 不显示。添加：<Mono>pi mcp add 名字 -- 命令</Mono>。</>}
      >
        {servers.length === 0 && <Row title="还没有 MCP 服务器" />}
        {servers.map(([name, srv]) => {
          const stat = st?.servers.find((x) => x.name === name)
          return (
            <div key={name} className="px-4 py-3">
              <div className="flex items-center gap-3">
                <PlugIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{name}</span>
                {stat && <Badge variant={stat.state === 'connected' ? 'secondary' : 'outline'} className={stat.state === 'connected' ? 'text-emerald-600 dark:text-emerald-400' : stat.state === 'failed' ? 'text-destructive' : ''}>{stat.state === 'connected' ? `已连接 · ${stat.tools.length} 个工具` : stat.state}</Badge>}
                <Switch checked={srv.enabled !== false} onCheckedChange={(v) => void patch(`/api/settings/mcp/${encodeURIComponent(name)}`, { enabled: v, mtime: s.mcpMtime })} aria-label={`启用 ${name}`} />
              </div>
              {srv.description && <p className="mt-1 text-sm text-muted-foreground">{srv.description}</p>}
              <p className="mt-1.5 rounded-md bg-muted/60 px-2 py-1 break-all text-muted-foreground">
                <Mono>{srv.url ?? [srv.command, ...(srv.args ?? [])].join(' ')}</Mono>
              </p>
              {stat?.error && <p className="mt-1.5 text-xs text-destructive">{stat.error}</p>}
              {stat && stat.tools.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {stat.tools.map((t) => (
                    <Badge key={t} variant="outline" className="font-mono text-[10.5px] font-normal">
                      {t}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </Group>
    </>
  )
}

function PimuSection({ s }: { s: Settings }) {
  const [theme, setT] = useState<Theme>(getTheme)
  const logout = async () => {
    await api('/api/logout', {}).catch(() => {})
    go('#/login')
  }
  return (
    <>
      <Group title="外观">
        <Row
          title="主题"
          right={
            <Select
              value={theme}
              onValueChange={(v) => {
                setT(v as Theme)
                setTheme(v as Theme)
              }}
            >
              <SelectTrigger className="h-9 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">跟随系统</SelectItem>
                <SelectItem value="light">浅色</SelectItem>
                <SelectItem value="dark">深色</SelectItem>
              </SelectContent>
            </Select>
          }
        />
      </Group>
      <Group title="通知" hint="Telegram 由启动 Pimu 的环境变量 PIMU_TELEGRAM_TOKEN / PIMU_TELEGRAM_CHAT_ID 配置，只在任务完成或失败时提醒。">
        <Row title="Telegram" right={s.telegram.configured ? <Badge variant="secondary" className="text-emerald-600 dark:text-emerald-400">已配置{s.telegram.chat ? ` · ${s.telegram.chat}` : ''}</Badge> : <Badge variant="outline">未配置</Badge>} />
      </Group>
      <Group title="关于">
        <Row title="Pimu" right={<Mono>{s.version}</Mono>} />
        <Row title="pi" right={<Mono>{s.piVersion}</Mono>} />
        <Row title="pi 配置目录" right={<Mono>{s.agentDir}</Mono>} />
        {s.publicUrl && <Row title="访问地址" right={<Mono>{s.publicUrl}</Mono>} />}
      </Group>
      <Group>
        <button type="button" onClick={() => void logout()} className="pressable flex min-h-12 w-full items-center justify-center gap-2 px-4 text-[15px] text-destructive hover:bg-destructive/5">
          <LogOutIcon className="size-4" /> 退出登录
        </button>
      </Group>
    </>
  )
}

// Every goal across bots, plus where their files live. Editing happens in the bot's 目标 tab.
function GoalsSection() {
  const [goals, setGoals] = useState<(Goal & { botName: string })[] | null>(null)
  useEffect(() => void api<{ goals: (Goal & { botName: string })[] }>('/api/goals').then((r) => setGoals(r.goals)).catch(() => {}), [])
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">主动目标</h2>
        <p className="text-sm text-muted-foreground">目标挂在 Bot 上。每次心跳先用零 token 的预检判断要不要跑，再开一个全新的 pi 会话执行；只有重要的事才进收件箱和 Telegram。</p>
      </div>
      {!goals && <Skeleton className="h-24 rounded-xl" />}
      {goals?.length === 0 && <p className="text-sm text-muted-foreground">还没有目标。打开一个 Bot → 目标 → 新目标。</p>}
      <ul className="divide-y rounded-xl border">
        {goals?.map((g) => (
          <li key={g.id}>
            <a href={`#/s/${g.botId}`} className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/50">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {g.botName} · {g.title}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  L{g.level} · {every(g.everySec)} · 今日 {Math.round(g.todayTokens / 1000)}k tok{g.precheck && ` · ${g.precheck}`}
                </div>
              </div>
              <Badge variant={g.enabled ? 'secondary' : 'outline'}>{g.enabled ? '启用' : '停用'}</Badge>
            </a>
          </li>
        ))}
      </ul>
      <div className="space-y-1 rounded-xl border p-3 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">文件在哪</p>
        <p className="font-mono">~/.local/share/pimu/bots/&lt;bot&gt;/MEMORY.md · log/YYYY-MM-DD.md</p>
        <p className="font-mono">…/bots/&lt;bot&gt;/goals/&lt;slug&gt;/GOAL.md · STATE.md · findings.md</p>
        <p>心跳会话 id 形如 pimu-g&lt;目标&gt;-b&lt;心跳&gt;，不出现在首页列表。</p>
      </div>
    </section>
  )
}
