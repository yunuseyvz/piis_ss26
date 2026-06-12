/**
 * Central icon system for FlowQuest.
 *
 * The whole UI is hand-rolled DOM built from `innerHTML` string templates, so
 * we render icons as inline SVG strings rather than mounting components. Icons
 * come from the framework-agnostic `lucide` package, whose named exports are
 * `IconNode` arrays (`[tag, attrs][]`) describing the children of a 24×24
 * stroke SVG. `renderIcon` wraps a node into a themed `<svg>`; `icon(name)`
 * resolves a semantic name to its node.
 *
 * Conventions:
 *   - Icons inherit `currentColor` and size to `1em` by default, so they line
 *     up with the surrounding text and follow the JupyterLab theme.
 *   - Every meaningful glyph in the UI maps to a semantic name here. This keeps
 *     icon choices in one place and the rest of the code emoji-free.
 */

import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  Brain,
  BrainCircuit,
  Brush,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Compass,
  Database,
  Eye,
  Files,
  FileText,
  Flame,
  Gauge,
  Globe,
  HelpCircle,
  Leaf,
  Lightbulb,
  Lock,
  MessageCircle,
  MessageCircleQuestion,
  Mountain,
  NotebookText,
  OctagonAlert,
  PanelRight,
  PenLine,
  RefreshCw,
  Search,
  SendHorizontal,
  Settings,
  Shapes,
  Sparkles,
  Speech,
  Star,
  Target,
  Terminal,
  Timer,
  Trash2,
  Trophy,
  WifiOff,
  Wrench,
  X
} from 'lucide';

/** A lucide icon node — the children of the 24×24 viewBox SVG. */
export type IconNode = ReadonlyArray<readonly [string, Record<string, string | number>]>;

export interface IconOptions {
  /** CSS size for width + height. Defaults to `1em` so it tracks font-size. */
  size?: number | string;
  /** Extra class names appended to `flowquest-icon`. */
  className?: string;
  /** Override the stroke width (lucide default is 2). */
  strokeWidth?: number;
}

function attrsToString(attrs: Record<string, string | number>): string {
  return Object.entries(attrs)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ');
}

/** Render a lucide `IconNode` into a themed inline-SVG string. */
export function renderIcon(node: IconNode, opts: IconOptions = {}): string {
  const size = typeof opts.size === 'number' ? `${opts.size}px` : opts.size ?? '1em';
  const className = ['flowquest-icon', opts.className].filter(Boolean).join(' ');
  const children = node
    .map(([tag, attrs]) => `<${tag} ${attrsToString(attrs)} />`)
    .join('');
  return (
    `<svg class="${className}" xmlns="http://www.w3.org/2000/svg" ` +
    `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="${opts.strokeWidth ?? 2}" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">` +
    `${children}</svg>`
  );
}

/** Semantic icon registry. Keys are used across the UI; values are nodes. */
const ICONS = {
  // Brand + chrome
  brand: Compass,
  settings: Settings,
  handbook: HelpCircle,
  refresh: RefreshCw,
  rescan: RefreshCw,
  close: X,
  send: SendHorizontal,
  open: PanelRight,
  chevronRight: ChevronRight,
  chevronDown: ChevronDown,
  globe: Globe,
  trash: Trash2,
  // XP categories / mission kinds
  exploration: Compass,
  understanding: Brain,
  stabilization: Wrench,
  reflection: PenLine,
  // Issue severities
  info: Lightbulb,
  warn: AlertTriangle,
  error: OctagonAlert,
  // Sidebar tabs
  quest: Trophy,
  flowy: Bot,
  chat: MessageCircle,
  // Difficulty levels
  easy: Leaf,
  medium: Mountain,
  hard: Flame,
  // Between-cell activity kinds
  quiz: Target,
  predict: Eye,
  teachback: Speech,
  // Cell regions
  'region-setup': Settings,
  'region-load': Database,
  'region-clean': Brush,
  'region-explore': Search,
  'region-visualize': BarChart3,
  'region-model': BrainCircuit,
  'region-output': Terminal,
  'region-narrative': FileText,
  'region-other': Shapes,
  // Misc semantic glyphs
  sparkles: Sparkles,
  star: Star,
  check: Check,
  cross: X,
  success: CheckCircle2,
  hint: Lightbulb,
  explain: Lightbulb,
  reflect: MessageCircleQuestion,
  diagnostics: Activity,
  missions: Trophy,
  checkpoint: Target,
  contextNotebook: NotebookText,
  contextWorkspace: Files,
  reveal: Eye,
  question: HelpCircle,
  // Error kinds (mirrors uiFeedback)
  timeout: Timer,
  rate_limit: Gauge,
  auth: Lock,
  network: WifiOff,
  http: AlertTriangle,
  other: AlertTriangle
} as const;

export type IconName = keyof typeof ICONS;

/** Render a semantic icon by name. */
export function icon(name: IconName, opts?: IconOptions): string {
  return renderIcon(ICONS[name] as IconNode, opts);
}

/** Region name (from the analyzer) → region icon. Falls back to "other". */
export function regionIcon(region: string | null | undefined, opts?: IconOptions): string {
  const key = `region-${(region ?? 'other').toLowerCase()}` as IconName;
  const node = (ICONS[key] ?? ICONS['region-other']) as IconNode;
  return renderIcon(node, opts);
}

/** XP category / mission kind → icon. */
export function categoryIcon(kind: string | null | undefined, opts?: IconOptions): string {
  const key = (kind ?? '') as IconName;
  const node = (ICONS[key] ?? ICONS.sparkles) as IconNode;
  return renderIcon(node, opts);
}

/** Between-cell activity kind → icon. */
export function activityIcon(kind: string | null | undefined, opts?: IconOptions): string {
  const key = (kind ?? '') as IconName;
  const node = (ICONS[key] ?? ICONS.checkpoint) as IconNode;
  return renderIcon(node, opts);
}

/** Difficulty level → icon. */
export function difficultyIcon(level: string | null | undefined, opts?: IconOptions): string {
  const normalized = (level ?? 'medium').toLowerCase();
  const key = (normalized === 'easy' || normalized === 'hard' ? normalized : 'medium') as IconName;
  return renderIcon(ICONS[key] as IconNode, opts);
}

/** Error kind → icon (mirrors uiFeedback error classification). */
export function errorIconSvg(kind: string | null | undefined, opts?: IconOptions): string {
  const key = (kind ?? 'other') as IconName;
  const node = (ICONS[key] ?? ICONS.other) as IconNode;
  return renderIcon(node, opts);
}
