import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCss, color, colorTokens, contrast, generatePalette, normalizeStyle, paletteChecks, readableOn } from '../sidecars/theme/palette.mjs';

test('color 归一化支持 3/4/6/8 位 HEX', () => {
  assert.equal(color('#ABC'), '#aabbcc');
  assert.equal(color(' #326bb5 '), '#326bb5');
  assert.equal(color('#abcd'), '#aabbccdd');
  assert.equal(color('#326bb5cc'), '#326bb5cc');
  assert.throws(() => color('#12345'), /HEX/);
  assert.throws(() => color('blue'), /HEX/);
  assert.throws(() => color(undefined), /HEX/);
});

test('contrast 计算 WCAG 比值，透明背板返回 null', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
  assert.equal(contrast('#ffffff', '#ffffff'), 1);
  assert.equal(contrast('#000000', '#ffffff', '#ffffff80'), null);
});

test('readableOn 选对比度更高的前景色', () => {
  assert.equal(readableOn('#ffffff'), '#000000');
  assert.equal(readableOn('#000000'), '#ffffff');
});

test('generatePalette 由底色与主色推出整套令牌', () => {
  const colors = generatePalette('#ffffff', '#2f75c3');
  assert.equal(colors['--background'], '#ffffff');
  assert.equal(colors['--foreground'], '#000000');
  assert.equal(colors['--primary'], '#2f75c3');
  assert.equal(colors['--primary-foreground'], '#ffffff');
  for (const name of ['--card', '--sidebar', '--border', '--muted-foreground', '--accent']) {
    assert.match(colors[name], /^#[0-9a-f]{6}$/, name);
  }
  assert.throws(() => generatePalette('#ffffff80', '#2f75c3'), /不透明/);
});

test('paletteChecks 报告六对数对与 4.5 阈值', () => {
  const colors = { '--background': '#ffffff', '--foreground': '#101010', '--primary': '#007acc', '--primary-foreground': '#ffffff' };
  const checks = paletteChecks(colors);
  assert.equal(checks.length, 6);
  assert.equal(checks[0].label, '正文');
  assert.ok(checks.every((item) => typeof item.label === 'string' && typeof item.passes === 'boolean'));
  assert.ok(checks.some((item) => item.passes));
  assert.ok(checks.some((item) => item.ratio === null));
});

test('colorTokens 覆盖背景、文字与强调三类', () => {
  assert.ok(colorTokens.length >= 19);
  for (const name of ['background', 'foreground', 'primary', 'border', 'card', 'sidebar']) assert.ok(colorTokens.includes(name));
});

test('normalizeStyle 校验令牌名、数量与取值边界', () => {
  assert.throws(() => normalizeStyle({ colors: { 'background': '#fff' } }), /令牌名/);
  assert.throws(() => normalizeStyle({ colors: { '--background': '#fff' }, radius: 40 }), /圆角/);
  assert.throws(() => normalizeStyle({ colors: {}, texture: 'fancy' }), /外观/);
  assert.throws(() => normalizeStyle({ colors: {}, uiFont: 'comic' }), /字体/);
  assert.throws(() => normalizeStyle({ colors: {}, hiddenSections: ['sidebar'] }), /隐藏/);
  const many = {};
  for (let index = 0; index < 201; index++) many['--token-' + index] = '#ffffff';
  assert.throws(() => normalizeStyle({ colors: many }), /200/);
  const style = normalizeStyle({ colors: { '--shell': '#fafafa', '--chart-1': '#2f75c3' }, hiddenSections: ['project-sidebar'], radius: 12 });
  assert.equal(style.colors['--shell'], '#fafafa');
  assert.deepEqual(style.hiddenSections, ['project-sidebar']);
  assert.equal(style.radius, 12);
});

test('buildCss 输出 !important 变量与圆角规则', () => {
  const css = buildCss({ colors: { '--background': '#fff', '--shell': '#fafafa' }, radius: 12, fontScale: 1.1 });
  assert.match(css, /--background: #ffffff !important;/);
  assert.match(css, /--shell: #fafafa !important;/);
  assert.match(css, /--radius-md: 12px !important;/);
  assert.match(css, /font-size: 110% !important;/);
});