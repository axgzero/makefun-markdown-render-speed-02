// A fast CommonMark 0.31.2 + GFM renderer that returns exactly the HTML marked 18.1.3
// renders with its default options (gfm on, breaks off, pedantic off, async off).
// Written from the CommonMark spec and the GFM spec, checked against marked's output
// on the competition's practice set. Dependency-free, no caching across calls: every
// call parses its input from scratch and keeps nothing from an earlier call.
//
// Layout: helpers first, then the inline parser (delimiter stack, bracket links,
// extended autolinks), then the block parser (container stack, lists, tables, HTML
// blocks, link reference definitions), then parse() itself.

const ASCII_PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const UNICODE_PUNCT_RE = /^[\p{P}\p{S}]$/u;
const UNICODE_SPACE_RE = /^[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u;

/** True for a Unicode whitespace character (CommonMark's definition). */
function isSpace(ch) {
  if (ch === undefined) return true;
  const c = ch.charCodeAt(0);
  if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13) return true;
  if (c < 128) return false;
  return UNICODE_SPACE_RE.test(ch);
}

/** True for a Unicode punctuation character (CommonMark's definition). */
function isPunct(ch) {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return ASCII_PUNCT.indexOf(ch) >= 0;
  return UNICODE_PUNCT_RE.test(ch);
}

/** True for an ASCII punctuation character (backslash-escape set). */
function isAsciiPunct(ch) {
  return ch !== undefined && ch.charCodeAt(0) < 128 && ASCII_PUNCT.indexOf(ch) >= 0;
}

/** Escape text for HTML: & < > " ' (marked's escape, also used in code and attributes). */
function esc(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

/**
 * marked's entity rule (probed against marked 18.1.3): named entities are NOT decoded,
 * they pass through verbatim; only numeric character references are decoded.
 * At `s[i] === '&'`, returns {text, next} where text is what to emit and next the
 * index after the consumed reference, or null when the '&' is literal (emit '&amp;').
 */
function entityAt(s, i) {
  // Numeric: &#123; &#x1F600; &#X22;
  if (s.charCodeAt(i + 1) === 35) {
    let j = i + 2;
    let hex = false;
    if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
    const ds = j;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (hex ? (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70) : c >= 48 && c <= 57) j++;
      else break;
    }
    if (j > ds && s[j] === ';') {
      const n = parseInt(s.slice(ds, j), hex ? 16 : 10);
      if (n === 0 || (n >= 0xd800 && n <= 0xdfff)) return { text: '\uFFFD', next: j + 1 };
      if (n > 0x10ffff) return null; // out of range: not decoded at all
      return { text: String.fromCodePoint(n), next: j + 1 };
    }
    return null;
  }
  // Named-ish: &word; passes through verbatim (marked does not check the name).
  let j = i + 1;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) j++;
    else break;
  }
  if (j > i + 1 && s[j] === ';') return { text: s.slice(i, j + 1), next: j + 1 };
  return null;
}

/** Process entities in a string the way marked does for text/attributes: numeric refs
 *  decode, &word; passes through, other & escapes to &amp;. */
function processEntities(s) {
  if (s.indexOf('&') < 0) return esc(s);
  let out = '';
  let start = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === '&') {
      const e = entityAt(s, i);
      if (e) {
        out += esc(s.slice(start, i)) + e.text;
        i = e.next;
        start = i;
        continue;
      }
      out += esc(s.slice(start, i)) + '&amp;';
      i++;
      start = i;
      continue;
    }
    i++;
  }
  return out + esc(s.slice(start));
}

/**
 * Clean a link destination or image source the way marked does: entity
 * references (named or numeric) pass through verbatim, a bare & escapes to
 * &amp;, and the rest is percent-encoded like encodeURI (" < > ` [ ] { | } ^
 * space, backslash, controls, and non-ASCII as UTF-8); ' escapes to &#39; and
 * % stays as-is. Backslash escapes are already removed by the caller.
 */
function cleanUrl(dest) {
  let out = '';
  let start = 0;
  let i = 0;
  while (i < dest.length) {
    const c = dest.charCodeAt(i);
    if (dest[i] === '&') {
      const e = entityAt(dest, i);
      if (e) {
        out += dest.slice(start, i) + dest.slice(i, e.next); // entity verbatim
        i = e.next; start = i; continue;
      }
      out += dest.slice(start, i) + '&amp;';
      i++; start = i; continue;
    }
    let rep = null;
    if (c === 32) rep = '%20';
    else if (c === 92) rep = '%5C';
    else if (c < 32 || c === 127) rep = '%' + c.toString(16).toUpperCase().padStart(2, '0');
    else if (c === 34 || c === 60 || c === 62 || c === 96 || c === 91 || c === 93 ||
             c === 123 || c === 125 || c === 124 || c === 94) {
      rep = '%' + c.toString(16).toUpperCase().padStart(2, '0');
    }
    else if (c === 39) rep = '&#39;';
    else if (c >= 128) {
      let ch = dest[i];
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < dest.length) {
        const c2 = dest.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) ch = dest.slice(i, i + 2);
      }
      rep = encodeURIComponent(ch);
      out += dest.slice(start, i) + rep;
      i += ch.length; start = i; continue;
    }
    if (rep !== null) { out += dest.slice(start, i) + rep; i++; start = i; continue; }
    i++;
  }
  return out + dest.slice(start);
}

/** Flanking: left-flanking / right-flanking of a delimiter run at [i, i+len) in s. */
function flanking(s, i, len) {
  const before = i > 0 ? s[i - 1] : undefined;
  const after = i + len < s.length ? s[i + len] : undefined;
  const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
  const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
  return { left, right };
}

// ---------------------------------------------------------------------------
// Inline parser
// ---------------------------------------------------------------------------
// Node kinds (all carry .p = parent node, root for top level):
//   text  {s: raw text}            -> escaped on render
//   raw   {s: already-escaped}     -> emitted verbatim (entity passthroughs, soft \n)
//   code  {s: raw code content}    -> escaped on render
//   br    (hard break)             -> <br>
//   html  {s: raw tag/comment}     -> emitted verbatim
//   delim {ch, len, canOpen, canClose} -> leftover delimiters render as literal chars
//   em | strong | del {c: children}
//   link  {href, title, c: children}   (href/title already cleaned + escaped)
//   img   {src, alt, title}             (alt already escaped)

function isAsciiLetter(ch) {
  const c = ch && ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isSchemeChar(ch) {
  const c = ch && ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || ch === '+' || ch === '-' || ch === '.';
}
function isEmailUserChar(ch) {
  const c = ch && ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
    '.!#$%&\'*+/=?^_`{|}~-'.indexOf(ch) >= 0;
}
function isEmailDomainChar(ch) {
  const c = ch && ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || ch === '-' || ch === '.';
}

/** Normalise a link label: collapse whitespace to one space, trim, Unicode case-fold. */
function normLabel(label) {
  return label.replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/ß/g, 'ss').replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl').replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st')
    .replace(/ς/g, 'σ');
}

/** Raw text between the brackets, backslashes kept (labels do not undo escapes). */
function rawTextBetween(s, from, to) {
  return s.slice(from, to);
}

/** Validate an email domain: non-empty, has a dot, alphanumeric TLD, no leading dot. */
function validEmailDomain(domain) {
  if (!domain || domain[0] === '.' || domain.indexOf('..') >= 0) return false;
  const dot = domain.lastIndexOf('.');
  if (dot < 0) return false;
  const tld = domain.slice(dot + 1);
  if (!tld) return false;
  for (let i = 0; i < tld.length; i++) {
    const c = tld.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return false;
  }
  return true;
}

/**
 * marked's GFM `_backpedal` (applied repeatedly until stable): keep runs of
 * ordinary chars and balanced `(...)` groups, drop a trailing run of
 * punctuation (unless it reaches the end of the token) and a trailing
 * `&word;` entity. This is what decides e.g. that `https://a.io/foo(bar`
 * links only `https://a.io/foo`, while `https://a.io/foo(bar)` links whole
 * and `www.example.com]` links with the `]` in it.
 */
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function backpedal(tok) {
  let prev;
  do {
    prev = tok;
    const m = BACKPEDAL_RE.exec(tok);
    tok = m ? m[0] : '';
  } while (tok !== prev);
  return tok;
}

/** True if any node in the list (or its descendants) is a bracket-formed link (autolinks do not count). */
function hasLink(nodes) {
  for (const n of nodes) {
    if (n.t === 'link' && n.bracket) return true;
    if (n.c && hasLink(n.c)) return true;
  }
  return false;
}

/**
 * If tok (an autolink token starting at s[i]) contains a ']' that would
 * close the innermost open bracket into a link, truncate tok there so the
 * link can still form (marked tries the link before the url). If the
 * bracket would not form a link (bad destination, no ref, or its label
 * already holds a link), the ']' stays part of the URL.
 */
function truncateAtLinkBracket(s, i, tok, brackets, refs, nodes) {
  if (!brackets.length) return tok;
  const close = tok.indexOf(']');
  if (close < 0) return tok;
  // an unescaped '[' before the ']' opens a new bracket, so the ']'
  // does not close the innermost one
  for (let q = 0; q < close; q++) {
    if (tok[q] === '[') {
      let bs = 0;
      for (let r = q - 1; r >= 0 && tok[r] === '\\'; r--) bs++;
      if (bs % 2 === 0) return tok;
    }
  }
  const b = brackets[brackets.length - 1];
  if (!tryLink(s, i + close, b, refs)) return tok;
  if (hasLink(nodes.slice(b.idx + 1))) return tok;
  return tok.slice(0, close);
}

