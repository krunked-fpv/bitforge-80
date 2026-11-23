export const MODULE_MANIFEST = [
  { path: './styles/chassis.css', type: 'css' },
  { path: './styles/pixel-optics.css', type: 'css' },
  { path: './src/vault/cookie-vault-head.js', type: 'head' },
  { path: './assets/icons/icon-192.png', type: 'icon' },
  { path: './src/cart/lz-codec.js', type: 'module' },
  { path: './src/cart/bitpack-rom.js', type: 'module' },
  { path: './src/cart/qr-matrix.js', type: 'module' },
  { path: './src/cart/holo-card-export.js', type: 'module' },
  { path: './src/vault/daily-seed.js', type: 'module' },
  { path: './src/vault/local-sync-baker.js', type: 'module' },
  { path: './src/vault/storage-coordinator.js', type: 'module' },
  { path: './src/studio/palettes.js', type: 'module' },
  { path: './src/studio/dither-symmetry.js', type: 'module' },
  { path: './src/studio/autotile-world.js', type: 'module' },
  { path: './src/studio/sprite-editor.js', type: 'module' },
  { path: './src/audio/dsp-engine.js', type: 'module' },
  { path: './src/audio/sfx-xy-pad.js', type: 'module' },
  { path: './src/audio/tenori-sequencer.js', type: 'module' },
  { path: './src/audio/asmr-foley.js', type: 'module' },
  { path: './src/vendor/kaboom-core.js', type: 'module' },
  { path: './src/runtime/touch-verbs.js', type: 'module' },
  { path: './src/runtime/rule-chips.js', type: 'module' },
  { path: './src/runtime/js-drawer.js', type: 'module' },
  { path: './src/runtime/arcade-core.js', type: 'module' },
  { path: './src/cartridges/sling-slime.js', type: 'module' },
  { path: './src/cartridges/zen-rake.js', type: 'module' },
  { path: './src/cartridges/bezel-orbit.js', type: 'module' },
  { path: './src/cartridges/alchemist-glass.js', type: 'module' },
  { path: './src/cartridges/chroma-chisel.js', type: 'module' },
  { path: './src/cartridges/pack-in-index.js', type: 'module' },
  { path: './src/ui/bezel-wheel.js', type: 'module' },
  { path: './src/ui/dock-ceremony.js', type: 'module' },
  { path: './src/ui/chassis-shell.js', type: 'module' },
  { path: './src/main.js', type: 'module' }
];

function normalizeModulePath(rawPath) {
  const cleaned = String(rawPath || '').replace(/\\/g, '/').trim();
  const parts = cleaned.split('/');
  const stack = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else {
        stack.push('..');
      }
    } else {
      stack.push(part);
    }
  }
  return './' + stack.join('/');
}

function resolveImportPath(fromPath, specifier) {
  const spec = String(specifier || '').trim();
  if (!spec.startsWith('./') && !spec.startsWith('../')) {
    return normalizeModulePath(spec);
  }
  const base = normalizeModulePath(fromPath);
  const slashIdx = base.lastIndexOf('/');
  const dir = slashIdx >= 0 ? base.slice(0, slashIdx) : '.';
  return normalizeModulePath(`${dir}/${spec}`);
}

const REGEX_PREV_KEYWORDS = new Set([
  'return', 'throw', 'case', 'default', 'delete', 'void', 'typeof',
  'in', 'instanceof', 'new', 'else', 'do', 'yield', 'await', 'of'
]);

const REGEX_PREV_PUNCT_DISALLOW = new Set([')', ']', '++', '--']);

function canRegexFollow(prevToken) {
  if (!prevToken) return true;
  if (prevToken.type === 'ident') return REGEX_PREV_KEYWORDS.has(prevToken.value);
  if (prevToken.type === 'number' || prevToken.type === 'string' || prevToken.type === 'template') return false;
  if (prevToken.type === 'punct') {
    if (REGEX_PREV_PUNCT_DISALLOW.has(prevToken.value)) return false;
    return true;
  }
  return true;
}

function isIdentStart(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$' || ch.charCodeAt(0) > 127;
}

