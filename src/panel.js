import { coerce, formatValue, stepValue, visibleLayout } from './settings.js';
import { UsageError } from './util.js';

const ESC = '\x1b[';
const BAR = 8;

const visLen = (s) => Array.from(s).length;
const fit = (s, n) => {
  const chars = Array.from(s);
  return chars.length > n ? `${chars.slice(0, Math.max(0, n - 1)).join('')}…` : s.padEnd(n);
};

/**
 * The settings sidebar: the terminal's version of the app's controls panel.
 * It shows exactly the controls the app shows for the current style (same sections, same rules), plus a
 * "View" section for this CLI's own choices (look, render mode).
 */
export class Panel {
  /**
   * @param defaults  the engine's default settings (for "reset to default")
   * @param lookLabel (id) => human label for a look
   */
  constructor({ defaults, lookLabel = (id) => id }) {
    this.defaults = defaults;
    this.lookLabel = lookLabel;
    this.index = 0; // selected row among the selectable ones
    this.scroll = 0;
    this.editing = null; // { row, buffer }
    this.notice = '';
  }

  /** All rows for this state: headers and selectable items. */
  rows(settings, { look, mode }) {
    const rows = [{ header: 'View' }];
    rows.push({ id: '@look', type: 'look', label: 'Look', value: this.lookLabel(look) });
    rows.push({ id: '@render', type: 'render', label: 'Render', value: mode });
    for (const section of visibleLayout(settings)) {
      rows.push({ header: section.title });
      for (const control of section.controls) {
        rows.push({ id: control.key, type: 'control', control, label: control.label, value: settings[control.key] });
      }
    }
    return rows;
  }

  selectable(rows) {
    return rows.map((r, i) => (r.header ? -1 : i)).filter((i) => i >= 0);
  }

  /** Whether the panel is capturing typed text (so global shortcuts must not fire). */
  get typing() {
    return this.editing !== null;
  }

  /**
   * Handle one key. Returns an action for the viewer, or null:
   *   { type: 'set', key, value } | { type: 'look', dir } | { type: 'mode', dir } | { type: 'close' }
   */
  handleKey(key, settings, ctx) {
    const rows = this.rows(settings, ctx);
    const sel = this.selectable(rows);
    this.index = Math.min(Math.max(this.index, 0), sel.length - 1);
    const row = rows[sel[this.index]];
    this.notice = '';

    if (this.editing) return this.#edit(key, row);

    switch (key) {
      case 'up':
        this.index = (this.index - 1 + sel.length) % sel.length;
        return null;
      case 'down':
        this.index = (this.index + 1) % sel.length;
        return null;
      case 'pageup':
        this.index = Math.max(0, this.index - 8);
        return null;
      case 'pagedown':
        this.index = Math.min(sel.length - 1, this.index + 8);
        return null;
      case 'home':
        this.index = 0;
        return null;
      case 'end':
        this.index = sel.length - 1;
        return null;
      case 'tab':
      case 'escape':
      case 'm':
        return { type: 'close' };
      case 'left':
      case 'right':
      case 'S-left':
      case 'S-right':
        return this.#adjust(row, key.endsWith('right') ? 1 : -1, key.startsWith('S-'));
      case 'enter':
      case 'space':
        if (row.type === 'control' && (row.control.type === 'text' || row.control.type === 'color')) {
          this.editing = { buffer: String(row.value) };
          return null;
        }
        return this.#adjust(row, 1, false);
      case 'd':
      case 'backspace':
      case 'delete':
        if (row.type === 'control' && this.defaults[row.id] !== undefined && this.defaults[row.id] !== row.value) {
          return { type: 'set', key: row.id, value: this.defaults[row.id] };
        }
        return null;
      default:
        return null;
    }
  }