/** Try a www. / scheme:// / scheme:email autolink starting at s[i] (letter). */
function matchExtended(s, i, brackets, refs, nodes) {
  const n = s.length;
  if (s[i] === 'w') {
    if (s.slice(i, i + 4) === 'www.') {
      let j = i + 4;
      while (j < n && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '<' && s[j] !== '>' && s[j] !== '"') j++;
      let tok = backpedal(truncateAtLinkBracket(s, i, s.slice(i, j), brackets, refs, nodes));
      if (tok.length > 4) {
        const rest = tok.slice(4);
        const dm = rest.match(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*/);
        const domain = dm ? dm[0] : '';
        if (domain && validEmailDomain(domain)) {
          return { href: 'http://' + tok, text: tok, end: i + tok.length };
        }
      }
    }
  }
  // scheme
  let j = i + 1;
  while (j < n && j < i + 32 && isSchemeChar(s[j])) j++;
  if (j > i + 1 && j < n && s[j] === ':') {
    if (s[j + 1] === '/' && s[j + 2] === '/') {
      let k = j + 3;
      while (k < n && s[k] !== ' ' && s[k] !== '\t' && s[k] !== '\n' && s[k] !== '<' && s[k] !== '>' && s[k] !== '"') k++;
      const tok = backpedal(truncateAtLinkBracket(s, i, s.slice(i, k), brackets, refs, nodes));
      if (tok.length > j - i + 3) return { href: tok, text: tok, end: i + tok.length };
      return null;
    }
    // scheme:email, optional one /segment (the scheme must be lowercase)
    let k = j + 1;
    const us = k;
    while (k < n && isEmailUserChar(s[k])) k++;
    const userEnd = k;
    if (k > us && s[k] === '@' && s.slice(i, j) === s.slice(i, j).toLowerCase()) {
      const d0 = k + 1;
      k = d0;
      while (k < n && isEmailDomainChar(s[k])) k++;
      let domain = s.slice(d0, k);
      while (domain.endsWith('.')) { domain = domain.slice(0, -1); k--; }
      if (validEmailDomain(domain) && s[k] !== '-' && s[k] !== '_') {
        let end = k;
        if (s[k] === '/') {
          let m = k + 1;
          while (m < n && s[m] !== ' ' && s[m] !== '\t' && s[m] !== '\n' && s[m] !== '<' && s[m] !== '>' && s[m] !== '"' && s[m] !== '/') m++;
          if (m > k + 1) end = m;
        }
        let tok = backpedal(s.slice(i, end));
        // the trim must not eat into the email itself (scheme + user@domain)
        if (tok.length >= j + 1 + (k - us)) {
          return { href: tok, text: tok, end: i + tok.length };
        }
      }
    }
  }
  return null;
}