function isIdentPart(ch) {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

/**
 * Tokenizes JS source while preserving exact character spans and handling strings,
 * nested template literals, comments, and regex literals without false matches.
 */
function tokenizeJs(source) {
  const tokens = [];
  const len = source.length;
  let i = 0;
  let sawNewlineBeforeNext = false;
  const templateStack = [];

  const lastSignificantToken = () => (tokens.length > 0 ? tokens[tokens.length - 1] : null);

  const pushToken = (type, value, start, end) => {
    tokens.push({
      type,
      value,
      start,
      end,
      newlineBefore: sawNewlineBeforeNext
    });
    sawNewlineBeforeNext = false;
  };

  const scanTemplateSegment = (startIdx) => {
    let j = startIdx;
    while (j < len) {
      const ch = source[j];
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === '`') {
        j++;
        return { end: j, openedExpr: false };
      }
      if (ch === '$' && source[j + 1] === '{') {
        j += 2;
        return { end: j, openedExpr: true };
      }
      j++;
    }
    return { end: len, openedExpr: false };
  };

  while (i < len) {
    if (templateStack.length > 0 && templateStack[templateStack.length - 1] === 0 && source[i] === '}') {
      templateStack.pop();
      const segStart = i;
      const seg = scanTemplateSegment(i + 1);
      pushToken('template', source.slice(segStart, seg.end), segStart, seg.end);
      if (seg.openedExpr) {
        templateStack.push(0);
      }
      i = seg.end;
      continue;
    }

    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\v' || ch === '\f') {
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      sawNewlineBeforeNext = true;
      i++;
      continue;
    }

    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < len && source[i] !== '\n' && source[i] !== '\r') i++;
      continue;
    }

    if (ch === '/' && source[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < len && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n' || source[i] === '\r') sawNewlineBeforeNext = true;
        i++;
      }
      i = Math.min(len, i + 2);
      void start;
      continue;
    }

    if (ch === '\'' || ch === '"') {
      const start = i;
      const quote = ch;
      i++;
      while (i < len) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      pushToken('string', source.slice(start, i), start, i);
      continue;
    }

    if (ch === '`') {
      const start = i;
      const seg = scanTemplateSegment(i + 1);
      pushToken('template', source.slice(start, seg.end), start, seg.end);
      if (seg.openedExpr) {
        templateStack.push(0);
      }
      i = seg.end;
      continue;
    }

    if (ch === '/' && canRegexFollow(lastSignificantToken())) {
      const start = i;
      i++;
      let inCharClass = false;
      while (i < len) {
        const rc = source[i];
        if (rc === '\\') {
          i += 2;
          continue;
        }
        if (rc === '[') {
          inCharClass = true;
          i++;
          continue;
        }
        if (rc === ']') {
          inCharClass = false;
          i++;
          continue;
        }
        if (rc === '/' && !inCharClass) {
          i++;
          break;
        }
        if (rc === '\n' || rc === '\r') break;
        i++;
      }
      while (i < len && isIdentStart(source[i])) i++;
      pushToken('regex', source.slice(start, i), start, i);
      continue;
    }

    if (isIdentStart(ch)) {
      const start = i;
      i++;
      while (i < len && isIdentPart(source[i])) i++;
      pushToken('ident', source.slice(start, i), start, i);
      continue;
    }

    if ((ch >= '0' && ch <= '9') || (ch === '.' && source[i + 1] >= '0' && source[i + 1] <= '9')) {
      const start = i;
      if (ch === '0' && (source[i + 1] === 'x' || source[i + 1] === 'X' || source[i + 1] === 'b' || source[i + 1] === 'B' || source[i + 1] === 'o' || source[i + 1] === 'O')) {
        i += 2;
        while (i < len && /[0-9a-fA-F_]/.test(source[i])) i++;
      } else {
        while (i < len && /[0-9_]/.test(source[i])) i++;
        if (source[i] === '.') {
          i++;
          while (i < len && /[0-9_]/.test(source[i])) i++;
        }
        if (source[i] === 'e' || source[i] === 'E') {
          i++;
          if (source[i] === '+' || source[i] === '-') i++;
          while (i < len && /[0-9_]/.test(source[i])) i++;
        }
      }
      if (source[i] === 'n') i++;
      pushToken('number', source.slice(start, i), start, i);
      continue;
    }

    // Multi-char punctuators
    const three = source.slice(i, i + 3);
    const two = source.slice(i, i + 2);
    let punct = ch;
    if (three === '===' || three === '!==' || three === '>>>' || three === '...' || three === '**=' || three === '<<=' || three === '>>=' || three === '&&=' || three === '||=' || three === '??=') {
      punct = three;
    } else if (
      two === '=>' || two === '==' || two === '!=' || two === '<=' || two === '>=' ||
      two === '&&' || two === '||' || two === '??' || two === '?.' || two === '++' ||
      two === '--' || two === '**' || two === '<<' || two === '>>' || two === '+=' ||
      two === '-=' || two === '*=' || two === '/=' || two === '%=' || two === '&=' ||
      two === '|=' || two === '^='
    ) {
      punct = two;
    }

    if (punct === '{' && templateStack.length > 0) {
      templateStack[templateStack.length - 1]++;
    } else if (punct === '}' && templateStack.length > 0 && templateStack[templateStack.length - 1] > 0) {
      templateStack[templateStack.length - 1]--;
    }

    pushToken('punct', punct, i, i + punct.length);
    i += punct.length;
  }

  return tokens;
}

function unquoteStringLiteral(tok) {
  const raw = tok.value;
  if (raw.length < 2) return raw;
  const inner = raw.slice(1, -1);
  try {
    return Function(`"use strict"; return (${raw});`)();
  } catch {
    return inner;
  }
}

const NON_ASI_TRAILING_PUNCTS = new Set([
  ',', '=', '+', '-', '*', '/', '%', '**', '&', '|', '^', '&&', '||', '??',
  '?', ':', '.', '?.', '=>', '==', '!=', '===', '!==', '<', '<=', '>', '>=',
  '<<', '>>', '>>>', '(', '[', '{', '...'
]);

const CONTINUATION_LEADING_PUNCTS = new Set([
  '.', '?.', '(', '[', ',', ';', '=', '?', ':', '&&', '||', '??',
  '+', '-', '*', '/', '%', '**', '==', '!=', '===', '!==', '<', '<=', '>', '>='
]);

