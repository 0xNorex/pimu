import { cn } from 'cn'

// FNV-1a: a stable 32-bit hash of the bot id.
function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

// GitHub-style identicon: a 5x5 grid mirrored left/right, one hue per id.
export function BotAvatar({ id, className }: { id: string; className?: string }) {
  const bits = hash(id)
  const hue = hash(`${id}:hue`) % 360
  const cells: [number, number][] = []
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 3; x++)
      if ((bits >>> (y * 3 + x)) & 1) {
        cells.push([x, y])
        if (x < 2) cells.push([4 - x, y])
      }
  return (
    <span aria-hidden className={cn('flex size-11 shrink-0 overflow-hidden rounded-full ring-1 ring-black/5 ring-inset dark:ring-white/10', className)} style={{ background: `hsl(${hue} 45% 92%)` }}>
      <svg viewBox="-1 -1 7 7" className="size-full" shapeRendering="crispEdges">
        {cells.map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={`hsl(${hue} 60% 48%)`} />
        ))}
      </svg>
    </span>
  )
}