/** Try an angle-bracket autolink <scheme:...> or <email> at s[i] === '<'. */
function matchAngleAutolink(s, i) {
  let k = i + 1;
  while (k < s.length) {
    const c = s.charCodeAt(k);
    if (s[k] === '>' || c < 32) break;
    if (s[k] === ' ' || s[k] === '\t' || s[k] === '\n') return null;
    k++;
  }
  if (k >= s.length || s[k] !== '>') return null;
  const inner = s.slice(i + 1, k);
  if (!inner) return null;
  const m = inner.match(/^([A-Za-z][A-Za-z0-9+.-]{1,31}):(.*)$/);
  if (m) return { href: inner, text: inner, end: k + 1 };
  const at = inner.indexOf('@');
  if (at > 0 && inner.indexOf('@', at + 1) < 0) {
    const local = inner.slice(0, at);
    const domain = inner.slice(at + 1);
    // the local part must be plain email chars: a backslash invalidates it
    if (/^[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+$/.test(local) && validEmailDomain(domain)) return { href: 'mailto:' + inner, text: inner, end: k + 1 };
  }
  return null;
}

/** Try an inline HTML tag / comment / PI / declaration / CDATA at s[i] === '<'. */
function matchHtmlTag(s, i) {
  let j = i + 1;
  if (s[j] === '!') {
    if (s.startsWith('!--', j)) {
      const after = j + 3; // just past '<!--'
      if (s[after] === '>') return { text: s.slice(i, after + 1), end: after + 1 };
      if (s.startsWith('->', after)) return { text: s.slice(i, after + 2), end: after + 2 };
      const end = s.indexOf('-->', after);
      if (end < 0) return null;
      return { text: s.slice(i, end + 3), end: end + 3 };
    }
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9);
      if (end < 0) return null;
      return { text: s.slice(i, end + 3), end: end + 3 };
    }
    if (j + 1 < s.length && isAsciiLetter(s[j + 1])) {
      const end = s.indexOf('>', j + 1);
      if (end < 0) return null;
      return { text: s.slice(i, end + 1), end: end + 1 };
    }
    return null;
  }
  if (s[j] === '?') {
    const end = s.indexOf('?>', j + 1);
    if (end < 0) return null;
    return { text: s.slice(i, end + 2), end: end + 2 };
  }
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (j >= s.length || !isAsciiLetter(s[j])) return null;
  let k = j;
  while (k < s.length && (isAsciiLetter(s[k]) || (s[k] >= '0' && s[k] <= '9') || s[k] === '-')) k++;
  if (closing) {
    let m = k;
    while (m < s.length && (s[m] === ' ' || s[m] === '\t' || s[m] === '\n')) m++;
    if (s[m] === '>') return { text: s.slice(i, m + 1), end: m + 1 };
    return null;
  }
  let m = k;
  for (;;) {
    if (m >= s.length) return null;
    const c = s[m];
    if (c === '>') return { text: s.slice(i, m + 1), end: m + 1 };
    if (c === '/' && s[m + 1] === '>') return { text: s.slice(i, m + 2), end: m + 2 };
    if (c === ' ' || c === '\t' || c === '\n') {
      m++;
      while (m < s.length && (s[m] === ' ' || s[m] === '\t' || s[m] === '\n')) m++;
      if (m >= s.length) return null;
      if (s[m] === '>' || (s[m] === '/' && s[m + 1] === '>')) continue;
      // attribute name: first char letter/_/:, then letters, digits, _, -, ., :
      if (!/[A-Za-z_:]/.test(s[m])) return null;
      m++;
      while (m < s.length && /[A-Za-z0-9_.:-]/.test(s[m])) m++;
      // whitespace is allowed around '=': only consume it when '=' follows,
      // so a valueless attribute keeps its separator for the next attribute
      let q = m;
      while (q < s.length && (s[q] === ' ' || s[q] === '\t' || s[q] === '\n')) q++;
      if (s[q] === '=') {
        m = q + 1;
        while (m < s.length && (s[m] === ' ' || s[m] === '\t' || s[m] === '\n')) m++;
        if (s[m] === '"' || s[m] === "'") {
          const qq = s[m];
          const end = s.indexOf(qq, m + 1);
          if (end < 0) return null;
          m = end + 1;
        } else {
          while (m < s.length && /[^ \t\n"'=<>`]/.test(s[m])) m++;
        }
      }
      continue;
    }
    return null;
  }
}

/**
 * Parse an inline link "(dest 'title')" starting at the '(' (index after).
 * Returns {dest, title, end} or null.
 */
function tryInlineLink(s, after) {
  let p = after + 1;
  while (p < s.length && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n')) p++;
  if (p >= s.length) return null;
  let dest = '';
  if (s[p] === '<') {
    let q = p + 1;
    let ok = false;
    while (q < s.length) {
      const c = s[q];
      if (c === '\n') return null;
      if (c === '>') { ok = true; break; }
      if (c === '\\' && q + 1 < s.length && isAsciiPunct(s[q + 1])) { dest += s[q + 1]; q += 2; continue; }
      dest += c; q++;
    }
    if (!ok) return null;
    p = q + 1;
  } else {
    let q = p;
    let depth = 0;
    while (q < s.length) {
      const c = s[q];
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
      if (c === '\\' && q + 1 < s.length && isAsciiPunct(s[q + 1])) { dest += s[q + 1]; q += 2; continue; }
      if (c === '(') { depth++; dest += c; q++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--; dest += c; q++; continue;
      }
      dest += c; q++;
    }
    p = q;
  }
  while (p < s.length && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n')) p++;
  let title = null;
  if (p < s.length && (s[p] === '"' || s[p] === "'" || s[p] === '(')) {
    const open = s[p];
    const close = open === '(' ? ')' : open;
    let q = p + 1;
    let ok = false;
    while (q < s.length) {
      const c = s[q];
      if (c === '\\' && q + 1 < s.length && isAsciiPunct(s[q + 1])) { title = (title || '') + s[q + 1]; q += 2; continue; }
      if (open === '(' && c === '(') return null;
      if (c === close) { ok = true; break; }
      title = (title || '') + c; q++;
    }
    if (!ok) return null;
    p = q + 1;
    while (p < s.length && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n')) p++;
  }
  if (s[p] !== ')') return null;
  return { dest, title, end: p + 1 };
}

/**
 * Try to resolve a link at ']' (index j in s) for bracket b.
 * Returns {dest, title, end} with the raw destination/title, or null.
 * A failed inline link falls back to the shortcut reference link.
 */
function tryLink(s, j, b, refs) {
  const after = j + 1;
  const labelStart = b.start + (b.image ? 2 : 1); // after '[' (or '![' for images)
  if (s[after] === '(') {
    const inl = tryInlineLink(s, after);
    if (inl) return inl;
    // fall through to the shortcut reference link
  } else if (s[after] === '[') {
    let q = after + 1;
    let label = '';
    let ok = false;
    while (q < s.length) {
      const c = s[q];
      if (c === '\\' && q + 1 < s.length && isAsciiPunct(s[q + 1])) { label += s[q] + s[q + 1]; q += 2; continue; }
      if (c === '[') return null; // an unescaped '[' makes the label invalid
      if (c === ']') { ok = true; break; }
      label += c; q++;
    }
    if (!ok) return null;
    if (label === '') label = rawTextBetween(s, labelStart, j);
    const ref = refs.get(normLabel(label));
    if (!ref) return null;
    return { dest: ref.dest, title: ref.title, end: q + 1, ref: true };
  }
  const label = rawTextBetween(s, labelStart, j);
  const ref = refs.get(normLabel(label));
  if (!ref) return null;
  return { dest: ref.dest, title: ref.title, end: j + 1, ref: true };
}


/** Plain text of inline children (for image alt text): tags stripped, formatting kept. */
function plainText(children) {
  let out = '';
  for (const node of children) {
    switch (node.t) {
      case 'text': case 'raw': case 'code': out += node.s; break;
      case 'delim': out += node.ch.repeat(node.len); break;
      case 'em': case 'strong': case 'del': case 'link': out += plainText(node.c); break;
      case 'img': out += node.alt; break;
      default: break;
    }
  }
  return out;
}

/** Mark delimiter nodes in a discarded subtree as dead so emphasis skips them. */
function killDelims(children) {
  for (const node of children) {
    if (node.t === 'delim') node.len = 0;
    else if (node.c) killDelims(node.c);
  }
}

/**
 * Marked-style emphasis resolution (marked 18.1.3 emStrong/del), ported from
 * the vendored source. The CommonMark delimiter stack cannot reproduce
 * marked on `*X **Y**Z*` (marked leaves the outer em literal when the inner
 * ** closer is followed by a letter), so this re-implements marked's
 * per-opener forward scan: for each opener run, scan later runs of the same
 * char, classifying each by its surrounding characters, with the m/f
 * counters, the rule of 3, the R flag (opener can also close) and the o flag
 * (previous char is the same delimiter). Leftovers of the opener/closer
 * runs go INSIDE the formed em/strong and are resolved recursively; a failed
 * opener is retried one char shorter (consumed as literal text) until the
 * run is exhausted. Delimiters are resolved per children list (one scope),
 * recursing into link children and into formed em/strong/del nodes.
 */

/** Character class for the GFM emphasis scans. '~' is its own class here. */
function emCls(ch) {
  if (ch === undefined || ch === '') return 'none';
  if (ch === '~') return 'tilde';
  if (isSpace(ch)) return 'space';
  if (isPunct(ch)) return 'punct';
  return 'word';
}

/**
 * Scan class of a delimiter run from its before/after classes:
 * 'close' (marked groups 1/2), 'open' (groups 3/4), 'amb' (groups 5/6),
 * or 0 (invisible to the scan). The group-3 alternative takes a punct-or-
 * space before-char for '*' and '~' (punctSpace) but a space-only
 * before-char for '_' (GFM '_' has no group 6 at all: a '_' run between
 * two word chars, or after punctuation before a word, is invisible).
 * For '*' the '~' char is special (marked's GFM '*' regex treats '~' as a
 * word char for notPunctSpace but as punctuation for punct/punctSpace);
 * for '_' and '~' it counts as punct.
 */
function emScanClass(b, a, ch) {
  if (ch === '*') {
    if (b === 'tilde') {
      if (a === 'space' || a === 'end') return 'close';
      if (a === 'punct') return 'close';
      if (a === 'word' || a === 'tilde') return 'amb';
      return 0;
    }
    if (a === 'tilde') {
      if (b === 'punct') return 'open';
      if (b === 'word') return 'amb';
      if (b === 'space') return 'open';
      return 0;
    }
  }
  const bb = b === 'tilde' ? 'punct' : b;
  const aa = a === 'tilde' ? 'punct' : a;
  if (bb === 'punct' && (aa === 'space' || aa === 'end')) return 'close';
  if (bb === 'word' && (aa === 'punct' || aa === 'space' || aa === 'end')) return 'close';
  if (bb === 'space' && aa === 'word') return 'open';
  if (bb === 'space' && aa === 'punct') return 'open';
  if (bb === 'punct' && aa === 'punct') return 'amb';
  if (bb === 'punct' && aa === 'word') return 'open';
  if (ch !== '_' && bb === 'word' && aa === 'word') return 'amb';
  return 0;
}

/** marked's inline `punctuation` rule (nt): space or punctuation, not * _. */
function isPunctNt(ch) {
  return ch !== undefined && ch !== '' && ch !== '*' && ch !== '_' && (isSpace(ch) || isPunct(ch));
}

const OPEN_QUOTE_RE = /[\p{Pi}\p{Ps}"']/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;
const SKIP_RE_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)/;
const SKIP_RE_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)/;

/** Char after a delim run in its own scope ('end' if it ends the scope). */
function afterCharOf(node, s) {
  if (node.innerEnd) return undefined;
  return s[node.pos + node.len];
}

/** Last char of the text token preceding children[idx] ('' after a non-text node). */
function prevTextChar(children, idx) {
  if (idx === 0) return '';
  const prev = children[idx - 1];
  if (prev.t === 'text' || prev.t === 'raw') {
    const str = prev.s;
    return str.length ? str[str.length - 1] : '';
  }
  if (prev.t === 'delim') return prev.ch;
  return '';
}

/** Last char of a node, in masked-source terms (for a leftover closer's pCh). */
function lastMaskedChar(node) {
  if (node.t === 'text' || node.t === 'raw') return node.s.length ? node.s[node.s.length - 1] : '';
  if (node.t === 'delim') return node.ch;
  if (node.t === 'br') return '\n';
  return ']';
}

/**
 * End index (in s) of marked's scan-start skip span
 * (`__...*...__` for '*', `**..._...**` for '_'), or -1.
 */
function specialSkipEnd(s, from, ch) {
  const m = (ch === '*' ? SKIP_RE_AST : SKIP_RE_UND).exec(s.slice(from));
  return m ? from + m[0].length : -1;
}

/**
 * Try marked's emStrong scan for the delim at children[idx] (ch '*' or '_').
 * Returns {closerIdx, use, tag, literal} or null. `literal` is how many
 * chars of the opener run were consumed as literal text by failed retries.
 */
function tryEmStrongAt(children, idx, s) {
  const opener = children[idx];
  const ch = opener.ch;
  const n0 = prevTextChar(children, idx);
  const pCh = opener.pCh || '';
  const afterCh = afterCharOf(opener, s);
  // LDelim must match: the run is followed by a non-space char.
  if (afterCh === undefined || isSpace(afterCh)) return null;
  // GFM LDelim punct (ye) excludes '~'; it has no open-quote lookahead.
  const dPunct = isPunct(afterCh) && afterCh !== '~';
  const h = pCh === '*' || pCh === '_' || isPunctNt(pCh);
  const R = pCh !== '' && !isSpace(pCh) && (dPunct || (ch === '*' && !h));
  const skipEnd = specialSkipEnd(s, opener.pos + opener.len, ch);
  // last possible closer: last later run of ch whose before-char is not
  // whitespace (marked's fe(); a run at the string start counts as
  // whitespace-before, so pCh '' never qualifies)
  let v = -1;
  for (let j = idx + 1; j < children.length; j++) {
    const c = children[j];
    if (c.t !== 'delim' || c.len <= 0 || c.ch !== ch) continue;
    if (c.pCh !== '' && !isSpace(c.pCh)) v = c.pos;
  }
  if (v < opener.pos + opener.len) return null;
  const origLen = opener.len;
  for (let literal = 0; literal < origLen; literal++) {
    const k = origLen - literal;
    // retry `n`: a consumed '*' becomes the last text char (o=true), but a
    // consumed '_' does not update marked's `r` (text tokens ending in '_'
    // leave it alone), so '_' retries keep the original n
    const n = (literal === 0 || ch === '_') ? n0 : ch;
    const o = n === ch;
    const u = literal === 0 ? isPunctNt(n0) : h;
    // '_' guard: followed by a non-punct (ye) non-space char and the
    // previous char is alphanumeric -> this attempt cannot open
    if (ch === '_' && !dPunct && afterCh !== '_' && ALNUM_RE.test(n)) continue;
    // opener gate
    if (dPunct && n !== '' && !u) continue;
    let m = k, f = 0;
    const y = origLen;
    for (let j = idx + 1; j < children.length; j++) {
      const c = children[j];
      if (c.t !== 'delim' || c.len <= 0 || c.ch !== ch) continue;
      if (c.pos > v) break;
      if (skipEnd >= 0 && c.pos < skipEnd) continue;
      const aCh = afterCharOf(c, s);
      const cls = emScanClass(emCls(c.pCh), aCh === undefined ? 'end' : emCls(aCh), ch);
      if (cls === 0) continue;
      const b = c.len;
      if (cls === 'open') { m += b; continue; }
      if (cls === 'amb' || R) {
        if (o && cls === 'amb') break;
        if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      const usable = Math.min(b, b + m + f);
      const use = Math.min(k, usable);
      return { closerIdx: j, usable, use, tag: use % 2 === 1 ? 'em' : 'strong', literal };
    }
  }
  return null;
}

/**
 * Try marked's del scan for the '~' delim at children[idx].
 * The closer run must have exactly the opener's length; groups 3/4 add to
 * the counter, other groups subtract. No rule of 3, no retries.
 */
function tryDelAt(children, idx, s) {
  const opener = children[idx];
  const afterCh = afterCharOf(opener, s);
  // del LDelim: followed by a punct char or a non-space non-'~' char
  if (afterCh === undefined || isSpace(afterCh) || afterCh === '~') return null;
  const n0 = prevTextChar(children, idx);
  if (isPunct(afterCh) && afterCh !== '~' && n0 !== '' && !isPunctNt(n0)) return null;
  const o = opener.len;
  let u = -1;
  for (let j = idx + 1; j < children.length; j++) {
    const c = children[j];
    if (c.t !== 'delim' || c.len <= 0 || c.ch !== '~') continue;
    if (c.pCh !== '' && !isSpace(c.pCh)) u = c.pos;
  }
  if (u < opener.pos + opener.len) return null;
  let p = o;
  for (let j = idx + 1; j < children.length; j++) {
    const c = children[j];
    if (c.t !== 'delim' || c.len <= 0 || c.ch !== '~') continue;
    if (c.pos > u) break;
    if (c.len !== o) continue;
    const aCh = afterCharOf(c, s);
    const cls = emScanClass(emCls(c.pCh), aCh === undefined ? 'end' : emCls(aCh), '~');
    if (cls === 0) continue;
    if (cls === 'open') { p += c.len; continue; }
    p -= c.len;
    if (p > 0) continue;
    return { closerIdx: j, usable: o, use: o, tag: 'del', literal: 0 };
  }
  return null;
}

/** Resolve emphasis in one children list (one scope), in place. */
function resolveEmphasis(children, s) {
  let idx = 0;
  while (idx < children.length) {
    const node = children[idx];
    if (node.t !== 'delim' || node.len <= 0) { idx++; continue; }
    const res = node.ch === '~' ? tryDelAt(children, idx, s) : tryEmStrongAt(children, idx, s);
    if (!res) { idx++; continue; }
    const opener = children[idx];
    const closer = children[res.closerIdx];
    const inner = children.slice(idx + 1, res.closerIdx);
    // marked strips 1 (em) or 2 (strong) chars off each end of the raw
    // match; for del it strips the opener length. The rest of the opener
    // run and of the *usable* closer run stays inside the emphasis; closer
    // stars past the usable length stay outside as a live delimiter run.
    const strip = res.tag === 'del' ? opener.len : (res.use % 2 === 1 ? 1 : 2);
    const newChildren = [];
    const leftOp = opener.len - res.literal - strip;
    if (leftOp > 0) {
      newChildren.push({
        t: 'delim', ch: opener.ch, len: leftOp, origLen: opener.len,
        pos: opener.pos + res.literal + strip, pCh: '', innerEnd: false,
        canOpen: false, canClose: false, p: null, dead: false,
      });
    }
    for (const c of inner) newChildren.push(c);
    const leftCl = res.usable - strip;
    if (leftCl > 0) {
      newChildren.push({
        t: 'delim', ch: closer.ch, len: leftCl, origLen: closer.len,
        pos: closer.pos + strip,
        pCh: inner.length ? lastMaskedChar(inner[inner.length - 1]) : opener.ch,
        innerEnd: true, canOpen: false, canClose: false, p: null, dead: false,
      });
    }
    const emph = { t: res.tag, c: newChildren, p: opener.p };
    for (const c of newChildren) c.p = emph;
    // scope fix for emphasis inside this node (like the link scope fix):
    // the first child starts the scope (no before-char) and the last
    // delimiter ends it (its after-char is the end of the scope, not the
    // raw source char after the closer — e.g. a ** closer at the end of
    // a del's content sees end-of-scope, not the ~~ that closed the del)
    if (newChildren.length && newChildren[0].t === 'delim') newChildren[0].pCh = '';
    if (newChildren.length && newChildren[newChildren.length - 1].t === 'delim') newChildren[newChildren.length - 1].innerEnd = true;
    resolveAllEmphasis(newChildren, s);
    const replacement = [];
    if (res.literal > 0) replacement.push({ t: 'text', s: opener.ch.repeat(res.literal), p: opener.p });
    replacement.push(emph);
    const outsideCl = closer.len - res.usable;
    if (outsideCl > 0) {
      replacement.push({
        t: 'delim', ch: closer.ch, len: outsideCl, origLen: closer.len,
        pos: closer.pos + res.usable, pCh: closer.ch, innerEnd: false,
        canOpen: false, canClose: false, p: opener.p, dead: false,
      });
    }
    children.splice(idx, res.closerIdx - idx + 1, ...replacement);
    idx += replacement.length;
  }
}

/** Resolve emphasis in a children list and, recursively, in link children. */
function resolveAllEmphasis(children, s) {
  resolveEmphasis(children, s);
  for (const node of children) {
    if (node.t === 'link' && node.c) resolveAllEmphasis(node.c, s);
  }
}

/** Render inline nodes to HTML. */
function renderInline(nodes) {
  let out = '';
  for (const node of nodes) {
    switch (node.t) {
      case 'text': out += esc(node.s); break;
      case 'raw': out += node.s; break;
      case 'code': out += '<code>' + esc(node.s) + '</code>'; break;
      case 'br': out += '<br>'; break;
      case 'html': out += node.s; break;
      case 'delim': out += node.ch.repeat(node.len); break;
      case 'em': out += '<em>' + renderInline(node.c) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInline(node.c) + '</strong>'; break;
      case 'del': out += '<del>' + renderInline(node.c) + '</del>'; break;
      case 'link':
        out += '<a href="' + node.href + '"';
        if (node.title != null) out += ' title="' + node.title + '"';
        out += '>' + renderInline(node.c) + '</a>';
        break;
      case 'img':
        out += '<img src="' + node.src + '" alt="' + node.alt + '"';
        if (node.title != null) out += ' title="' + node.title + '"';
        out += '>';
        break;
    }
  }
  return out;
}

/** Parse an inline string to a root node. refs: Map of normalised label -> {dest, title}. */
// Persistent "inside an <a> tag" state (marked's lexer-level inLink):
// set by an inline <a ...> tag, cleared by an inline </a> tag. While set,
// angle/extended autolinks and bare emails are suppressed, in this and in
// later blocks, until a </a> is seen. Reset per document in parse().
let inLinkState = false;

function parseInline(s, refs) {
  const root = { t: 'root', c: [] };
  const nodes = root.c;
  const delims = [];
  const brackets = [];
  let buf = '';
  const flush = () => { if (buf) { nodes.push({ t: 'text', s: buf, p: root }); buf = ''; } };
  const n = s.length;
  let i = 0;
  while (i < n) {
    const ch = s[i];
    if (ch === '\\') {
      const nx = s[i + 1];
      if (nx === '\n') {
        flush(); nodes.push({ t: 'br', p: root }); i += 2;
        // a hard break swallows the next line's leading whitespace
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx)) { buf += nx; i += 2; continue; }
      buf += '\\'; i++; continue;
    }
    if (ch === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      let j = i + run;
      let found = -1;
      while (j < n) {
        if (s[j] === '`') {
          let r2 = 1;
          while (s[j + r2] === '`') r2++;
          if (r2 === run) { found = j; break; }
          j += r2;
        } else j++;
      }
      if (found < 0) { buf += '`'.repeat(run); i += run; continue; }
      let content = s.slice(i + run, found).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      flush();
      nodes.push({ t: 'code', s: content, p: root });
      i = found + run;
      continue;
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 1;
      while (s[i + run] === ch) run++;
      if (ch === '~' && run >= 3) { buf += '~'.repeat(run); i += run; continue; }
      const { left, right } = flanking(s, i, run);
      let canOpen, canClose;
      if (ch === '_') {
        canOpen = left && (!right || isPunct(s[i - 1]));
        canClose = right && (!left || isPunct(s[i + run]));
      } else {
        canOpen = left; canClose = right;
      }
      flush();
      // masked-source char before this run (marked's #n): text/raw -> its
      // last char, code/link/html/img -> ']' (the mask ends those with ']'),
      // hard break -> '\n', a delimiter run -> its char, start -> ''
      const pv = nodes[nodes.length - 1];
      let pCh = '';
      if (pv) {
        if (pv.t === 'text' || pv.t === 'raw') pCh = pv.s.length ? pv.s[pv.s.length - 1] : '';
        else if (pv.t === 'delim') pCh = pv.ch;
        else if (pv.t === 'br') pCh = '\n';
        else pCh = ']';
      }
      const d = { t: 'delim', ch, len: run, origLen: run, canOpen, canClose, pos: i, pCh, innerEnd: false, p: root, dead: false };
      nodes.push(d);
      delims.push(d);
      i += run;
      continue;
    }
    if (ch === '[') {
      flush();
      const node = { t: 'text', s: '[', p: root };
      nodes.push(node);
      brackets.push({ idx: nodes.length - 1, image: false, start: i });
      i++;
      continue;
    }
    if (ch === '!' && s[i + 1] === '[') {
      flush();
      const node = { t: 'text', s: '[', p: root };
      nodes.push(node);
      brackets.push({ idx: nodes.length - 1, image: true, start: i });
      i += 2;
      continue;
    }


/**
 * Replace extended autolinks (www/scheme/email) with their plain text:
 * inside a bracket link's text they are suppressed (marked's inLink),
 * while angle autolinks stay as nested links.
 */
function unwrapExtended(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.t === 'link' && n.extended) {
      for (const cn of n.c) out.push(cn);
    } else {
      if (n.c) n.c = unwrapExtended(n.c);
      out.push(n);
    }
  }
  return out;
}

    if (ch === ']') {
      if (brackets.length === 0) { buf += ']'; i++; continue; }
      const b = brackets[brackets.length - 1];
      flush();
      const res = tryLink(s, i, b, refs);
      // a link's text may not contain a link: the outer link fails
      const kids = nodes.slice(b.idx + 1);
      if (res && !b.image && hasLink(kids)) {
        brackets.pop();
        buf += ']'; i++; continue;
      }
      if (!res) {
        brackets.pop();
        if (b.image) nodes[b.idx].s = '![';
        buf += ']'; i++; continue;
      }
      const children = nodes.splice(b.idx + 1);
      nodes.splice(b.idx, 1);
      if (b.image) {
        killDelims(children);
        const alt = processEntities(plainText(children));
        nodes.splice(b.idx, 0, {
          t: 'img', src: cleanUrl(res.dest), alt,
          title: res.title != null ? processEntities(res.title) : null, p: root,
        });
      } else {
        const kids = unwrapExtended(children);
        // scope fix for emphasis inside the link text: the first child
        // starts the scope (no before-char) and the last delimiter ends it
        if (kids.length && kids[0].t === 'delim') kids[0].pCh = '';
        if (kids.length && kids[kids.length - 1].t === 'delim') kids[kids.length - 1].innerEnd = true;
        const link = {
          t: 'link', href: cleanUrl(res.dest), bracket: true,
          title: res.title != null ? processEntities(res.title) : null, c: kids, p: root,
        };
        for (const cn of kids) cn.p = link;
        nodes.splice(b.idx, 0, link);
      }
      brackets.pop();
      i = res.end;
      continue;
    }
    if (ch === '<') {
      // angle autolinks are NOT gated by inLink (marked calls autolink
      // unconditionally); only the extended url/email autolinks are gated
      const au = matchAngleAutolink(s, i);
      if (au) {
        flush();
        const link = { t: 'link', href: cleanUrl(au.href), title: null, c: [], p: root };
        link.c.push({ t: 'raw', s: processEntities(au.text), p: link });
        nodes.push(link);
        i = au.end; continue;
      }
      const tag = matchHtmlTag(s, i);
      if (tag) {
        // an inline <a ...> opens the inLink state, </a> closes it
        if (/^<a /i.test(tag.text)) inLinkState = true;
        else if (/^<\/a>/i.test(tag.text)) inLinkState = false;
        flush(); nodes.push({ t: 'html', s: tag.text, p: root }); i = tag.end; continue;
      }
      buf += '<'; i++; continue;
    }
    if (ch === '&') {
      const e = entityAt(s, i);
      if (e) {
        if (s[i + 1] !== '#') { flush(); nodes.push({ t: 'raw', s: e.text, p: root }); }
        else buf += e.text;
        i = e.next;
      } else { buf += '&'; i++; }
      continue;
    }
    if (ch === '@') {
      // scan the local part back in the raw text: it may span delimiter
      // nodes (_ and * are email chars but were emitted as emphasis delims)
      let ks = i - 1;
      while (ks >= 0 && isEmailUserChar(s[ks])) ks--;
      ks++;
      let done = false;
      // a backslash right before the local part means its first char is
      // escaped (foo\+@... is not an email); an even run of backslashes
      // is an escaped backslash and does not escape it
      let bs = 0;
      for (let q = ks - 1; q >= 0 && s[q] === '\\'; q--) bs++;
      if (ks < i && bs % 2 === 0 && !inLinkState) {
        const user = s.slice(ks, i);
        let j = i + 1;
        while (j < n && isEmailDomainChar(s[j])) j++;
        let domain = s.slice(i + 1, j);
        while (domain.endsWith('.')) { domain = domain.slice(0, -1); j--; }
        if (domain && validEmailDomain(domain) && s[j] !== '-' && (s[j] !== '_' || delims.some(d => d.ch === '_' && d.canOpen && d.len > 0))) {
          // rewind the local part out of the emitted output (buf + nodes);
          // it must be only plain text and delimiter nodes
          const count = i - ks;
          let rem = count;
          const ops = [];
          let ok = true;
          let b = buf.length;
          if (rem <= b) { ops.push(['buf', rem]); rem = 0; }
          else { ops.push(['buf', b]); rem -= b; }
          for (let q = nodes.length - 1; rem > 0 && q >= 0; q--) {
            const node = nodes[q];
            if (node.t === 'text') {
              const take = Math.min(rem, node.s.length);
              ops.push(['text', node, take]); rem -= take;
            } else if (node.t === 'delim') {
              const take = Math.min(rem, node.len);
              ops.push(['delim', node, take]); rem -= take;
            } else { ok = false; break; }
          }
          if (ok && rem === 0) {
            for (const op of ops) {
              if (op[0] === 'buf') buf = buf.slice(0, buf.length - op[1]);
              else if (op[0] === 'text') {
                op[1].s = op[1].s.slice(0, op[1].s.length - op[2]);
                if (!op[1].s) nodes.pop();
              } else {
                op[1].len -= op[2];
                if (op[1].len <= 0) {
                  nodes.pop();
                  const di = delims.indexOf(op[1]);
                  if (di >= 0) delims.splice(di, 1);
                }
              }
            }
            flush();
            const email = user + '@' + domain;
            const link = { t: 'link', href: 'mailto:' + email, title: null, c: [], p: root, extended: true };
            link.c.push({ t: 'raw', s: processEntities(email), p: link });
            nodes.push(link);
            i = j; done = true;
          }
        }
      }
      if (!done) { buf += '@'; i++; }
      continue;
    }
    if (ch === '\n') {
      let k = buf.length;
      while (k > 0 && buf[k - 1] === ' ') k--;
      const trailing = buf.length - k;
      if (trailing >= 2) {
        // hard break: the trailing spaces are the marker, and the next
        // line's leading whitespace is swallowed
        buf = buf.slice(0, k);
        flush();
        nodes.push({ t: 'br', p: root });
        i++;
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
      } else {
        // soft break: the spaces before it are kept as text
        flush();
        nodes.push({ t: 'raw', s: '\n', p: root });
        i++;
      }
      continue;
    }
    if (isAsciiLetter(ch)) {
      const prev = i > 0 ? s[i - 1] : '';
      if (!prev || isSpace(prev) || '([{<*~"\'`,;:!?/={})]'.indexOf(prev) >= 0) {
        const au = inLinkState ? null : matchExtended(s, i, brackets, refs, nodes);
        if (au) {
          flush();
          const link = { t: 'link', href: cleanUrl(au.href), title: null, c: [], p: root, extended: true };
          link.c.push({ t: 'raw', s: processEntities(au.text), p: link });
          nodes.push(link);
          i = au.end; continue;
        }
      }
      buf += ch; i++; continue;
    }
    buf += ch; i++;
  }
  flush();
  resolveAllEmphasis(root.c, s);
  return root;
}


// ---------------------------------------------------------------------------
// Block parser
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup ' +
  'dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 ' +
  'head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param ' +
  'section source summary table tbody td tfoot th thead title tr track ul').split(' '));

