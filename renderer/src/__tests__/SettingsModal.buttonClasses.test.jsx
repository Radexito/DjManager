import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

const settingsJsx = fs.readFileSync(path.join(dirname, '../SettingsModal.jsx'), 'utf8');
const settingsCss = fs.readFileSync(path.join(dirname, '../SettingsModal.css'), 'utf8');
const indexCss = fs.readFileSync(path.join(dirname, '../index.css'), 'utf8');
const allCss = `${indexCss}\n${settingsCss}`;

/** Is `name` defined as a CSS class selector in the given stylesheet text? */
function isDefined(stylesheet, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\.${escaped}(?![\\w-])`).test(stylesheet);
}

/** Every class token the component applies, in source order. */
function classTokens(jsx) {
  return [...jsx.matchAll(/className="([^"]+)"/g)]
    .flatMap((m) => m[1].split(/\s+/))
    .filter(Boolean);
}

// Regression for #503: the "Regenerate all waveforms" button was written with
// className="btn", a class that does not exist in any stylesheet. index.css
// styles bare `button` with `background-color: #1a1a1a`, which is exactly the
// modal's surface colour, so the button rendered as an unlabelled dark shape
// with nothing looking clickable. Every action button in this modal uses one of
// the defined .btn-primary / .btn-secondary / .btn-danger classes.
describe('SettingsModal button classes (#503)', () => {
  it('uses a defined class for the regenerate-waveforms action', () => {
    expect(settingsJsx).not.toContain('className="btn"');

    const row = settingsJsx.match(
      /className="(btn[^"]*)"\s*\n\s*onClick=\{\(\) => handleGenerateWaveformsLibrary\(true\)\}/
    );
    expect(row).toBeTruthy();
    expect(row[1]).toBe('btn-primary');
  });

  it('never applies the undefined bare `btn` class anywhere in the renderer', () => {
    const srcDir = path.join(dirname, '..');
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full);
          continue;
        }
        if (!entry.name.endsWith('.jsx')) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (/className="btn"|className="btn\s/.test(text)) {
          offenders.push(path.relative(srcDir, full));
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });

  it('every btn* class the Settings modal applies is defined in CSS', () => {
    const missing = classTokens(settingsJsx)
      .filter((token) => token === 'btn' || token.startsWith('btn-'))
      .filter((token) => !isDefined(allCss, token));
    expect(missing).toEqual([]);
  });

  it('the button keeps its disabled state while generating', () => {
    const block = settingsJsx.slice(settingsJsx.indexOf('handleGenerateWaveformsLibrary(true)'));
    expect(block).toContain('disabled={generatingWaveforms}');
  });
});
