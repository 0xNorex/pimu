import type { MouseEvent, ReactNode } from 'react'
import { CheckIcon, MonitorIcon, MoonIcon, RotateCcwIcon, SunIcon } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { DEFAULTS, haptic, reveal, setPrefs, usePrefs, type Prefs } from '@/lib/prefs'

// Linear / Raycast-style: a few curated looks, everything else is a small knob.
const PALETTES: [Prefs['palette'], string, string][] = [
  ['paper', '纸张', '暖白 · 靛蓝'],
  ['neutral', '石墨', '纯中性 · 黑白'],
  ['ocean', '海洋', '冷蓝 · 青'],
  ['forest', '森林', '苔绿 · 松'],
  ['rose', '玫瑰', '暖粉 · 珊瑚'],
  ['contrast', '高对比', '清晰 · 无障碍'],
]

// A segmented control whose pill springs between options.
function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, ReactNode][]; onChange: (v: T, e: MouseEvent) => void; label: string }) {
  const i = Math.max(0, options.findIndex(([v]) => v === value))
  return (
    <div role="radiogroup" aria-label={label} className="relative grid shrink-0 rounded-[calc(var(--radius)*0.9)] bg-foreground/[0.055] p-[3px]" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      <span
        aria-hidden
        className="seg-pill absolute inset-y-[3px] left-[3px] rounded-[calc(var(--radius)*0.7)] bg-background shadow-[0_1px_2px_oklch(0_0_0/10%),0_2px_8px_-2px_oklch(0_0_0/10%)] dark:bg-foreground/[0.11]"
        style={{ width: `calc((100% - 6px) / ${options.length})`, transform: `translateX(${i * 100}%)` }}
      />
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={v === value}
          onClick={(e) => v !== value && onChange(v, e)}
          className="relative z-10 flex h-8 min-w-11 items-center justify-center gap-1.5 rounded-[calc(var(--radius)*0.7)] px-2.5 text-[13px] font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring aria-checked:text-foreground"
        >
          {l}
        </button>
      ))}
    </div>
  )
}

