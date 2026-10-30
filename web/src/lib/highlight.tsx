import type { ReactNode } from 'react'

// Tiny JavaScript highlighter for codemode scripts: comments, strings, keywords, numbers.
const TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\b(const|let|var|await|async|return|if|else|for|of|in|while|function|new|try|catch|finally|throw|true|false|null|undefined|typeof)\b|\b(\d+(?:\.\d+)?)\b/g
const CLASS = ['', 'text-muted-foreground italic', 'text-emerald-700 dark:text-emerald-400', 'text-violet-700 dark:text-violet-400', 'text-amber-700 dark:text-amber-400']

export function highlightJS(code: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of code.matchAll(TOKEN)) {
    if (m.index > last) out.push(code.slice(last, m.index))
    const g = m.slice(1).findIndex((x) => x !== undefined) + 1
    out.push(<span key={m.index} className={CLASS[g]}>{m[0]}</span>)
    last = m.index + m[0].length
  }
  out.push(code.slice(last))
  return out
}