/** True if s from pos to the end of the line is only spaces/tabs. */
function isBlankFrom(s, pos) {
  for (let i = pos; i < s.length; i++) {
    if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return true;
}

/** Columns of whitespace at (s, pos, col): returns {cols, pos, col} after it. */
function indentCols(s, pos, col) {
  let p = pos, c = col;
  while (p < s.length && (s[p] === ' ' || s[p] === '\t')) {
    if (s[p] === ' ') { p++; c++; }
    else { c += 4 - (c % 4); p++; }
  }
  return { cols: c - col, pos: p, col: c };
}

/**
 * Consume n columns of leading whitespace at (s, pos, col). A partially-consumed
 * tab is replaced by spaces in the returned string. Returns {s, pos, col}.
 */
function consumeCols(s, pos, col, n) {
  let p = pos, c = col;
  while (n > 0) {
    if (s[p] === ' ') { p++; c++; n--; }
    else if (s[p] === '\t') {
      const adv = 4 - (c % 4);
      if (adv <= n) { p++; c += adv; n -= adv; }
      else {
        s = s.slice(0, p) + ' '.repeat(adv - n) + s.slice(p + 1);
        c += n; n = 0;
      }
    } else break;
  }
  return { s, pos: p, col: c };
}

/**
 * Try to read a list marker at (s, pos, col). Returns
 * {ordered, bullet, delim, start, width, markerCol} or null. The marker must be
 * followed by a space, a tab, or the end of the line.
 */
function readMarker(s, pos, col) {
  const ch = s[pos];
  if (ch === '-' || ch === '+' || ch === '*') {
    const nx = s[pos + 1];
    if (nx === undefined || nx === ' ' || nx === '\t') {
      return { ordered: false, bullet: ch, delim: null, start: 0, width: 1, markerCol: col };
    }
    return null;
  }
  if (ch >= '0' && ch <= '9') {
    let p = pos;
    let num = 0;
    let digits = 0;
    while (p < s.length && s[p] >= '0' && s[p] <= '9' && digits < 10) {
      num = num * 10 + (s.charCodeAt(p) - 48);
      p++; digits++;
    }
    if (digits === 0 || digits > 9 || num > 999999999) return null;
    const d = s[p];
    if (d !== '.' && d !== ')') return null;
    const nx = s[p + 1];
    if (nx !== undefined && nx !== ' ' && nx !== '\t') return null;
    return { ordered: true, bullet: null, delim: d, start: num, width: p - pos + 1, markerCol: col };
  }
  return null;
}

/**
 * From a marker, work out where the item content starts.
 * Returns {contentCol, empty} or null if the marker is not followed by space/EOL.
 * empty means the first line has no content after the marker.
 */
function markerContent(s, pos, col, marker) {
  const after = pos + marker.width;
  if (after >= s.length) return { contentCol: col + 2, empty: true };
  const ind = indentCols(s, after, col + marker.width);
  if (ind.cols === 0) return null; // marker not followed by space
  if (ind.pos >= s.length) return { contentCol: col + 2, empty: true }; // marker + spaces to EOL: empty item
  if (ind.cols >= 5) return { contentCol: col + marker.width + 1, empty: false };
  return { contentCol: col + marker.width + ind.cols, empty: false };
}

/**
 * Split a table row line into cells (marked's splitCells): a '|' is a
 * separator unless escaped by an odd run of backslashes; code spans are
 * NOT respected, so a '|' inside backticks still splits the row. Each
 * cell is trimmed and '\|' becomes '|'.
 */
function splitCells(line) {
  // mark unescaped pipes by prepending a space, then split on ' |'
  let t = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|') {
      let bs = 0;
      for (let k = i - 1; k >= 0 && line[k] === '\\'; k--) bs++;
      t += bs % 2 === 0 ? ' |' : '|';
    } else {
      t += line[i];
    }
  }
  const cells = t.split(' |');
  // a leading/trailing empty cell (from a leading/trailing pipe) is dropped
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map(c => c.trim().replace(/\\\|/g, '|'));
}

