'use strict';

// Read Nuxt's serialized data only. Never execute provider JavaScript.
function readSettradeState(html) {
  if (typeof html !== 'string' || html.length > 1_000_000) return null;
  const script = [...String(html || '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1].trim()).find(text => text.startsWith('window.__NUXT__='));
  if (!script || script.length > 512_000) return null;
  let nodes = 0;
  function reader(text, bindings = Object.create(null)) {
    let position = 0;
    function space() { while (/\s/.test(text[position] || '') && position < text.length) position += 1; }
    function take(token) {
      space();
      if (!text.startsWith(token, position)) throw Error('Unexpected serialized data');
      position += token.length;
    }
    function identifier() {
      space();
      const token = /^[A-Za-z_$][\w$]*/.exec(text.slice(position));
      if (!token) throw Error('Invalid serialized identifier');
      position += token[0].length;
      return token[0];
    }
    function string() {
      space();
      const start = position++;
      while (position < text.length) {
        const char = text[position++];
        if (char === '\\') position += 1;
        else if (char === '"') return JSON.parse(text.slice(start, position));
      }
      throw Error('Unterminated serialized string');
    }
    function value(depth = 0) {
      if (++nodes > 50_000 || depth > 64) throw Error('Serialized data limit');
      space();
      const char = text[position];
      if (text.startsWith('new Date(', position)) {
        take('new Date(');
        const timestamp = value(depth + 1);
        take(')');
        if (typeof timestamp !== 'number' || !Number.isFinite(new Date(timestamp).getTime())) throw Error('Invalid serialized date');
        return new Date(timestamp).toISOString();
      }
      if (char === '"') return string();
      if (char === '{') {
        take('{');
        const result = Object.create(null);
        space();
        while (text[position] !== '}') {
          space();
          const key = text[position] === '"' ? string() : identifier();
          if (['__proto__', 'constructor', 'prototype'].includes(key) || Object.hasOwn(result, key)) throw Error('Unsafe serialized key');
          take(':');
          result[key] = value(depth + 1);
          space();
          if (text[position] !== ',') break;
          take(',');
        }
        take('}');
        return result;
      }
      if (char === '[') {
        take('[');
        const result = [];
        space();
        while (text[position] !== ']') {
          result.push(value(depth + 1));
          space();
          if (text[position] !== ',') break;
          take(',');
        }
        take(']');
        return result;
      }
      const number = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(position));
      if (number) {
        position += number[0].length;
        const result = Number(number[0]);
        if (!Number.isFinite(result)) throw Error('Invalid serialized number');
        return result;
      }
      const name = identifier();
      if (name === 'null') return null;
      if (name === 'true') return true;
      if (name === 'false') return false;
      if (!Object.hasOwn(bindings, name)) throw Error('Unknown serialized binding');
      return bindings[name];
    }
    return {
      read: value,
      all() {
        const result = value();
        space();
        if (position !== text.length) throw Error('Executable serialized expression');
        return result;
      }
    };
  }
  try {
    const literal = script.slice('window.__NUXT__='.length).replace(/;$/, '');
    const closure = /^\(function\(([\w$,]*)\)\{([\s\S]*?)return ([\s\S]*)\}\(([\s\S]*)\)\)$/.exec(literal);
    if (!closure) return reader(literal).all();
    const names = closure[1] ? closure[1].split(',') : [];
    if (new Set(names).size !== names.length || names.length > 2_000) return null;
    const args = reader('[' + closure[4] + ']').all();
    if (args.length !== names.length) return null;
    const bindings = Object.create(null);
    names.forEach((name, index) => { bindings[name] = args[index]; });
    const assignments = closure[2].split(';').map(text => text.trim()).filter(Boolean);
    if (assignments.length > 100) return null;
    for (const statement of assignments) {
      const assignment = /^([\w$]+)\.([\w$]+)=([\s\S]+)$/.exec(statement);
      if (!assignment || ['__proto__', 'constructor', 'prototype'].includes(assignment[2])) return null;
      const target = bindings[assignment[1]];
      if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
      target[assignment[2]] = reader(assignment[3], bindings).all();
    }
    return reader(closure[3], bindings).all();
  } catch (_) {
    return null;
  }
}

module.exports = { readSettradeState };
