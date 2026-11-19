export const colorTokens = [
  'background', 'content', 'card', 'sidebar', 'card-border', 'border', 'foreground',
  'muted-foreground', 'placeholder', 'code-foreground', 'primary', 'primary-foreground',
  'secondary', 'secondary-foreground', 'accent', 'link', 'success', 'warning', 'error',
];

export const fonts = {
  system: 'system-ui, "Segoe UI", sans-serif',
  chinese: '"Source Han Sans SC", "Microsoft YaHei", sans-serif',
  mono: '"Cascadia Mono", Consolas, monospace',
};

const hexPattern = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;

export function color(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!hexPattern.test(input)) throw new Error('请输入 HEX 颜色，例如 #326bb5 或 #326bb5cc。');
  const digits = input.slice(1).toLowerCase();
  return '#' + (digits.length < 5 ? [...digits].map((digit) => digit.repeat(2)).join('') : digits);
}

function rgba(value) {
  const digits = color(value).slice(1).match(/../g);
  const [r, g, b, a = 255] = digits.map((digit) => Number.parseInt(digit, 16));
  return [r, g, b, a / 255];
}

function luminance(rgb) {
  const linear = rgb.slice(0, 3).map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function composite(foreground, background) {
  return background.slice(0, 3).map((channel, index) => foreground[index] * foreground[3] + channel * (1 - foreground[3]));
}

export function contrast(foreground, background, backing = '#ffffff') {
  const behind = rgba(backing);
  if (behind[3] < 1) return null;
  const surface = composite(rgba(background), behind);
  const values = [luminance(composite(rgba(foreground), surface)), luminance(surface)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

function mix(first, second, weight) {
  const target = rgba(second);
  return '#' + rgba(first).slice(0, 3)
    .map((channel, index) => Math.round(channel * (1 - weight) + target[index] * weight).toString(16).padStart(2, '0'))
    .join('');
}

export function readableOn(surface) {
  return contrast('#000000', surface) >= contrast('#ffffff', surface) ? '#000000' : '#ffffff';
}

export function generatePalette(base, accent) {
  const background = color(base);
  const primary = color(accent);
  if (background.length !== 7 || primary.length !== 7) throw new Error('自动配板需要不透明底色和主色。');
  const foreground = readableOn(background);
  const direction = foreground === '#000000' ? '#ffffff' : '#000000';
  const card = mix(background, direction, 0.18);
  const sidebar = mix(background, direction, 0.32);
  const surfaces = [background, card, sidebar];
  let muted = foreground;
  for (let blend = 0.44; blend > 0; blend -= 0.02) {
    const candidate = mix(foreground, background, blend);
    if (surfaces.every((surface) => contrast(candidate, surface) >= 4.5)) {
      muted = candidate;
      break;
    }
  }
  return {
    '--background': background,
    '--card': card,
    '--sidebar': sidebar,
    '--border': mix(background, foreground, 0.24),
    '--foreground': foreground,
    '--muted-foreground': muted,
    '--primary': primary,
    '--primary-foreground': readableOn(primary),
    '--accent': mix(card, primary, 0.13),
  };
}

export function paletteChecks(colors) {
  const pairs = [
    ['正文', '--foreground', '--background'],
    ['次要文字', '--muted-foreground', '--background'],
    ['卡片文字', '--foreground', '--card'],
    ['侧栏文字', '--foreground', '--sidebar'],
    ['侧栏次要文字', '--muted-foreground', '--sidebar'],
    ['主按钮文字', '--primary-foreground', '--primary'],
  ];
  return pairs.map(([label, text, surface]) => {
    const background = colors['--background'];
    const ratio = colors[text] && colors[surface] && background
      ? contrast(colors[text], colors[surface], background) : null;
    return { label, ratio, passes: ratio !== null && ratio >= 4.5 };
  });
}

function boundedNumber(value, minimum, maximum, label) {
  if (value === '' || value === null || value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error(label + '超出范围。');
  return number;
}

export function normalizeStyle(spec = {}) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('主题样式应为对象。');
  const normalizedColors = {};
  for (const [name, value] of Object.entries(spec.colors || {})) {
    if (!/^--[\w-]{1,100}$/.test(name)) throw new Error('无效的令牌名 ' + name);
    if (value) normalizedColors[name] = color(value);
  }
  if (Object.keys(normalizedColors).length > 200) throw new Error('一套主题最多包含 200 个颜色令牌。');
  const hiddenSections = spec.hiddenSections || [];
  if (!Array.isArray(hiddenSections) || hiddenSections.length > 8
      || hiddenSections.some((item) => typeof item !== 'string'
        || !/^(?:conversation-(?:navigator|outline)|project-sidebar|overview-(?:links|files|artifacts|uploads))$/.test(item))) {
    throw new Error('仅支持隐藏侧栏、会话导航和概览里的展示区块。');
  }
  const style = {
    colors: normalizedColors,
    hiddenSections,
    radius: boundedNumber(spec.radius, 0, 24, '圆角'),
    fontScale: boundedNumber(spec.fontScale, 0.75, 1.5, '字号'),
    lineHeight: boundedNumber(spec.lineHeight, 1.15, 2, '行高'),
    sidebarWidth: boundedNumber(spec.sidebarWidth, 180, 420, '侧栏宽度'),
    uiFont: spec.uiFont || '',
    editorFont: spec.editorFont || '',
    texture: spec.texture || '',
    density: spec.density || '',
    scrollbars: spec.scrollbars || '',
  };
  if ([style.uiFont, style.editorFont].some((font) => font && !Object.hasOwn(fonts, font))) throw new Error('未知字体选项。');
  if (!['', 'flat', 'glass', 'hard'].includes(style.texture)
      || !['', 'compact', 'relaxed'].includes(style.density)
      || !['', 'thin', 'auto'].includes(style.scrollbars)) throw new Error('未知外观选项。');
  return style;
}

export function buildCss(spec) {
  const style = normalizeStyle(spec);
  const tokens = Object.entries(style.colors).map(([name, value]) => `  ${name}: ${value} !important;`);
  const rules = [];
  if (style.uiFont) rules.push(`body { font-family: ${fonts[style.uiFont]} !important; }`);
  if (style.editorFont) tokens.push(`  --editor-font-family: ${fonts[style.editorFont]} !important;`);
  if (style.fontScale !== undefined) rules.push(`html { font-size: ${Math.round(style.fontScale * 100)}% !important; }`);
  if (style.radius !== undefined) {
    const radius = `${style.radius}px`;
    tokens.push(...['sm', 'md', 'lg', 'xl'].map((size) => `  --radius-${size}: ${radius} !important;`));
    rules.push(`[data-testid="agent-input-box"] { border-radius: ${radius} !important; }`);
  }
  if (style.lineHeight !== undefined) {
    rules.push(`[data-testid="conversation-view"] :is(p, li, pre) { line-height: ${style.lineHeight} !important; }`);
  }
  if (style.density) {
    const spacing = style.density === 'compact' ? '0.45em' : '0.9em';
    rules.push(`[data-testid="conversation-view"] :is(p, ul, ol, pre) { margin-block: ${spacing} !important; }`);
  }
  if (style.sidebarWidth !== undefined) {
    rules.push(`[data-testid="project-sidebar"] { width: min(${style.sidebarWidth}px, 48vw) !important; min-width: 0 !important; }`);
  }
  for (const section of style.hiddenSections) {
    rules.push(`[data-testid="${section}"] { display: none !important; }`);
  }
  if (style.scrollbars) rules.push(`* { scrollbar-width: ${style.scrollbars}; }`);
  if (style.texture) {
    const shadow = { flat: 'none', glass: '0 6px 24px #0002', hard: '3px 3px 0 #0003' }[style.texture];
    tokens.push(...['sm', 'md', 'lg'].map((size) => `  --shadow-${size}: ${shadow} !important;`));
    if (style.texture === 'glass') {
      rules.push('[data-testid="agent-input-box"] { backdrop-filter: blur(12px); background-color: color-mix(in srgb, var(--card) 86%, transparent); }');
    }
  }
  return [...(tokens.length ? [':root {', ...tokens, '}'] : []), ...rules].join('\n');
}

export function normalizePack(input) {
  if (input?.version !== 1 || typeof input.name !== 'string' || !input.name.trim()) throw new Error('主题配方需要 version=1 和名称。');
  return { version: 1, name: input.name.trim().slice(0, 60), style: normalizeStyle(input.style) };
}