function isStatementBoundary(tokens, idx) {
  if (idx >= tokens.length) return true;
  const tok = tokens[idx];
  if (tok.type === 'punct' && tok.value === ';') return true;
  if (!tok.newlineBefore) return false;
  const prev = idx > 0 ? tokens[idx - 1] : null;
  if (prev && prev.type === 'punct' && NON_ASI_TRAILING_PUNCTS.has(prev.value)) {
    return false;
  }
  if (prev && prev.type === 'ident' && (prev.value === 'return' || prev.value === 'throw' || prev.value === 'yield' || prev.value === 'await' || prev.value === 'typeof' || prev.value === 'void' || prev.value === 'delete' || prev.value === 'new')) {
    return false;
  }
  if (tok.type === 'punct' && CONTINUATION_LEADING_PUNCTS.has(tok.value)) {
    return false;
  }
  return true;
}

function findMatchingBraceEnd(tokens, openBraceIdx) {
  let depth = 0;
  for (let i = openBraceIdx; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punct' && t.value === '{') depth++;
    else if (t.type === 'punct' && t.value === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

function findBlockOpenAfterHeader(tokens, startIdx) {
  let paren = 0;
  let bracket = 0;
  for (let i = startIdx; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punct') {
      if (t.value === '(') paren++;
      else if (t.value === ')') paren = Math.max(0, paren - 1);
      else if (t.value === '[') bracket++;
      else if (t.value === ']') bracket = Math.max(0, bracket - 1);
      else if (t.value === '{' && paren === 0 && bracket === 0) {
        return i;
      }
    }
  }
  return tokens.length - 1;
}

function findStatementEnd(tokens, startIdx) {
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  let i = startIdx;
  while (i < tokens.length) {
    const t = tokens[i];
    if (brace === 0 && paren === 0 && bracket === 0) {
      if (t.type === 'punct' && t.value === ';') {
        return { endIdx: i, consumedSemicolon: true };
      }
      if (i > startIdx && isStatementBoundary(tokens, i)) {
        return { endIdx: i - 1, consumedSemicolon: false };
      }
    }
    if (t.type === 'punct') {
      if (t.value === '{') brace++;
      else if (t.value === '}') brace = Math.max(0, brace - 1);
      else if (t.value === '(') paren++;
      else if (t.value === ')') paren = Math.max(0, paren - 1);
      else if (t.value === '[') bracket++;
      else if (t.value === ']') bracket = Math.max(0, bracket - 1);
    }
    i++;
  }
  return { endIdx: tokens.length - 1, consumedSemicolon: false };
}

function extractPatternBindings(tokens, startIdx, stopAtTopEqualOrComma) {
  const names = [];
  let i = startIdx;

  function scanArrayPattern(idx) {
    let cur = idx + 1;
    let depth = 1;
    let expectingBinding = true;
    let brace = 0;
    let paren = 0;
    while (cur < tokens.length && depth > 0) {
      const t = tokens[cur];
      if (t.type === 'punct') {
        if (brace === 0 && paren === 0 && t.value === '[') {
          if (expectingBinding) {
            cur = scanArrayPattern(cur);
            expectingBinding = false;
            continue;
          }
          depth++;
        } else if (brace === 0 && paren === 0 && t.value === ']') {
          depth--;
          if (depth === 0) return cur + 1;
        } else if (brace === 0 && paren === 0 && t.value === '{') {
          if (expectingBinding) {
            cur = scanObjectPattern(cur);
            expectingBinding = false;
            continue;
          }
          brace++;
        } else if (t.value === '{') {
          brace++;
        } else if (t.value === '}') {
          brace = Math.max(0, brace - 1);
        } else if (t.value === '(') {
          paren++;
        } else if (t.value === ')') {
          paren = Math.max(0, paren - 1);
        } else if (depth === 1 && brace === 0 && paren === 0 && t.value === ',') {
          expectingBinding = true;
        } else if (depth === 1 && brace === 0 && paren === 0 && t.value === '=') {
          expectingBinding = false;
        }
      } else if (depth === 1 && brace === 0 && paren === 0 && expectingBinding && t.type === 'ident') {
        names.push(t.value);
        expectingBinding = false;
      }
      cur++;
    }
    return cur;
  }

  function scanObjectPattern(idx) {
    let cur = idx + 1;
    let depth = 1;
    let paren = 0;
    let bracket = 0;
    let phase = 'key'; // 'key' | 'afterKey' | 'valuePattern' | 'defaultExpr'
    let pendingKeyName = null;

    while (cur < tokens.length && depth > 0) {
      const t = tokens[cur];
      if (t.type === 'punct') {
        if (depth === 1 && paren === 0 && bracket === 0) {
          if (t.value === '}') {
            if (phase === 'afterKey' && pendingKeyName) {
              names.push(pendingKeyName);
              pendingKeyName = null;
            }
            return cur + 1;
          }
          if (t.value === ',') {
            if (phase === 'afterKey' && pendingKeyName) {
              names.push(pendingKeyName);
            }
            pendingKeyName = null;
            phase = 'key';
            cur++;
            continue;
          }
          if (t.value === ':' && phase === 'afterKey') {
            pendingKeyName = null;
            phase = 'valuePattern';
            cur++;
            continue;
          }
          if (t.value === '=' && (phase === 'afterKey' || phase === 'valuePattern')) {
            if (phase === 'afterKey' && pendingKeyName) {
              names.push(pendingKeyName);
              pendingKeyName = null;
            }
            phase = 'defaultExpr';
            cur++;
            continue;
          }
          if (t.value === '{' && phase === 'valuePattern') {
            cur = scanObjectPattern(cur);
            phase = 'defaultExpr';
            continue;
          }
          if (t.value === '[' && phase === 'valuePattern') {
            cur = scanArrayPattern(cur);
            phase = 'defaultExpr';
            continue;
          }
          if (t.value === '[') bracket++;
          else if (t.value === '(') paren++;
          else if (t.value === '{') depth++;
        } else {
          if (t.value === '{') depth++;
          else if (t.value === '}') depth--;
          else if (t.value === '(') paren++;
          else if (t.value === ')') paren = Math.max(0, paren - 1);
          else if (t.value === '[') bracket++;
          else if (t.value === ']') bracket = Math.max(0, bracket - 1);
        }
      } else if (depth === 1 && paren === 0 && bracket === 0) {
        if (t.type === 'ident') {
          if (phase === 'key') {
            pendingKeyName = t.value;
            phase = 'afterKey';
          } else if (phase === 'valuePattern') {
            names.push(t.value);
            phase = 'defaultExpr';
          }
        }
      }
      cur++;
    }
    return cur;
  }

  while (i < tokens.length) {
    const t = tokens[i];
    if (stopAtTopEqualOrComma && t.type === 'punct' && (t.value === '=' || t.value === ',' || t.value === ';')) {
      break;
    }
    if (t.type === 'punct' && t.value === '{') {
      i = scanObjectPattern(i);
      continue;
    }
    if (t.type === 'punct' && t.value === '[') {
      i = scanArrayPattern(i);
      continue;
    }
    if (t.type === 'ident') {
      names.push(t.value);
      i++;
      break;
    }
    i++;
  }
  return names;
}

function extractDeclaratorBindings(tokens, declStartIdx, declEndIdx) {
  const names = [];
  let i = declStartIdx;
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  let inInit = false;
  let curPatternStart = i;

  while (i <= declEndIdx) {
    const t = tokens[i];
    if (brace === 0 && paren === 0 && bracket === 0) {
      if (!inInit && t.type === 'punct' && t.value === '=') {
        names.push(...extractPatternBindings(tokens, curPatternStart, true));
        inInit = true;
      } else if (t.type === 'punct' && (t.value === ',' || t.value === ';')) {
        if (!inInit) {
          names.push(...extractPatternBindings(tokens, curPatternStart, true));
        }
        inInit = false;
        curPatternStart = i + 1;
      }
    }
    if (t.type === 'punct') {
      if (t.value === '{') brace++;
      else if (t.value === '}') brace = Math.max(0, brace - 1);
      else if (t.value === '(') paren++;
      else if (t.value === ')') paren = Math.max(0, paren - 1);
      else if (t.value === '[') bracket++;
      else if (t.value === ']') bracket = Math.max(0, bracket - 1);
    }
    i++;
  }
  if (!inInit && curPatternStart <= declEndIdx) {
    names.push(...extractPatternBindings(tokens, curPatternStart, true));
  }
  return names;
}

function parseNamedSpecifiers(tokens, openBraceIdx, closeBraceIdx) {
  const specs = [];
  let i = openBraceIdx + 1;
  while (i < closeBraceIdx) {
    const t = tokens[i];
    if (t.type === 'punct' && t.value === ',') {
      i++;
      continue;
    }
    // Handle `type` modifier or standard identifier / string literal
    if (t.type === 'ident' || t.type === 'string') {
      const imported = t.type === 'string' ? unquoteStringLiteral(t) : t.value;
      let local = imported;
      if (
        i + 2 < closeBraceIdx &&
        tokens[i + 1].type === 'ident' &&
        tokens[i + 1].value === 'as'
      ) {
        const aliasTok = tokens[i + 2];
        local = aliasTok.type === 'string' ? unquoteStringLiteral(aliasTok) : aliasTok.value;
        i += 3;
      } else {
        i += 1;
      }
      specs.push({ imported, local });
      continue;
    }
    i++;
  }
  return specs;
}

function transformEsModule(moduleId, source, tempCounter) {
  const tokens = tokenizeJs(source);
  const replacements = [];
  const deps = [];

  let brace = 0;
  let paren = 0;
  let bracket = 0;
  let i = 0;

  while (i < tokens.length) {
    const t = tokens[i];
    const atTopLevel = brace === 0 && paren === 0 && bracket === 0;
    const prev = i > 0 ? tokens[i - 1] : null;
    const isMemberProp = prev && prev.type === 'punct' && (prev.value === '.' || prev.value === '?.');

    if (atTopLevel && !isMemberProp && t.type === 'ident' && t.value === 'import') {
      const next = tokens[i + 1];
      if (next && !(next.type === 'punct' && (next.value === '(' || next.value === '.'))) {
        const stmtStart = t.start;
        let cur = i + 1;
        let defaultBinding = null;
        let namespaceBinding = null;
        let namedBindings = [];
        let moduleSpecifier = null;

        if (tokens[cur] && tokens[cur].type === 'string') {
          moduleSpecifier = unquoteStringLiteral(tokens[cur]);
          cur++;
        } else {
          if (tokens[cur] && tokens[cur].type === 'ident') {
            defaultBinding = tokens[cur].value;
            cur++;
            if (tokens[cur] && tokens[cur].type === 'punct' && tokens[cur].value === ',') {
              cur++;
            }
          }
          if (tokens[cur] && tokens[cur].type === 'punct' && tokens[cur].value === '*') {
            // * as ns
            if (tokens[cur + 1] && tokens[cur + 1].type === 'ident' && tokens[cur + 1].value === 'as' && tokens[cur + 2]) {
              namespaceBinding = tokens[cur + 2].value;
              cur += 3;
            }
          } else if (tokens[cur] && tokens[cur].type === 'punct' && tokens[cur].value === '{') {
            const closeIdx = findMatchingBraceEnd(tokens, cur);
            namedBindings = parseNamedSpecifiers(tokens, cur, closeIdx);
            cur = closeIdx + 1;
          }
          if (tokens[cur] && tokens[cur].type === 'ident' && tokens[cur].value === 'from' && tokens[cur + 1] && tokens[cur + 1].type === 'string') {
            moduleSpecifier = unquoteStringLiteral(tokens[cur + 1]);
            cur += 2;
          }
        }

        if (tokens[cur] && tokens[cur].type === 'punct' && tokens[cur].value === ';') {
          cur++;
        }
        const stmtEnd = tokens[cur - 1].end;
        const resolved = resolveImportPath(moduleId, moduleSpecifier || '');
        deps.push(resolved);

        const formatDestructure = (specs) => specs
          .map((s) => {
            const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s.imported)
              ? s.imported
              : JSON.stringify(s.imported);
            return s.imported === s.local && key === s.imported ? s.imported : `${key}: ${s.local}`;
          })
          .join(', ');

        const reqCall = `__BF_REQUIRE__(${JSON.stringify(resolved)})`;
        const lines = [];
        if (!defaultBinding && !namespaceBinding && namedBindings.length === 0) {
          lines.push(`${reqCall};`);
        } else if (defaultBinding && !namespaceBinding && namedBindings.length === 0) {
          lines.push(`const ${defaultBinding} = ${reqCall}.default;`);
        } else if (!defaultBinding && namespaceBinding && namedBindings.length === 0) {
          lines.push(`const ${namespaceBinding} = ${reqCall};`);
        } else if (!defaultBinding && !namespaceBinding && namedBindings.length > 0) {
          lines.push(`const { ${formatDestructure(namedBindings)} } = ${reqCall};`);
        } else {
          const tmp = `__bf_imp_${tempCounter.next++}`;
          lines.push(`const ${tmp} = ${reqCall};`);
          if (defaultBinding) lines.push(`const ${defaultBinding} = ${tmp}.default;`);
          if (namespaceBinding) lines.push(`const ${namespaceBinding} = ${tmp};`);
          if (namedBindings.length > 0) {
            lines.push(`const { ${formatDestructure(namedBindings)} } = ${tmp};`);
          }
        }

        replacements.push({ start: stmtStart, end: stmtEnd, text: lines.join(' ') });
        i = cur;
        continue;
      }
    }

    if (atTopLevel && !isMemberProp && t.type === 'ident' && t.value === 'export') {
      const exportStart = t.start;
      const next = tokens[i + 1];

      // 1. export default ...
      if (next && next.type === 'ident' && next.value === 'default') {
        const afterDef = tokens[i + 2];
        // Check named function or class declaration after export default
        let fnTokIdx = i + 2;
        if (afterDef && afterDef.type === 'ident' && afterDef.value === 'async' && tokens[i + 3] && tokens[i + 3].type === 'ident' && tokens[i + 3].value === 'function') {
          fnTokIdx = i + 3;
        }
        if (tokens[fnTokIdx] && tokens[fnTokIdx].type === 'ident' && tokens[fnTokIdx].value === 'function') {
          let nameIdx = fnTokIdx + 1;
          if (tokens[nameIdx] && tokens[nameIdx].type === 'punct' && tokens[nameIdx].value === '*') {
            nameIdx++;
          }
          if (tokens[nameIdx] && tokens[nameIdx].type === 'ident') {
            const fnName = tokens[nameIdx].value;
            const pIdx = findBlockOpenAfterHeader(tokens, nameIdx + 1);
            const bodyEndIdx = findMatchingBraceEnd(tokens, pIdx);
            replacements.push({ start: exportStart, end: afterDef.start, text: '' });
            replacements.push({
              start: tokens[bodyEndIdx].end,
              end: tokens[bodyEndIdx].end,
              text: `\nObject.defineProperty(exports, 'default', { enumerable: true, get: () => ${fnName} });`
            });
            i = bodyEndIdx + 1;
            continue;
          }
          // Anonymous default function
          replacements.push({ start: exportStart, end: afterDef.start, text: 'exports.default = ' });
          const pIdx = findBlockOpenAfterHeader(tokens, nameIdx);
          const bodyEndIdx = findMatchingBraceEnd(tokens, pIdx);
          i = bodyEndIdx + 1;
          continue;
        }

        if (afterDef && afterDef.type === 'ident' && afterDef.value === 'class') {
          const maybeName = tokens[i + 3];
          if (maybeName && maybeName.type === 'ident' && maybeName.value !== 'extends') {
            const clsName = maybeName.value;
            const bIdx = findBlockOpenAfterHeader(tokens, i + 4);
            const bodyEndIdx = findMatchingBraceEnd(tokens, bIdx);
            replacements.push({ start: exportStart, end: afterDef.start, text: '' });
            replacements.push({
              start: tokens[bodyEndIdx].end,
              end: tokens[bodyEndIdx].end,
              text: `\nObject.defineProperty(exports, 'default', { enumerable: true, get: () => ${clsName} });`
            });
            i = bodyEndIdx + 1;
            continue;
          }
          // Anonymous default class
          replacements.push({ start: exportStart, end: afterDef.start, text: 'exports.default = ' });
          const bIdx = findBlockOpenAfterHeader(tokens, i + 3);
          const bodyEndIdx = findMatchingBraceEnd(tokens, bIdx);
          i = bodyEndIdx + 1;
          continue;
        }

        // Generic `export default <expression>`
        const { endIdx } = findStatementEnd(tokens, i + 2);
        replacements.push({ start: exportStart, end: afterDef.start, text: 'exports.default = ' });
        i = endIdx + 1;
        continue;
      }

      // 2. Star re-export from module specifier
      if (next && next.type === 'punct' && next.value === '*') {
        let cur = i + 2;
        let nsAlias = null;
        if (tokens[cur] && tokens[cur].type === 'ident' && tokens[cur].value === 'as' && tokens[cur + 1]) {
          nsAlias = tokens[cur + 1].value;
          cur += 2;
        }
        if (tokens[cur] && tokens[cur].type === 'ident' && tokens[cur].value === 'from' && tokens[cur + 1] && tokens[cur + 1].type === 'string') {
          const spec = unquoteStringLiteral(tokens[cur + 1]);
          const resolved = resolveImportPath(moduleId, spec);
          deps.push(resolved);
          cur += 2;
          if (tokens[cur] && tokens[cur].type === 'punct' && tokens[cur].value === ';') cur++;
          const endPos = tokens[cur - 1].end;
          if (nsAlias) {
            replacements.push({
              start: exportStart,
              end: endPos,
              text: `exports[${JSON.stringify(nsAlias)}] = __BF_REQUIRE__(${JSON.stringify(resolved)});`
            });
          } else {
            const tmp = `__bf_re_${tempCounter.next++}`;
            replacements.push({
              start: exportStart,
              end: endPos,
              text: `const ${tmp} = __BF_REQUIRE__(${JSON.stringify(resolved)}); for (const __bf_k of Object.keys(${tmp})) { if (__bf_k !== 'default') Object.defineProperty(exports, __bf_k, { enumerable: true, get: () => ${tmp}[__bf_k] }); }`
            });
          }
          i = cur;
          continue;
        }
      }

      // 3. export { ... } [from '...']
      if (next && next.type === 'punct' && next.value === '{') {
        const closeIdx = findMatchingBraceEnd(tokens, i + 1);
        const specs = parseNamedSpecifiers(tokens, i + 1, closeIdx);
        let cur = closeIdx + 1;
        let fromResolved = null;
        if (tokens[cur] && tokens[cur].type === 'ident' && tokens[cur].value === 'from' && tokens[cur + 1] && tokens[cur + 1].type === 'string') {
          fromResolved = resolveImportPath(moduleId, unquoteStringLiteral(tokens[cur + 1]));
          deps.push(fromResolved);
          cur += 2;
        }
        if (tokens[cur] && tokens[cur].type === 'punct' && tokens[cur].value === ';') cur++;
        const endPos = tokens[cur - 1].end;

        const out = [];
        if (fromResolved) {
          const tmp = `__bf_re_${tempCounter.next++}`;
          out.push(`const ${tmp} = __BF_REQUIRE__(${JSON.stringify(fromResolved)});`);
          for (const s of specs) {
            out.push(`Object.defineProperty(exports, ${JSON.stringify(s.local)}, { enumerable: true, get: () => ${tmp}[${JSON.stringify(s.imported)}] });`);
          }
        } else {
          for (const s of specs) {
            out.push(`Object.defineProperty(exports, ${JSON.stringify(s.local)}, { enumerable: true, get: () => ${s.imported} });`);
          }
        }
        replacements.push({ start: exportStart, end: endPos, text: out.join(' ') });
        i = cur;
        continue;
      }

      // 4. export [async] function [*] name(...) { ... }
      let fnIdx = i + 1;
      if (tokens[fnIdx] && tokens[fnIdx].type === 'ident' && tokens[fnIdx].value === 'async' && tokens[fnIdx + 1] && tokens[fnIdx + 1].type === 'ident' && tokens[fnIdx + 1].value === 'function') {
        fnIdx++;
      }
      if (tokens[fnIdx] && tokens[fnIdx].type === 'ident' && tokens[fnIdx].value === 'function') {
        let nameIdx = fnIdx + 1;
        if (tokens[nameIdx] && tokens[nameIdx].type === 'punct' && tokens[nameIdx].value === '*') nameIdx++;
        const fnName = tokens[nameIdx].value;
        const bIdx = findBlockOpenAfterHeader(tokens, nameIdx + 1);
        const bodyEndIdx = findMatchingBraceEnd(tokens, bIdx);
        replacements.push({ start: exportStart, end: tokens[i + 1].start, text: '' });
        replacements.push({
          start: tokens[bodyEndIdx].end,
          end: tokens[bodyEndIdx].end,
          text: `\nObject.defineProperty(exports, ${JSON.stringify(fnName)}, { enumerable: true, get: () => ${fnName} });`
        });
        i = bodyEndIdx + 1;
        continue;
      }

      // 5. export class Name { ... }
      if (next && next.type === 'ident' && next.value === 'class') {
        const clsName = tokens[i + 2].value;
        const bIdx = findBlockOpenAfterHeader(tokens, i + 3);
        const bodyEndIdx = findMatchingBraceEnd(tokens, bIdx);
        replacements.push({ start: exportStart, end: next.start, text: '' });
        replacements.push({
          start: tokens[bodyEndIdx].end,
          end: tokens[bodyEndIdx].end,
          text: `\nObject.defineProperty(exports, ${JSON.stringify(clsName)}, { enumerable: true, get: () => ${clsName} });`
        });
        i = bodyEndIdx + 1;
        continue;
      }

      // 6. export const | let | var ...
      if (next && next.type === 'ident' && (next.value === 'const' || next.value === 'let' || next.value === 'var')) {
        const { endIdx, consumedSemicolon } = findStatementEnd(tokens, i + 2);
        const bindings = extractDeclaratorBindings(tokens, i + 2, endIdx);
        replacements.push({ start: exportStart, end: next.start, text: '' });
        if (bindings.length > 0) {
          const getters = bindings
            .map((name) => `Object.defineProperty(exports, ${JSON.stringify(name)}, { enumerable: true, get: () => ${name} });`)
            .join(' ');
          const sep = consumedSemicolon ? '\n' : ';\n';
          replacements.push({
            start: tokens[endIdx].end,
            end: tokens[endIdx].end,
            text: `${sep}${getters}`
          });
        }
        i = endIdx + 1;
        continue;
      }
    }

    if (
      !isMemberProp &&
      t.type === 'ident' &&
      t.value === 'import' &&
      tokens[i + 1] &&
      tokens[i + 1].type === 'punct' &&
      tokens[i + 1].value === '.' &&
      tokens[i + 2] &&
      tokens[i + 2].type === 'ident' &&
      tokens[i + 2].value === 'meta'
    ) {
      replacements.push({
        start: t.start,
        end: tokens[i + 2].end,
        text: '({ url: (typeof location !== "undefined" ? location.href : "") })'
      });
      i += 3;
      continue;
    }

    if (t.type === 'punct') {
      if (t.value === '{') brace++;
      else if (t.value === '}') brace = Math.max(0, brace - 1);
      else if (t.value === '(') paren++;
      else if (t.value === ')') paren = Math.max(0, paren - 1);
      else if (t.value === '[') bracket++;
      else if (t.value === ']') bracket = Math.max(0, bracket - 1);
    }
    i++;
  }

  // Apply replacements from end to start so offsets stay exact
  replacements.sort((a, b) => b.start - a.start || b.end - a.end);
  let output = source;
  for (const rep of replacements) {
    output = output.slice(0, rep.start) + rep.text + output.slice(rep.end);
  }

  return { code: output, deps };
}

/**
 * Bundles ES modules in topological dependency order using an inline __BF_DEFINE__ / __BF_REQUIRE__ loader.
 * @param {Record<string, string>} fileMap
 * @param {string} [entryPath='./src/main.js']
 * @returns {string}
 */
export function bundleModulesInline(fileMap, entryPath = './src/main.js') {
  if (!fileMap || typeof fileMap !== 'object') {
    throw new TypeError('bundleModulesInline requires a fileMap object');
  }

  const normalizedFiles = new Map();
  for (const [rawKey, content] of Object.entries(fileMap)) {
    normalizedFiles.set(normalizeModulePath(rawKey), String(content));
  }

  const entryId = normalizeModulePath(entryPath);
  if (!normalizedFiles.has(entryId)) {
    throw new Error(`Entry module not found in fileMap: ${entryId}`);
  }

  const transformed = new Map();
  const tempCounter = { next: 0 };
  for (const [modId, src] of normalizedFiles.entries()) {
    transformed.set(modId, transformEsModule(modId, src, tempCounter));
  }

  // Order modules: manifest order first (for deterministic topology), then DFS topological order for any remaining
  const manifestOrder = MODULE_MANIFEST
    .filter((m) => m.type === 'module' || m.type === 'head')
    .map((m) => normalizeModulePath(m.path));

  const orderedIds = [];
  const visited = new Set();

  const visit = (id) => {
    if (visited.has(id) || !transformed.has(id)) return;
    visited.add(id);
    const entry = transformed.get(id);
    for (const dep of entry.deps) {
      visit(dep);
    }
    orderedIds.push(id);
  };

  for (const id of manifestOrder) {
    if (transformed.has(id)) visit(id);
  }
  for (const id of normalizedFiles.keys()) {
    visit(id);
  }

  const lines = [
    '(function () {',
    '  "use strict";',
    '  const __bf_factories = Object.create(null);',
    '  const __bf_cache = Object.create(null);',
    '  function __BF_DEFINE__(id, factory) {',
    '    __bf_factories[id] = factory;',
    '  }',
    '  function __BF_REQUIRE__(id) {',
    '    if (__bf_cache[id]) return __bf_cache[id].exports;',
    '    const factory = __bf_factories[id];',
    '    if (!factory) {',
    '      if (id === "./src/vault/cookie-vault-head.js" && typeof globalThis !== "undefined" && globalThis.__BITFORGE_VAULT__) {',
    '        __bf_cache[id] = { exports: {} };',
    '        return __bf_cache[id].exports;',
    '      }',
    '      throw new Error("BitForge standalone module missing: " + id);',
    '    }',
    '    const mod = { exports: {} };',
    '    __bf_cache[id] = mod;',
    '    factory(mod.exports, __BF_REQUIRE__);',
    '    return mod.exports;',
    '  }'
  ];

  for (const id of orderedIds) {
    const { code } = transformed.get(id);
    lines.push(`__BF_DEFINE__(${JSON.stringify(id)}, (exports) => {\n${code}\n});`);
  }

  lines.push(`  __BF_REQUIRE__(${JSON.stringify(entryId)});`);
  lines.push('})();');
  return lines.join('\n');
}

function escapeHtmlText(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeInlineTagContent(text, tagName) {
  const re = new RegExp(`<\\/${tagName}`, 'gi');
  return String(text || '').replace(re, `<\\/${tagName}`);
}

function encodeInlineJsonString(val) {
  return JSON.stringify(String(val == null ? '' : val))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/**
 * Builds a 100% self-contained, zero-external-script offline HTML document.
 * @param {object} params
 * @returns {string}
 */
export function buildStandaloneHtmlString({
  cartHash = '',
  title = 'BitForge-80 Cartridge',
  cssText = '',
  headVaultJs = '',
  bundledMainJs = '',
  iconBase64 = ''
} = {}) {
  const safeTitle = escapeHtmlText(title || 'BitForge-80 Cartridge');
  const safeCss = escapeInlineTagContent(cssText, 'style');
  const safeHeadJs = escapeInlineTagContent(headVaultJs, 'script');
  const safeBundleJs = escapeInlineTagContent(bundledMainJs, 'script');
  const safeCartLiteral = encodeInlineJsonString(cartHash || '');

  let iconTag = '';
  if (iconBase64 && typeof iconBase64 === 'string') {
    const cleanB64 = iconBase64.startsWith('data:')
      ? iconBase64
      : `data:image/png;base64,${iconBase64.trim()}`;
    iconTag = `\n  <link rel="icon" type="image/png" href="${escapeHtmlText(cleanB64)}">`;
  }

  const scriptOpen = '<script>';
  const scriptClose = '<' + '/script>';

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">',
    '  <meta name="theme-color" content="#12131a">',
    `  <title>${safeTitle}</title>${iconTag}`,
    `  <style>\n${safeCss}\n  </style>`,
    `  ${scriptOpen}`,
    '    window.__BITFORGE_STANDALONE__ = true;',
    `    window.__BITFORGE_BAKED_CART__ = ${safeCartLiteral};`,
    `  ${scriptClose}`,
    `  ${scriptOpen}`,
    safeHeadJs,
    `  ${scriptClose}`,
    '</head>',
    '<body>',
    '  <div id="app"></div>',
    `  ${scriptOpen}`,
    safeBundleJs,
    `  ${scriptClose}`,
    '</body>',
    '</html>',
    ''
  ].join('\n');
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function createDefaultAssetReader() {
  const isNodeEnv = typeof window === 'undefined' && typeof process !== 'undefined' && process.versions && process.versions.node;
  if (!isNodeEnv && typeof fetch === 'function') {
    return async (relPath, type) => {
      const res = await fetch(relPath);
      if (!res.ok) {
        throw new Error(`Failed to fetch ${relPath}: HTTP ${res.status}`);
      }
      if (type === 'icon') {
        const buf = new Uint8Array(await res.arrayBuffer());
        return bytesToBase64(buf);
      }
      return res.text();
    };
  }

  // Dynamic Node fallback without static node: import or import.meta so standalone classic scripts stay valid
  const fs = await import('node:' + 'fs/promises');
  const path = await import('node:' + 'path');
  let projectRoot = process.cwd();
  for (let depth = 0; depth < 6; depth++) {
    try {
      await fs.access(path.resolve(projectRoot, 'src/vault/local-sync-baker.js'));
      break;
    } catch {
      const parent = path.dirname(projectRoot);
      if (parent === projectRoot) break;
      projectRoot = parent;
    }
  }

  return async (relPath, type) => {
    const cleanRel = relPath.replace(/^\.\//, '');
    const fullPath = path.resolve(projectRoot, cleanRel);
    if (type === 'icon') {
      const buf = await fs.readFile(fullPath);
      return buf.toString('base64');
    }
    return fs.readFile(fullPath, 'utf8');
  };
}

/**
 * Reads all manifest assets, bundles ES modules inline, and returns a standalone offline HTML Blob.
 * @param {string} cartHash
 * @param {string} [title='BitForge-80 Cartridge']
 * @param {(relPath: string, type?: string) => Promise<string>} [customReader]
 * @returns {Promise<Blob>}
 */
export async function bakeStandaloneHtml(cartHash, title = 'BitForge-80 Cartridge', customReader) {
  const reader = typeof customReader === 'function' ? customReader : await createDefaultAssetReader();

  const cssChunks = [];
  let headVaultJs = '';
  let iconBase64 = '';
  const fileMap = Object.create(null);

  for (const item of MODULE_MANIFEST) {
    if (item.type === 'icon') {
      try {
        const iconVal = await reader(item.path, item.type);
        if (typeof iconVal === 'string') iconBase64 = iconVal;
      } catch {
        // Optional icon fallback
      }
      continue;
    }

    const content = await reader(item.path, item.type);
    if (typeof content !== 'string') continue;

    if (item.type === 'css') {
      cssChunks.push(content);
    } else if (item.type === 'head') {
      headVaultJs = content;
      fileMap[item.path] = '// Executed synchronously in <head>\n';
    } else if (item.type === 'module') {
      fileMap[item.path] = content;
    }
  }

  const bundledMainJs = bundleModulesInline(fileMap, './src/main.js');
  const html = buildStandaloneHtmlString({
    cartHash,
    title,
    cssText: cssChunks.join('\n'),
    headVaultJs,
    bundledMainJs,
    iconBase64
  });

  return new Blob([html], { type: 'text/html;charset=utf-8' });
}