function Row({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[15px]">{title}</div>
        {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
      </div>
      {children}
    </div>
  )
}
function Group({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="px-1 text-[13px] font-medium text-muted-foreground">{title}</h2>
      <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-soft">{children}</div>
      {hint && <p className="px-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </section>
  )
}

// A miniature Pimu painted with the palette's own tokens (data-palette re-derives them locally).
function Swatch({ id, name, sub, on, pick }: { id: Prefs['palette']; name: string; sub: string; on: boolean; pick: (e: MouseEvent) => void }) {
  return (
    <button type="button" role="radio" aria-checked={on} aria-label={`配色：${name}`} onClick={pick} className="group pressable text-left outline-none">
      <div
        data-palette={id}
        className={`relative flex h-[76px] overflow-hidden rounded-[calc(var(--radius)*1.1)] border bg-background transition-[box-shadow,transform] duration-300 group-hover:-translate-y-0.5 group-hover:shadow-(--shadow-lift) group-focus-visible:ring-2 group-focus-visible:ring-ring ${on ? 'ring-2 ring-primary ring-offset-2 ring-offset-card' : ''}`}
      >
        <div className="flex w-[30%] flex-col gap-1 border-r bg-sidebar p-1.5">
          <span className="h-2.5 rounded-[3px] bg-accent" />
          <span className="h-1.5 w-3/4 rounded-full bg-foreground/15" />
          <span className="h-1.5 w-1/2 rounded-full bg-foreground/15" />
        </div>
        <div className="flex flex-1 flex-col justify-end gap-1 p-1.5">
          <span className="h-1.5 w-4/5 rounded-full bg-muted-foreground/35" />
          <span className="h-1.5 w-3/5 rounded-full bg-muted-foreground/25" />
          <span className="ml-auto h-3.5 w-1/2 rounded-[6px] rounded-br-[2px] bg-bubble" />
          <span className="mt-0.5 h-3 rounded-full border bg-card" />
        </div>
        {on && (
          <span className="dot-in absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <CheckIcon className="size-2.5" strokeWidth={3} />
          </span>
        )}
      </div>
      <div className="mt-1.5 px-0.5">
        <div className="text-[13px] font-medium">{name}</div>
        <div className="text-[11px] text-muted-foreground">{sub}</div>
      </div>
    </button>
  )
}

// What the knobs do, live: one exchange in the real chat styles.
function Preview() {
  return (
    <div className="space-y-2 bg-background/60 px-4 py-4 text-(length:--chat-fs) leading-relaxed">
      <div className="mx-auto flex max-w-(--chat-w) flex-col gap-(--msg-gap)">
        <div className="ml-auto max-w-[80%] rounded-[calc(var(--radius)*1.66)] rounded-br-md bg-bubble px-3.5 py-2 text-bubble-foreground shadow-soft">把周报整理成三点</div>
        <div className="prose-pimu">
          <p>好的，这周的重点是：</p>
          <pre>{'const done = ["发布 V15", "e2e 全绿"]'}</pre>
        </div>
      </div>
    </div>
  )
}

export function AppearanceSection() {
  const p = usePrefs()
  const set = (patch: Partial<Prefs>) => {
    haptic()
    setPrefs(patch)
  }
  const changed = (Object.keys(DEFAULTS) as (keyof Prefs)[]).some((k) => p[k] !== DEFAULTS[k])
  return (
    <>
      <Group title="主题">
        <Row title="模式" sub="跟随系统会随白天 / 夜间自动切换">
          <Seg
            label="模式"
            value={p.theme}
            onChange={(theme, e) => reveal({ theme }, e)}
            options={[
              ['light', <><SunIcon className="size-3.5" />浅色</>],
              ['dark', <><MoonIcon className="size-3.5" />深色</>],
              ['system', <><MonitorIcon className="size-3.5" />系统</>],
            ]}
          />
        </Row>
        <div role="radiogroup" aria-label="配色" className="grid grid-cols-2 gap-x-3 gap-y-4 p-4 sm:grid-cols-3">
          {PALETTES.map(([id, name, sub]) => (
            <Swatch key={id} id={id} name={name} sub={sub} on={p.palette === id} pick={(e) => p.palette !== id && reveal({ palette: id }, e)} />
          ))}
        </div>
      </Group>

      <Group title="阅读" hint="预览即实际效果：字号、宽度、间距和圆角都作用于对话页。">
        <Preview />
        <Row title="字号">
          <Seg label="字号" value={p.font} onChange={(font) => set({ font })} options={[['s', '小'], ['m', '中'], ['l', '大']]} />
        </Row>
        <Row title="对话宽度" sub="宽屏上消息列的最大宽度">
          <Seg label="对话宽度" value={p.width} onChange={(width) => set({ width })} options={[['narrow', '窄'], ['normal', '标准'], ['wide', '宽']]} />
        </Row>
        <Row title="密度">
          <Seg label="密度" value={p.density} onChange={(density) => set({ density })} options={[['comfortable', '舒适'], ['compact', '紧凑']]} />
        </Row>
        <Row title="圆角">
          <Seg label="圆角" value={p.radius} onChange={(radius) => set({ radius })} options={[['sharp', '方正'], ['normal', '标准'], ['round', '圆润']]} />
        </Row>
        <Row title="代码字体">
          <Seg label="代码字体" value={p.mono} onChange={(mono) => set({ mono })} options={[['geist', 'Geist Mono'], ['system', '系统']]} />
        </Row>
        <Row title="代码块">
          <Seg label="代码块" value={p.code} onChange={(code) => set({ code })} options={[['soft', '柔和'], ['ink', '墨色']]} />
        </Row>
      </Group>

      <Group title="动效与质感">
        <Row title="动效" sub="减弱：循环动画只播一次，不做页面转场">
          <Seg label="动效" value={p.motion} onChange={(motion) => set({ motion })} options={[['system', '系统'], ['full', '完整'], ['reduced', '减弱'], ['off', '关闭']]} />
        </Row>
        <Row title="纸张纹理" sub="极淡的颗粒感，高对比配色下自动关闭">
          <Switch checked={p.texture} onCheckedChange={(texture) => set({ texture })} aria-label="纸张纹理" />
        </Row>
        <Row title="触感反馈" sub="发送时轻震（仅部分 Android 浏览器）">
          <Switch checked={p.haptics} onCheckedChange={(haptics) => set({ haptics })} aria-label="触感反馈" />
        </Row>
      </Group>

      <Group title="对话" hint="外观与对话偏好保存在本机，并同步到你登录 Pimu 的其他设备。">
        <Row title="默认展开思考过程">
          <Switch checked={p.thinking} onCheckedChange={(thinking) => set({ thinking })} aria-label="默认展开思考过程" />
        </Row>
        <Row title="默认展开工具调用">
          <Switch checked={p.tools} onCheckedChange={(tools) => set({ tools })} aria-label="默认展开工具调用" />
        </Row>
        <Row title="发送" sub="另一种组合换行；手机上回车总是换行">
          <Seg label="发送键" value={p.sendKey} onChange={(sendKey) => set({ sendKey })} options={[['enter', 'Enter'], ['mod', '⌘ Enter']]} />
        </Row>
      </Group>

      {changed && (
        <button type="button" onClick={(e) => reveal({ ...DEFAULTS }, e)} className="pressable mx-auto flex h-10 items-center gap-2 rounded-full px-4 text-sm text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground">
          <RotateCcwIcon className="size-3.5" /> 恢复默认外观
        </button>
      )}
    </>
  )
}