/** True if a line (after trimming) is a valid table delimiter row; returns aligns or null. */
function parseDelimiterRow(line) {
  // a delimiter row may be indented at most 3 columns
  let lead = 0;
  while (lead < line.length && (line[lead] === ' ' || line[lead] === '\t')) lead++;
  if (lead >= 4) return null;
  const cells = splitCells(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    aligns.push(cell[0] === ':' && cell[cell.length - 1] === ':' ? 'center' : cell[0] === ':' ? 'left' : cell[cell.length - 1] === ':' ? 'right' : null);
  }
  return aligns;
}


/** Skip up to 3 columns of spaces/tabs from (s, pos, col). */
function skipUpTo3Cols(s, pos, col) {
  let p = pos, c = col;
  while (p < s.length && c - col < 3) {
    if (s[p] === ' ') { p++; c++; }
    else if (s[p] === '\t') {
      const adv = 4 - (c % 4);
      if (c + adv - col > 3) break;
      p++; c += adv;
    } else break;
  }
  return { pos: p, col: c };
}

/**
 * Match the container stack against line li. If mutate, a new item of a list
 * replaces the old item in the stack; otherwise any failure returns null.
 * Returns {s, pos, col, k} (k = number of matched entries) or null.
 */
function matchContainers(st, li, mutate) {
  let s = st.lines[li];
  let pos = 0, col = 0;
  let k = 0;
  while (k < st.stack.length) {
    const c = st.stack[k];
    if (c.kind === 'quote') {
      const sk = skipUpTo3Cols(s, pos, col);
      let p = sk.pos, cc = sk.col;
      if (s[p] === '>') {
        p++; cc++;
        if (s[p] === ' ') { p++; cc++; }
        else if (s[p] === '\t') {
          const adv = 4 - (cc % 4);
          if (adv > 1) { s = s.slice(0, p) + ' '.repeat(adv - 1) + s.slice(p + 1); cc += 1; }
          else { p++; cc++; }
        }
        pos = p; col = cc;
        k++;
        continue;
      }
      return mutate ? { s, pos, col, k } : null;
    }
    // list item container
    if (isBlankFrom(s, pos)) { k++; continue; }
    const ind = indentCols(s, pos, col);
    // a closed item (emptied by a blank line) cannot gain content, but its
    // list stays open: fall through to the new-item check below
    // the item matches when the line's indent after the outer containers
    // reaches the item's content indent (contentCol relative to baseCol, the
    // column where the outer containers ended when the item opened):
    // absolute columns mislead when quotes sit at different columns
    if (!c.closed && ind.cols >= c.contentCol - c.baseCol) {
      const adv = consumeCols(s, pos, col, c.contentCol - col);
      s = adv.s; pos = adv.pos; col = adv.col;
      k++;
      continue;
    }
    if (mutate) {
      // a thematic break (e.g. "* * *") beats a new list item
      if (thematicBreak(s, pos, col)) return { s, pos, col, k };
      const sk = skipUpTo3Cols(s, pos, col);
      const m = readMarker(s, sk.pos, sk.col);
      if (m && ((m.ordered && c.ordered && m.delim === c.delim) || (!m.ordered && !c.ordered && m.bullet === c.bullet))) {
        const mc = markerContent(s, sk.pos, sk.col, m);
        if (mc) {
          if (st.para) st.para = null;
          st.stack.length = k;
          if (c.list.blankPending) c.list.loose = true;
          c.list.blankPending = false;
          const adv = consumeCols(s, sk.pos + m.width, sk.col + m.width, mc.contentCol - (sk.col + m.width));
          const itemNode = { t: 'item', c: [], task: null };
          st.stack.push({
            kind: 'item', node: itemNode, list: c.list, markerCol: sk.col,
            contentCol: mc.contentCol, baseCol: col, ordered: m.ordered, delim: m.delim, bullet: m.bullet, blankPending: false,
          });
          c.list.c.push(itemNode);
          return { s: adv.s, pos: adv.pos, col: adv.col, k: st.stack.length };
        }
      }
      return { s, pos, col, k };
    }
    return null;
  }
  return { s, pos, col, k };
}

