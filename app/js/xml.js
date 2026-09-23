// FluteBand AI — минимальный XML-парсер (без DOM и зависимостей): MusicXML читается одним проходом.

const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function createNode(name, attrs = {}) {
  return { name, attrs, children: [], text: '' };
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

export function parseXml(source) {
  let text = String(source ?? '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/<\?[\s\S]*?\?>/g, '');          // пролог
  text = text.replace(/<!--[\s\S]*?-->/g, '');          // комментарии
  text = text.replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?[^>]*>/g, '');
  text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) => inner);

  const root = createNode('#document');
  const stack = [root];
  const tokenRe = /<[^>]*>|[^<]+/g;
  let match;

  while ((match = tokenRe.exec(text)) !== null) {
    const token = match[0];
    if (token.startsWith('</')) {
      const name = token.slice(2, -1).trim();
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      }
    } else if (token.startsWith('<')) {
      const inner = token.slice(1, -1);
      if (!inner || inner.startsWith('!') || inner.startsWith('?')) continue;
      const selfClosing = inner.endsWith('/');
      const body = selfClosing ? inner.slice(0, -1) : inner;
      const spaceIdx = body.search(/\s/);
      const name = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).trim();
      const attrs = {};
      if (spaceIdx !== -1) {
        ATTR_RE.lastIndex = 0;
        let a;
        while ((a = ATTR_RE.exec(body.slice(spaceIdx))) !== null) {
          attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? '');
        }
      }
      const node = createNode(name, attrs);
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
    } else {
      const value = token.trim();
      if (value) {
        const parent = stack[stack.length - 1];
        parent.text = parent.text ? `${parent.text} ${value}` : value;
      }
    }
  }

  const doc = root.children.find((c) => c.name && c.name !== '#text');
  if (!doc) throw new Error('Не удалось разобрать XML: нет корневого элемента');
  return doc;
}

export function children(node, name = null) {
  if (!node) return [];
  return name ? node.children.filter((c) => c.name === name) : node.children;
}

export function first(node, name) {
  if (!node) return null;
  if (Array.isArray(name)) {
    for (const n of name) {
      const found = first(node, n);
      if (found) return found;
    }
    return null;
  }
  for (const c of node.children) if (c.name === name) return c;
  return null;
}

export function findAll(node, name, acc = []) {
  if (!node) return acc;
  for (const c of node.children) {
    if (c.name === name) acc.push(c);
    findAll(c, name, acc);
  }
  return acc;
}

export function nodeText(node, name = null) {
  const target = name ? first(node, name) : node;
  if (!target) return null;
  const collected = [];
  const walk = (n) => {
    if (n.text) collected.push(n.text);
    for (const c of n.children) walk(c);
  };
  walk(target);
  return collected.length ? decodeEntities(collected.join(' ')).trim() : null;
}

export function attr(node, name, fallback = null) {
  if (!node) return fallback;
  const value = node.attrs?.[name];
  return value === undefined ? fallback : decodeEntities(value);
}

export function numberAttr(node, name, fallback = null) {
  const value = attr(node, name, null);
  if (value === null) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function numberText(node, name, fallback = null) {
  const value = nodeText(node, name);
  if (value === null) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}