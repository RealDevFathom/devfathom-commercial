/*
 * Generate the frozen pre-migration control-boundary fixtures, never production data.
 * Run from the repository root: node tests/dev-1001/generate-fixtures.cjs
 * Dynamic records are synthetic; literal choices and lexical constants are evaluated.
 */
const fs = require('node:fs');
const cp = require('node:child_process');
const ts = require('typescript');
const base = '002b84ee1ca72880cee1f0ffebf4cdd79d343236';
const files = cp
  .execFileSync('git', ['ls-tree', '-r', '--name-only', base], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f.startsWith('src/') && f.endsWith('.tsx') && !f.includes('.test.'));
const retained = new Set([
  'src/app/(app)/pharmacy/purchasing/_components/form-controls.tsx:175',
  'src/components/restaurant/restaurant-branch-select.tsx:54',
  'src/components/pharmacy/sop/sop-setup.tsx:161',
  'src/components/restaurant/promotions/promotions-console.tsx:533',
  'src/components/restaurant/promotions/promotions-console.tsx:549',
  'src/components/restaurant/promotions/promotions-console.tsx:563',
  'src/components/restaurant/promotions/promotions-console.tsx:582',
  'src/components/restaurant/promotions/promotions-console.tsx:597',
  'src/components/restaurant/promotions/promotions-console.tsx:650',
  'src/components/restaurant/promotions/promotions-console.tsx:670',
]);
const dynamic = (path) => ({ __dynamic: path });
const isDynamic = (v) => v && typeof v === 'object' && '__dynamic' in v;
const string = (v) => (isDynamic(v) ? `Fixture ${v.__dynamic}` : v == null ? '' : String(v));
const controls = [];
for (const file of files) {
  const source = cp.execFileSync('git', ['show', `${base}:${file}`], { encoding: 'utf8' });
  if (!source.includes('<select')) continue;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const constants = new Map();
  const elements = [];
  function collect(n) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const existing = constants.get(n.name.text);
      constants.set(n.name.text, existing === undefined ? n.initializer : null);
    }
    if (ts.isJsxElement(n)) elements.push(n);
    ts.forEachChild(n, collect);
  }
  collect(sf);
  function ev(n, env = {}, seen = new Set()) {
    if (!n) return undefined;
    if (
      ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n) ||
      ts.isTypeAssertionExpression(n) ||
      ts.isNonNullExpression(n) ||
      ts.isSatisfiesExpression(n)
    )
      return ev(n.expression, env, seen);
    if (ts.isJsxExpression(n)) return ev(n.expression, env, seen);
    if (ts.isStringLiteralLike(n)) return n.text;
    if (ts.isNumericLiteral(n)) return Number(n.text);
    if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (n.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isIdentifier(n)) {
      if (Object.prototype.hasOwnProperty.call(env, n.text)) return env[n.text];
      if (n.text === 'undefined') return undefined;
      if (constants.get(n.text) && !seen.has(n.text))
        return ev(constants.get(n.text), env, new Set([...seen, n.text]));
      return dynamic(n.text);
    }
    if (ts.isArrayLiteralExpression(n)) return n.elements.map((e) => ev(e, env, seen));
    if (ts.isObjectLiteralExpression(n))
      return Object.fromEntries(
        n.properties
          .filter(ts.isPropertyAssignment)
          .map((p) => [
            p.name.getText(sf).replace(/^['"]|['"]$/g, ''),
            ev(p.initializer, env, seen),
          ])
      );
    if (ts.isPropertyAccessExpression(n)) {
      const object = ev(n.expression, env, seen);
      if (isDynamic(object)) return dynamic(`${object.__dynamic}.${n.name.text}`);
      return object?.[n.name.text] ?? dynamic(n.getText(sf));
    }
    if (ts.isElementAccessExpression(n)) {
      const object = ev(n.expression, env, seen);
      const property = ev(n.argumentExpression, env, seen);
      if (isDynamic(object)) return dynamic(`${object.__dynamic}.${string(property)}`);
      return object?.[property] ?? dynamic(n.getText(sf));
    }
    if (ts.isTemplateExpression(n))
      return (
        n.head.text +
        n.templateSpans.map((s) => string(ev(s.expression, env, seen)) + s.literal.text).join('')
      );
    if (ts.isConditionalExpression(n)) {
      const condition = ev(n.condition, env, seen);
      return ev(
        isDynamic(condition) ? n.whenTrue : condition ? n.whenTrue : n.whenFalse,
        env,
        seen
      );
    }
    if (ts.isBinaryExpression(n)) {
      const l = ev(n.left, env, seen),
        r = ev(n.right, env, seen);
      if (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
        return isDynamic(l) || l == null ? r : l;
      if (n.operatorToken.kind === ts.SyntaxKind.BarBarToken) return isDynamic(l) || !l ? r : l;
      if (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
        return isDynamic(l) || l ? r : l;
      if (n.operatorToken.kind === ts.SyntaxKind.PlusToken && !isDynamic(l) && !isDynamic(r))
        return l + r;
      if (
        n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        !isDynamic(l) &&
        !isDynamic(r)
      )
        return l === r;
      if (
        n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
        !isDynamic(l) &&
        !isDynamic(r)
      )
        return l !== r;
      return dynamic(n.getText(sf));
    }
    if (ts.isCallExpression(n)) {
      if (ts.isIdentifier(n.expression) && n.expression.text === 'String')
        return string(ev(n.arguments[0], env, seen));
      if (ts.isPropertyAccessExpression(n.expression)) {
        const o = ev(n.expression.expression, env, seen),
          method = n.expression.name.text;
        if (
          !isDynamic(o) &&
          typeof o === 'string' &&
          ['toLowerCase', 'toUpperCase', 'toLocaleLowerCase', 'trim'].includes(method)
        )
          return o[method]();
        if (!isDynamic(o) && typeof o === 'string' && method === 'replace') return o;
        if (method === 'entries' && n.expression.expression.getText(sf) === 'Object') {
          const v = ev(n.arguments[0], env, seen);
          if (v && !isDynamic(v)) return Object.entries(v);
        }
      }
      return dynamic(n.getText(sf).replace(/\s+/g, ' '));
    }
    return dynamic(n.getText(sf).replace(/\s+/g, ' '));
  }
  const attr = (el, name) =>
    el.openingElement.attributes.properties.find(
      (p) => ts.isJsxAttribute(p) && p.name.getText(sf) === name
    );
  const av = (el, name, env = {}) => {
    const a = attr(el, name);
    return a ? (a.initializer ? ev(a.initializer, env) : true) : undefined;
  };
  function textOf(n, env = {}, exclude = null) {
    if (n === exclude) return '';
    if (ts.isJsxText(n)) return n.text.replace(/\s+/g, ' ');
    if (ts.isJsxElement(n)) return n.children.map((c) => textOf(c, env, exclude)).join('');
    if (ts.isJsxExpression(n)) {
      if (!n.expression) return '';
      const value = ev(n.expression, env);
      return string(value);
    }
    return '';
  }
  function optionNodes(n, env, result) {
    if (ts.isJsxElement(n) && n.openingElement.tagName.getText(sf) === 'option') {
      const label = textOf(n, env).replace(/\s+/g, ' ').trim();
      const rawValue = av(n, 'value', env);
      const disabled = av(n, 'disabled', env);
      result.push({
        value: rawValue === undefined ? label : string(rawValue),
        label,
        disabled: disabled === true,
        dynamic: isDynamic(rawValue) || label.includes('Fixture '),
      });
      return;
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'map'
    ) {
      const fn = n.arguments[0];
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
        const rows = ev(n.expression.expression, env);
        const values =
          Array.isArray(rows) && rows.length
            ? rows
            : [dynamic('record one'), dynamic('record two')];
        values.slice(0, 24).forEach((value, i) => {
          const childEnv = { ...env };
          fn.parameters.forEach((p, index) => {
            const item = index ? i : value;
            if (ts.isIdentifier(p.name)) childEnv[p.name.text] = item;
            if (ts.isArrayBindingPattern(p.name))
              p.name.elements.forEach((e, k) => {
                if (ts.isBindingElement(e))
                  childEnv[e.name.getText(sf)] = Array.isArray(item)
                    ? item[k]
                    : dynamic(`record ${i + 1} ${k}`);
              });
          });
          optionNodes(fn.body, childEnv, result);
        });
        return;
      }
    }
    ts.forEachChild(n, (child) => optionNodes(child, env, result));
  }
  let ordinal = 0;
  for (const select of elements.filter(
    (el) => el.openingElement.tagName.getText(sf) === 'select'
  )) {
    const line = sf.getLineAndCharacterOfPosition(select.getStart(sf)).line + 1;
    const key = `${file}:${line}`;
    if (file.startsWith('src/components/pharmacy/counter/')) {
      ordinal++;
      continue;
    }
    const options = [];
    optionNodes(select, {}, options);
    // Repeated dynamic values can occur in distinct conditional option templates.
    // Both templates are retained in source; use unique local fixture keys for the boundary test.
    const seenValues = new Set();
    options.forEach((o, i) => {
      if (seenValues.has(o.value)) o.value += ` fixture ${i}`;
      seenValues.add(o.value);
    });
    let wrapping = select.parent;
    while (
      wrapping &&
      !(ts.isJsxElement(wrapping) && wrapping.openingElement.tagName.getText(sf) === 'label')
    )
      wrapping = wrapping.parent;
    let label = wrapping || null;
    const idSource = attr(select, 'id')?.initializer?.getText(sf);
    if (!label && idSource)
      label =
        elements.find(
          (el) =>
            el.openingElement.tagName.getText(sf) === 'label' &&
            attr(el, 'htmlFor')?.initializer?.getText(sf) === idSource
        ) || null;
    let field = select.parent;
    while (
      field &&
      !(
        ts.isJsxElement(field) &&
        field.openingElement.tagName.getText(sf) === 'Field' &&
        attr(field, 'label')
      )
    )
      field = field.parent;
    // Purchasing's render-prop Field supplies id/name and a visible linked label.
    // Model that documented control boundary instead of treating its spread as unlabeled.
    const fieldLabel = !label && field ? string(av(field, 'label')) : null;
    if (fieldLabel) label = field;
    const labelText =
      fieldLabel ?? (label ? textOf(label, {}, select).replace(/\s+/g, ' ').trim() : '');
    const ariaLabel = av(select, 'aria-label');
    const labelledBy = av(select, 'aria-labelledby');
    const mode =
      ariaLabel !== undefined
        ? 'aria-label'
        : labelledBy !== undefined
          ? 'aria-labelledby'
          : wrapping
            ? 'wrapped'
            : label
              ? 'for'
              : 'none';
    const rawInitial = av(select, 'value') ?? av(select, 'defaultValue');
    const literalInitial = isDynamic(rawInitial) ? undefined : rawInitial;
    const selected =
      options.find((o) => o.value === String(literalInitial)) ||
      options.find((o) => !o.disabled) ||
      options[0];
    const initial =
      literalInitial !== undefined && options.some((o) => o.value === String(literalInitial))
        ? String(literalInitial)
        : (selected?.value ?? '');
    const props = {};
    for (const name of [
      'name',
      'id',
      'form',
      'title',
      'aria-label',
      'aria-labelledby',
      'aria-describedby',
      'aria-invalid',
      'required',
      'disabled',
      'tabIndex',
    ]) {
      const raw = av(select, name);
      if (raw === undefined) continue;
      if (['required', 'disabled', 'aria-invalid'].includes(name)) props[name] = raw === true;
      else if (name === 'tabIndex') props[name] = typeof raw === 'number' ? raw : 0;
      else props[name] = string(raw);
    }
    if (fieldLabel) {
      props.id = 'fixture-control';
      props.name = string(av(field, 'name'));
    }
    if (props['aria-labelledby']) props['aria-labelledby'] = 'fixture-label';
    if (props['aria-describedby']) props['aria-describedby'] = 'fixture-help';
    if (props.form) props.form = 'fixture-form';
    if (props.id) props.id = 'fixture-control';
    const fixture = {
      key,
      file,
      line,
      ordinal: ordinal++,
      disposition: retained.has(key) ? 'retained' : 'migrated',
      source: select.getText(sf),
      labelSource: label?.getText(sf) ?? null,
      label: {
        mode,
        text:
          mode === 'aria-label'
            ? string(ariaLabel)
            : labelText || (labelledBy !== undefined ? string(labelledBy) : ''),
      },
      props,
      initial,
      controlled: !!attr(select, 'value'),
      defaulted: !!attr(select, 'defaultValue'),
      referenced: !!attr(select, 'ref'),
      options,
    };
    if (!options.length) throw Error(`No option templates ${key}`);
    controls.push(fixture);
  }
}
fs.writeFileSync(
  'tests/dev-1001/control-fixtures.json',
  JSON.stringify(
    {
      base,
      note: 'Frozen control-boundary fixtures. Dynamic records and dynamic labels use deterministic local stand-ins; they do not exercise page data loading, parent conditional rendering, or server actions. Source guards preserve the real expressions unchanged.',
      controls,
    },
    null,
    2
  ) + '\n'
);
console.log({
  controls: controls.length,
  migrated: controls.filter((x) => x.disposition === 'migrated').length,
  retained: controls.filter((x) => x.disposition === 'retained').length,
});