/** Innermost container node, or the root document. */
function curParent(st) {
  return st.stack.length ? st.stack[st.stack.length - 1].node : st.root;
}

/** Add a block to the current container, tracking loose-list blank lines. */
function addBlock(st, node) {
  const parent = curParent(st);
  if (st.stack.length) {
    const top = st.stack[st.stack.length - 1];
    if (top.kind === 'item') {
      if (top.blankPending && parent.c.length > 0) top.list.loose = true;
      top.blankPending = false;
      top.list.blankPending = false;
    }
    // a block added anywhere consumes the pending blank for every list:
    // a later block in an outer item is not separated from this one by it
    for (let k = 0; k < st.stack.length; k++) {
      if (st.stack[k].kind === 'item') st.stack[k].list.blankPending = false;
    }
  }
  parent.c.push(node);
}

/** Close containers down to depth k (and a paragraph living inside them). */
function closeContainers(st, k) {
  if (st.para && st.paraDepth > k) st.para = null;
  st.stack.length = k;
}

/**
 * Append a lazy continuation line (containers failed to match, paragraph open)
 * to the open paragraph, computing its content the way marked does. The failing
 * container (st.stack[m.k]) decides:
 * - item: strip up to the item's content indent (all available whitespace if
 *   fewer), e.g. "    with two lines." in a 1. item becomes "with two lines."
 * - quote: keep the line as-is, except a setext underline line gains 4 spaces
 *   (so "===" stays paragraph text) and a run of lines indented 4+ is an
 *   indented code block absorbed into the paragraph (stripped by 4); the first
 *   plain line after such a run is separated by an extra blank line.
 */
function pushLazyLine(st, m) {
  const fail = st.stack[m.k];
  if (fail && fail.kind === 'item') {
    const adv = consumeCols(m.s, m.pos, m.col, Math.max(0, fail.contentCol - m.col));
    st.para.lines.push(adv.s.slice(adv.pos));
    st.lazyPrev = null;
    return;
  }
  const line = m.s.slice(m.pos);
  const se = /^( {0,3})((?:=+|-+)[ \t]*)$/.exec(line);
  if (se) {
    st.para.lines.push('    ' + se[2]);
    st.lazyPrev = null;
    return;
  }
  const ind = indentCols(m.s, m.pos, m.col);
  if (ind.cols >= 4 && st.lazyPrev !== 'plain') {
    const adv = consumeCols(m.s, m.pos, m.col, 4);
    st.para.lines.push(adv.s.slice(adv.pos));
    st.lazyPrev = 'code';
    return;
  }
  if (st.lazyPrev === 'code') st.para.lines.push('');
  st.para.lines.push(line);
  st.lazyPrev = 'plain';
}

/** Record a blank line on the list items it sits inside (for loose detection). */
function markBlank(st) {
  for (let k = st.stack.length - 1; k >= 0; k--) {
    const e = st.stack[k];
    // a blank inside a quote does not loosen the list around the quote
    if (e.kind === 'quote') break;
    if (e.kind === 'item') {
      e.blankPending = true;
      e.list.blankPending = true;
    }
  }
}