  #adjust(row, dir, big) {
    if (row.type === 'look') return { type: 'look', dir };
    if (row.type === 'render') return { type: 'mode', dir };
    const c = row.control;
    if (c.type === 'text' || c.type === 'color') {
      this.editing = { buffer: String(row.value) };
      return null;
    }
    const value = stepValue(c, row.value, dir, big);
    return value === row.value ? null : { type: 'set', key: row.id, value };
  }

  #edit(key, row) {
    const e = this.editing;
    if (key === 'escape') {
      this.editing = null;
      return null;
    }
    if (key === 'enter') {
      try {
        const value = coerce(row.control, e.buffer);
        this.editing = null;
        return { type: 'set', key: row.id, value };
      } catch (err) {
        if (!(err instanceof UsageError)) throw err;
        this.notice = err.message;
        return null;
      }
    }
    if (key === 'backspace') e.buffer = Array.from(e.buffer).slice(0, -1).join('');
    else if (key === 'space') e.buffer += ' ';
    else if (visLen(key) === 1) e.buffer += key;
    return null;
  }

  /**
   * The panel as `height` lines of exactly `width` columns.
   * @param ctx { look, mode, modeNote } modeNote: text shown when the selected setting needs another render mode
   */
  render(width, height, settings, ctx) {
    const rows = this.rows(settings, ctx);
    const sel = this.selectable(rows);
    this.index = Math.min(Math.max(this.index, 0), sel.length - 1);
    const selected = sel[this.index];

    const footer = 3;
    const body = Math.max(3, height - footer);
    // keep the selected row (and its header) in view
    if (selected < this.scroll) this.scroll = rows[selected - 1]?.header ? selected - 1 : selected;
    if (selected >= this.scroll + body) this.scroll = selected - body + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - body)));

    const out = [];
    for (let i = this.scroll; i < Math.min(rows.length, this.scroll + body); i++) {
      const r = rows[i];
      if (r.header) {
        out.push(`${ESC}1m${fit(`── ${r.header} `.padEnd(width, '─'), width)}${ESC}0m`);
        continue;
      }
      const isSel = i === selected;
      const inactive = r.type === 'control' && ctx.mode === 'text' && r.control.where === 'image';
      let value;
      let bar = '';
      if (this.editing && isSel) value = `${this.editing.buffer}▏`;
      else if (r.type === 'control') {
        value = formatValue(r.control, r.value);
        if (r.control.type === 'range') {
          const f = (r.value - r.control.min) / (r.control.max - r.control.min);
          const n = Math.round(Math.max(0, Math.min(1, f)) * BAR);
          bar = `${'█'.repeat(n)}${'░'.repeat(BAR - n)} `;
        }
      } else value = String(r.value);
      const right = `${bar}${value}`;
      const labelW = Math.max(4, width - 2 - visLen(right) - 1);
      const line = `${isSel ? '▸' : ' '} ${fit(r.label, labelW)} ${right}`;
      const text = fit(line, width);
      out.push(`${isSel ? `${ESC}7m` : inactive ? `${ESC}2m` : ''}${text}${ESC}0m`);
    }
    while (out.length < body) out.push(' '.repeat(width));

    // footer: help for the selected row, then the keys
    const row = rows[selected];
    let help = '';
    if (this.notice) help = this.notice;
    else if (this.editing) help = 'type, Enter to apply, Esc to cancel';
    else if (row.type === 'control') {
      help = ctx.mode === 'text' && row.control.where === 'image' ? 'needs image rendering (press v)' : (row.control.note ?? '');
      if (row.control.type === 'range') help = `${row.control.min}–${row.control.max}${help ? ` · ${help}` : ''}`;
    } else if (row.type === 'look') help = ctx.lookHint ?? '';
    else if (row.type === 'render') help = ctx.modeNote ?? '';
    out.push(`${ESC}2m${fit(help, width)}${ESC}0m`);
    out.push(`${ESC}2m${fit('↑↓ select  ←→ change  ⇧←→ ×10', width)}${ESC}0m`);
    out.push(`${ESC}2m${fit('Enter edit  d default  Tab close', width)}${ESC}0m`);
    return out.slice(0, height);
  }
}