/** ATX heading at (s, pos, col): returns {level, text} or null. */
function atxHeading(s, pos, col) {
  const sk = skipUpTo3Cols(s, pos, col);
  let p = sk.pos;
  let hashes = 0;
  while (s[p] === '#') { hashes++; p++; }
  if (hashes === 0 || hashes > 6) return null;
  if (p >= s.length) return { level: hashes, text: '' };
  if (s[p] !== ' ' && s[p] !== '\t') return null;
  let text = s.slice(p).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  // closing sequence of #s, preceded by a space
  const m = text.match(/^(.*?)[ \t]+#+$/);
  if (m) text = m[1].replace(/[ \t]+$/, '');
  else if (/^#+$/.test(text)) text = '';
  return { level: hashes, text };
}

/** Fenced code start at (s, pos, col): returns {ch, len, info, indent} or null. */
function fenceStart(s, pos, col) {
  const sk = skipUpTo3Cols(s, pos, col);
  let p = sk.pos;
  const ch = s[p];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (s[p] === ch) { len++; p++; }
  if (len < 3) return null;
  const rawInfo = s.slice(p).replace(/^[ \t]+|[ \t]+$/g, '');
  if (ch === '`' && rawInfo.indexOf('`') >= 0) return null;
  // the info string is its first word only (foo bar -> foo)
  const firstWord = rawInfo.split(/[ \t]/)[0];
  // backslash escapes in the info string are processed (foo\+bar -> foo+bar)
  let info = '';
  for (let q = 0; q < firstWord.length; q++) {
    if (firstWord[q] === '\\' && q + 1 < firstWord.length && isAsciiPunct(firstWord[q + 1])) { info += firstWord[q + 1]; q++; }
    else info += firstWord[q];
  }
  return { ch, len, info, indent: sk.col - col };
}

/** Thematic break at (s, pos, col): true if the rest is 3+ of one of * - _ with spaces. */
function thematicBreak(s, pos, col) {
  const sk = skipUpTo3Cols(s, pos, col);
  let p = sk.pos;
  const ch = s[p];
  if (ch !== '*' && ch !== '-' && ch !== '_') return false;
  let count = 0;
  while (p < s.length) {
    const c = s[p];
    if (c === ch) { count++; p++; }
    else if (c === ' ' || c === '\t') p++;
    else return false;
  }
  return count >= 3;
}

/**
 * HTML block start at (s, pos, col). Returns {type, tag} (tag = opening tag name
 * for type 1) or null. paraOpen: type 7 can only start when no paragraph is open.
 */
function htmlBlockStart(s, pos, col, paraOpen) {
  const sk = skipUpTo3Cols(s, pos, col);
  let p = sk.pos;
  if (s[p] !== '<') return null;
  const rest = s.slice(p).toLowerCase();
  const m1 = rest.match(/^<(script|pre|style|textarea)([ \t>]|$)/);
  if (m1) return { type: 1, tag: m1[1] };
  if (rest.startsWith('<!--')) return { type: 2, tag: null };
  if (rest.startsWith('<?')) return { type: 3, tag: null };
  if (/^<![a-z]/.test(rest)) return { type: 4, tag: null };
  if (rest.startsWith('<![cdata[')) return { type: 5, tag: null };
  if (/^<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)([ \t/>]|$)/.test(rest)) return { type: 6, tag: null };
  if (!paraOpen) {
    // type 7: a complete open tag or closing tag, alone on the line
    const tag = matchHtmlTag(s, p);
    if (tag && tag.end === s.length) return { type: 7, tag: null };
  }
  return null;
}

/** Does the line at (s, pos, col) start a block that can interrupt a paragraph? */
function startsInterruptBlock(s, pos, col) {
  if (atxHeading(s, pos, col)) return true;
  if (fenceStart(s, pos, col)) return true;
  const hb = htmlBlockStart(s, pos, col, true);
  if (hb && hb.type >= 1 && hb.type <= 6) return true;
  if (thematicBreak(s, pos, col)) return true;
  const sk = skipUpTo3Cols(s, pos, col);
  if (s[sk.pos] === '>') return true;
  const m = readMarker(s, sk.pos, sk.col);
  if (m) {
    const mc = markerContent(s, sk.pos, sk.col, m);
    if (mc && !mc.empty) {
      if (!m.ordered) return true;
      if (m.start === 1) return true;
    }
  }
  return false;
}

/** Does the line at (s, pos, col) start any block (for table body-row ending)? */
function startsBlock(s, pos, col) {
  if (startsInterruptBlock(s, pos, col)) return true;
  const hb = htmlBlockStart(s, pos, col, false);
  if (hb && hb.type === 7) return true;
  const ind = indentCols(s, pos, col);
  if (ind.cols >= 4) return true;
  const sk = skipUpTo3Cols(s, pos, col);
  const m = readMarker(s, sk.pos, sk.col);
  if (m) return true;
  return false;
}

/** Setext underline level (1 for =, 2 for -) at (s, pos, col), or 0. */
function setextLevel(s, pos, col) {
  const sk = skipUpTo3Cols(s, pos, col);
  let p = sk.pos;
  const ch = s[p];
  if (ch !== '=' && ch !== '-') return 0;
  let q = p;
  while (s[q] === ch) q++;
  while (q < s.length) {
    if (s[q] !== ' ' && s[q] !== '\t') return 0;
    q++;
  }
  return ch === '=' ? 1 : 2;
}

/** Strip a leading task-list marker from text; returns {task, text} or null. */
function stripTask(text) {
  if (text[0] !== '[') return null;
  const c = text[1];
  if (c !== ' ' && c !== 'x' && c !== 'X') return null;
  if (text[2] !== ']') return null;
  const after = text[3];
  if (after === undefined) return { task: c !== ' ', text: '' };
  if (after === ' ' || after === '\t') {
    let i = 3;
    while (text[i] === ' ' || text[i] === '\t') i++;
    return { task: c !== ' ', text: text.slice(i) };
  }
  return null;
}


/**
 * Parse one link reference definition from text (lines joined with '\n').
 * Returns {label, dest, title} or null.
 */
function parseRefDef(text) {
  let i = 0;
  const n = text.length;
  // up to 3 leading spaces/tabs are allowed before the label
  let lead = 0;
  while (i < n && lead < 3 && (text[i] === ' ' || text[i] === '\t')) { i++; lead++; }
  if (text[i] !== '[') return null;
  let j = i + 1;
  let label = '';
  while (j < n) {
    const c = text[j];
    if (c === '\\' && j + 1 < n && isAsciiPunct(text[j + 1])) { label += text[j] + text[j + 1]; j += 2; continue; }
    if (c === '[') return null; // an unescaped '[' makes the label invalid
    if (c === ']') break;
    label += c; j++;
  }
  if (j >= n || text[j] !== ']') return null;
  if (label.length > 999 || normLabel(label) === '') return null;
  j++;
  if (text[j] !== ':') return null;
  j++;
  while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
  if (j >= n) return null;
  let dest = '';
  if (text[j] === '<') {
    let k = j + 1;
    let ok = false;
    while (k < n) {
      const c = text[k];
      if (c === '\n') return null;
      if (c === '>') { ok = true; break; }
      if (c === '\\' && k + 1 < n && isAsciiPunct(text[k + 1])) { dest += text[k + 1]; k += 2; continue; }
      dest += c; k++;
    }
    if (!ok) return null;
    j = k + 1;
  } else {
    let k = j;
    let depth2 = 0;
    while (k < n) {
      const c = text[k];
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
      if (c === '\\' && k + 1 < n && isAsciiPunct(text[k + 1])) { dest += text[k + 1]; k += 2; continue; }
      if (c === '(') { depth2++; dest += c; k++; continue; }
      if (c === ')') {
        if (depth2 === 0) break;
        depth2--; dest += c; k++; continue;
      }
      dest += c; k++;
    }
    if (dest === '') return null;
    j = k;
  }
  const afterDest = j;
  while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
  let title = null;
  if (j < n && (text[j] === '"' || text[j] === "'" || text[j] === '(')) {
    // a title must be separated from the destination by whitespace
    if (j === afterDest) return null;
    const open = text[j];
    const close = open === '(' ? ')' : open;
    let k = j + 1;
    let ok = false;
    while (k < n) {
      const c = text[k];
      if (c === '\\' && k + 1 < n && isAsciiPunct(text[k + 1])) { title = (title || '') + text[k + 1]; k += 2; continue; }
      if (open === '(' && c === '(') return null;
      if (c === close) { ok = true; break; }
      title = (title || '') + c; k++;
    }
    if (!ok) return null;
    j = k + 1;
    while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
  }
  if (j < n) return null;
  return { label, dest, title };
}

/**
 * Try to parse link reference definitions starting at line li (content at s,pos).
 * Returns the number of lines consumed (0 if none).
 */
function parseRefDefs(st, li, s, pos) {
  let used = 0;
  let curLi = li;
  let curS = s, curPos = pos;
  for (;;) {
    const first = curS.slice(curPos);
    const nextLine = (off) => {
      if (curLi + off >= st.lines.length) return null;
      const lc = matchContainers(st, curLi + off, false);
      if (!lc || isBlankFrom(lc.s, lc.pos)) return null;
      return lc;
    };
    // a definition may span several lines (a multi-line title, or the
    // destination/title on following lines): take the LONGEST parse that
    // succeeds, trying up to 10 lines, stopping at a blank line
    let parsed = parseRefDef(first);
    let nlines = parsed ? 1 : 0;
    let text = first;
    for (let off = 1; off <= 9; off++) {
      const lc = nextLine(off);
      if (!lc) break;
      text += '\n' + lc.s.slice(lc.pos);
      const p = parseRefDef(text);
      if (p) { parsed = p; nlines = off + 1; }
    }
    if (!parsed) break;
    const key = normLabel(parsed.label);
    if (!st.refs.has(key)) st.refs.set(key, { dest: parsed.dest, title: parsed.title });
    used += nlines;
    curLi += nlines;
    if (curLi >= st.lines.length) break;
    const lc = matchContainers(st, curLi, false);
    if (!lc || isBlankFrom(lc.s, lc.pos)) break;
    curS = lc.s; curPos = lc.pos;
  }
  return used;
}

/**
 * Phase 2: the line content at (s, pos, col) has matched all containers.
 * Try block starts (looping while containers open), else paragraph text.
 * Returns the next line index to process.
 */
function phase2(st, li, s, pos, col) {
  // A setext underline or a table delimiter converts the open paragraph.
  if (st.para) {
    const se = setextLevel(s, pos, col);
    if (se) {
      const parent = st.paraParent.c;
      // a setext heading strips the paragraph's leading spaces ( Foo -> Foo)
      // and its trailing whitespace (Foo  -> Foo)
      const text = st.para.lines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      parent.splice(parent.indexOf(st.para), 1, { t: 'heading', level: se, text });
      st.para = null;
      return li + 1;
    }
    const aligns = parseDelimiterRow(s.slice(pos));
    if (aligns) {
      const lines = st.para.lines;
      const header = splitCells(lines[lines.length - 1]);
      if (header.length === aligns.length) {
        const tableNode = { t: 'table', aligns, header, rows: [] };
        const nodes = [];
        if (lines.length > 1) nodes.push({ t: 'para', lines: lines.slice(0, -1) });
        nodes.push(tableNode);
        const parent = st.paraParent.c;
        parent.splice(parent.indexOf(st.para), 1, ...nodes);
        st.para = null;
        st.table = { node: tableNode };
        return li + 1;
      }
    }
  }
  let curS = s, curPos = pos, curCol = col;
  for (;;) {
    // nothing left on the line after opening a container
    if (isBlankFrom(curS, curPos)) {
      if (curPos >= curS.length || !st.para) {
        // truly empty, or no paragraph open: a blank line inside the container
        st.para = null;
        st.table = null;
        // an empty list item's blank content is the item itself, not a blank
        // line: it must not loosen the list (cm-281/282/283)
        const top = st.stack[st.stack.length - 1];
        if (!(top && top.kind === 'item' && top.node.c.length === 0)) markBlank(st);
      } else {
        // whitespace-only content (e.g. ">  "): a paragraph continuation line
        st.para.lines.push(curS.slice(curPos));
      }
      return li + 1;
    }
    const atx = atxHeading(curS, curPos, curCol);
    if (atx) {
      st.para = null;
      addBlock(st, { t: 'heading', level: atx.level, text: atx.text });
      return li + 1;
    }
    const fe = fenceStart(curS, curPos, curCol);
    if (fe) {
      st.para = null;
      const contentLines = [];
      let j = li + 1;
      let closed = false;
      while (j < st.lines.length) {
        const lc = matchContainers(st, j, false);
        if (!lc) {
          // a lazy continuation line is still code content, but only when the
          // fence sits in a list item: inside a quote a line without '>'
          // ends the quote (and the code block) instead
          const top = st.stack[st.stack.length - 1];
          if (!top || top.kind !== 'item') break;
          const raw = st.lines[j];
          if (isBlankFrom(raw, 0) || startsInterruptBlock(raw, 0, 0)) break;
          const sk3 = skipUpTo3Cols(raw, 0, 0);
          let p3 = sk3.pos, run3 = 0;
          while (raw[p3] === fe.ch) { run3++; p3++; }
          if (run3 >= fe.len && isBlankFrom(raw, p3)) { closed = true; break; }
          contentLines.push(raw);
          j++;
          continue;
        }
        const sk2 = skipUpTo3Cols(lc.s, lc.pos, lc.col);
        let p2 = sk2.pos, run = 0;
        while (lc.s[p2] === fe.ch) { run++; p2++; }
        if (run >= fe.len && isBlankFrom(lc.s, p2)) { closed = true; break; }
        const ind2 = indentCols(lc.s, lc.pos, lc.col);
        const strip = Math.min(fe.indent, ind2.cols);
        const adv = consumeCols(lc.s, lc.pos, lc.col, strip);
        let content = adv.s.slice(adv.pos);
        // a tab in the leading whitespace of fenced-code content expands
        // to spaces by its column, when the fence is inside a container
        // (list item or blockquote); at the top level it stays a tab.
        // Nested blockquotes count only the outermost '>' towards the
        // column: each further level contributes 2 fewer columns.
        const inContainer = st.stack.length > 0;
        if (inContainer) {
          const quotes = st.stack.reduce((a, e) => a + (e.kind === 'quote' ? 1 : 0), 0);
          let col = adv.col - 2 * Math.max(0, quotes - 1);
          if (col < 0) col = 0;
          let p = 0;
          let expanded = '';
          while (p < content.length && (content[p] === ' ' || content[p] === '\t')) {
            if (content[p] === ' ') { expanded += ' '; col++; p++; }
            else { const w = 4 - (col % 4); expanded += ' '.repeat(w); col += w; p++; }
          }
          if (p > 0) content = expanded + content.slice(p);
        }
        contentLines.push(content);
        j++;
      }
      // blank lines are content: keep them all; a trailing newline is added
      // only when the last content line is non-empty
      const codeText = contentLines.length
        ? contentLines.join('\n') + (contentLines[contentLines.length - 1] !== '' ? '\n' : '')
        : '';
      addBlock(st, { t: 'code', info: fe.info, text: codeText, fenced: true });
      return closed ? j + 1 : j;
    }
    const hb = htmlBlockStart(curS, curPos, curCol, !!st.para);
    if (hb) {
      st.para = null;
      const contentLines = [];
      let j = li;
      let endLine = li;
      const closeFor = (line) => {
        const low = line.toLowerCase();
        if (hb.type === 1) return low.indexOf('</' + hb.tag) >= 0;
        if (hb.type === 2) return low.indexOf('-->') >= 0;
        if (hb.type === 3) return low.indexOf('?>') >= 0;
        if (hb.type === 4) return low.indexOf('>') >= 0;
        if (hb.type === 5) return low.indexOf(']]>') >= 0;
        return false;
      };
      if (hb.type >= 1 && hb.type <= 5) {
        // the first line is the one already matched in this call
        const first = curS.slice(curPos);
        contentLines.push(first);
        if (!closeFor(first)) {
          j = li + 1;
          while (j < st.lines.length) {
            const lc = matchContainers(st, j, false);
            if (!lc) break;
            const line = lc.s.slice(lc.pos);
            contentLines.push(line);
            endLine = j;
            if (closeFor(line)) break;
            j++;
          }
        }
      } else {
        contentLines.push(curS.slice(curPos));
        j = li + 1;
        while (j < st.lines.length) {
          const lc = matchContainers(st, j, false);
          if (!lc) break;
          if (isBlankFrom(lc.s, lc.pos)) break;
          contentLines.push(lc.s.slice(lc.pos));
          endLine = j;
          j++;
        }
      }
      let text = contentLines.join('\n');
      const after = endLine + 1;
      if (after >= st.lines.length) {
        if (st.srcEndsWithNewline) text += '\n';
      } else if (!isBlankFrom(st.lines[after], 0)) {
        // the trailing newline is kept only if the next line stays inside
        // this container (a following block outside it ends the block cleanly)
        const lc = matchContainers(st, after, false);
        if (lc) text += '\n';
      }
      addBlock(st, { t: 'html', text });
      return endLine + 1;
    }
    if (thematicBreak(curS, curPos, curCol)) {
      st.para = null;
      addBlock(st, { t: 'hr' });
      return li + 1;
    }
    const sk = skipUpTo3Cols(curS, curPos, curCol);
    if (curS[sk.pos] === '>') {
      st.para = null;
      const node = { t: 'quote', c: [] };
      addBlock(st, node);
      st.stack.push({ kind: 'quote', node });
      let p = sk.pos + 1, cc = sk.col + 1;
      if (curS[p] === ' ') { p++; cc++; }
      else if (curS[p] === '\t') {
        const adv = 4 - (cc % 4);
        if (adv > 1) { curS = curS.slice(0, p) + ' '.repeat(adv - 1) + curS.slice(p + 1); cc += 1; }
        else { p++; cc++; }
      }
      st.lines[li] = curS;
      curPos = p; curCol = cc;
      continue;
    }
    const m = readMarker(curS, sk.pos, sk.col);
    if (m) {
      const mc = markerContent(curS, sk.pos, sk.col, m);
      // an ordered list with start != 1 cannot interrupt a paragraph, unless
      // the paragraph sits in a list item (a nested list always interrupts)
      if (mc && !(st.para && (mc.empty || (st.paraParent.t !== 'item' && m.ordered && m.start !== 1)))) {
        st.para = null;
        const listNode = { t: 'list', ordered: m.ordered, start: m.start, loose: false, blankPending: false, c: [] };
        addBlock(st, listNode);
        const adv = consumeCols(curS, sk.pos + m.width, sk.col + m.width, mc.contentCol - (sk.col + m.width));
        const itemNode = { t: 'item', c: [], task: null };
        listNode.c.push(itemNode);
        st.stack.push({
          kind: 'item', node: itemNode, list: listNode, markerCol: sk.col,
          contentCol: mc.contentCol, baseCol: curCol, ordered: m.ordered, delim: m.delim, bullet: m.bullet, blankPending: false,
        });
        curS = adv.s; curPos = adv.pos; curCol = adv.col;
        st.lines[li] = curS;
        const tk = stripTask(curS.slice(curPos));
        if (tk) {
          itemNode.task = tk.task;
          curS = curS.slice(0, curPos) + tk.text;
          st.lines[li] = curS;
        }
        continue;
      }
    }
    if (!st.para) {
      const ind = indentCols(curS, curPos, curCol);
      if (ind.cols >= 4) {
        const contentLines = [];
        // the first line is the one already matched in this call
        const adv0 = consumeCols(curS, curPos, curCol, 4);
        st.lines[li] = adv0.s;
        contentLines.push(adv0.s.slice(adv0.pos));
        let j = li + 1;
        while (j < st.lines.length) {
          const lc = matchContainers(st, j, false);
          if (!lc) break;
          if (isBlankFrom(lc.s, lc.pos)) {
            // a space-only line keeps its spaces minus the 4-column indent
            const adv = consumeCols(lc.s, lc.pos, lc.col, 4);
            contentLines.push(adv.s.slice(adv.pos));
            j++; continue;
          }
          const ind2 = indentCols(lc.s, lc.pos, lc.col);
          if (ind2.cols < 4) break;
          const adv = consumeCols(lc.s, lc.pos, lc.col, 4);
          contentLines.push(adv.s.slice(adv.pos));
          j++;
        }
        while (contentLines.length && contentLines[contentLines.length - 1] === '') contentLines.pop();
        addBlock(st, { t: 'code', info: '', text: contentLines.length ? contentLines.join('\n') + '\n' : '', fenced: false });
        return j;
      }
    }
    if (!st.para) {
      const used = parseRefDefs(st, li, curS, curPos);
      if (used > 0) return li + used;
    }
    if (st.para) {
      st.para.lines.push(curS.slice(curPos));
    } else {
      const node = { t: 'para', lines: [curS.slice(curPos)] };
      const parent = curParent(st);
      if (parent.t === 'item' && parent.task === null && parent.c.length === 0) {
        const tk = stripTask(node.lines[0]);
        if (tk) { parent.task = tk.task; node.lines[0] = tk.text; }
      }
      addBlock(st, node);
      st.para = node;
      st.paraParent = parent;
      st.paraDepth = st.stack.length;
    }
    return li + 1;
  }
}

/** Parse source text into a block tree plus the link reference definitions. */
function parseBlocks(src) {
  const refs = new Map();
  const lines = src.split('\n');
  const srcEndsWithNewline = src.endsWith('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const st = {
    lines, refs, root: { t: 'doc', c: [] }, stack: [],
    para: null, paraParent: null, paraDepth: 0, table: null, srcEndsWithNewline,
    lazyPrev: null,
  };
  let li = 0;
  while (li < lines.length) {
    // a whitespace-only line that contains a tab is a table row, not a
    // blank line, when a table is open (marked renders it as an empty row)
    if (isBlankFrom(lines[li], 0) && !(st.table && lines[li].includes('\t'))) {
      st.para = null;
      st.table = null;
      st.lazyPrev = null;
      markBlank(st);
      // an empty list item is closed by a blank line (it cannot gain content
      // after), but the list stays open so a following item can join it
      for (let k = st.stack.length - 1; k >= 0; k--) {
        const top = st.stack[k];
        if (top.kind === 'item' && top.node.c.length === 0) top.closed = true;
        else break;
      }
      // a truly blank line closes any open blockquote: a following > line
      // opens a new blockquote rather than continuing this one
      let firstQuote = -1;
      for (let k = 0; k < st.stack.length; k++) {
        if (st.stack[k].kind === 'quote') { firstQuote = k; break; }
      }
      if (firstQuote >= 0) st.stack.length = firstQuote;
      li++;
      continue;
    }
    const m = matchContainers(st, li, true);
    st.lines[li] = m.s;
    let lazy = false;
    // a blank remainder is a blank line inside the matched containers, not a
    // lazy continuation: it ends the paragraph (phase2 marks the blank)
    if (m.k < st.stack.length && st.para && !isBlankFrom(m.s, m.pos)) {
      if (st.paraDepth <= m.k) {
        // the paragraph's containers all matched: the usual interrupt rules
        if (!startsInterruptBlock(m.s, m.pos, m.col)) lazy = true;
      } else {
        // the paragraph sits inside a failed container, so the line is
        // outside it: only a plain line can be lazy. A list marker (even an
        // ordered one not starting at 1) starts a new list out there; an
        // indented line is still a lazy continuation, not a code block.
        let isBlock = startsInterruptBlock(m.s, m.pos, m.col);
        if (!isBlock) {
          const sk = skipUpTo3Cols(m.s, m.pos, m.col);
          if (readMarker(m.s, sk.pos, sk.col)) isBlock = true;
        }
        if (!isBlock) lazy = true;
      }
    }
    if (!lazy && m.k < st.stack.length) closeContainers(st, m.k);
    if (lazy) {
      pushLazyLine(st, m);
      li++;
      continue;
    }
    if (st.table) {
      // a tab-only line is a table row even though a tab looks like an
      // indented-code indent to startsBlock
      const tabRow = /^[ \t]*\t[ \t]*$/.test(m.s.slice(m.pos));
      if (m.k === st.stack.length && (tabRow || !startsBlock(m.s, m.pos, m.col))) {
        st.table.node.rows.push(splitCells(m.s.slice(m.pos)));
        st.lazyPrev = null;
        li++;
        continue;
      }
      st.table = null;
    }
    st.lazyPrev = null;
    li = phase2(st, li, m.s, m.pos, m.col);
  }
  return { root: st.root, refs };
}


// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBlocks(node, tight, refs) {
  switch (node.t) {
    case 'doc':
      return node.c.map(n => renderBlocks(n, false, refs)).join('');
    case 'para': {
      const inner = renderInline(parseInline(node.lines.join('\n'), refs).c);
      return tight ? inner : '<p>' + inner + '</p>\n';
    }
    case 'heading':
      return '<h' + node.level + '>' + renderInline(parseInline(node.text, refs).c) + '</h' + node.level + '>\n';
    case 'code': {
      const cls = node.info ? ' class="language-' + processEntities(node.info) + '"' : '';
      return '<pre><code' + cls + '>' + esc(node.text) + '</code></pre>\n';
    }
    case 'html':
      return node.text;
    case 'hr':
      return '<hr>\n';
    case 'quote':
      return '<blockquote>\n' + node.c.map(n => renderBlocks(n, false, refs)).join('') + '</blockquote>\n';
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      let out = '<' + tag;
      if (node.ordered && node.start !== 1) out += ' start="' + node.start + '"';
      out += '>\n';
      for (const item of node.c) out += renderBlocks(item, !node.loose, refs);
      return out + '</' + tag + '>\n';
    }
    case 'item': {
      if (node.c.length === 0) {
        if (node.task != null) {
          const cb = node.task ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">';
          return '<li>' + cb + '</li>\n';
        }
        return '<li></li>\n';
      }
      let inner = '';
      for (let idx = 0; idx < node.c.length; idx++) {
        const child = node.c[idx];
        if (idx === 0 && node.task != null) {
          const cb = node.task ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">';
          if (child.t === 'para') {
            const content = renderInline(parseInline(child.lines.join('\n'), refs).c);
            if (tight) inner += cb + (content ? ' ' + content : '');
            else inner += '<p>' + cb + (content ? ' ' + content : '') + '</p>\n';
          } else {
            inner += cb + ' ' + renderBlocks(child, false, refs);
          }
        } else {
          inner += renderBlocks(child, tight, refs);
        }
      }
      return '<li>' + inner + '</li>\n';
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let i = 0; i < node.header.length; i++) {
        const a = node.aligns[i];
        out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(parseInline(node.header[i], refs).c) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (node.rows.length) {
        out += '<tbody>';
        for (const row of node.rows) {
          out += '<tr>\n';
          for (let i = 0; i < node.header.length; i++) {
            const a = node.aligns[i];
            out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(parseInline(row[i] || '', refs).c) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody></table>\n';
      } else {
        out += '</table>\n';
      }
      return out;
    }
  }
  return '';
}

/**
 * Render markdown to HTML exactly as marked 18.1.3 does with default options.
 * Stateless: no caching across calls.
 */
export function parse(markdown) {
  inLinkState = false;
  const src = markdown.replace(/\r\n?/g, '\n');
  const { root, refs } = parseBlocks(src);
  return renderBlocks(root, false, refs);
}
