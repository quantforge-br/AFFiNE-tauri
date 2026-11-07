import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const reference = 'ef401b20cb2a5960278a8e7ab2c0e96d8f759aeb';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const files = new Set(git('ls-tree', '-r', '--name-only', reference).trim().split('\n'));
const cache = new Map();

function source(file) {
  if (!cache.has(file)) {
    cache.set(file, ts.createSourceFile(file, git('show', reference + ':' + file), ts.ScriptTarget.Latest, true));
  }
  return cache.get(file);
}

function relativeModule(file, specifier) {
  if (!specifier.startsWith('.')) throw new Error('Unexpected external API definition: ' + specifier);
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  const resolved = [base + '.ts', base + '/index.ts'].find(candidate => files.has(candidate));
  if (!resolved) throw new Error('Cannot resolve ' + specifier + ' from ' + file);
  return resolved;
}

function unwrap(node) {
  while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function objectDefinition(file, symbol, visited = new Set()) {
  const key = file + ':' + symbol;
  if (visited.has(key)) throw new Error('Cyclic API definition: ' + key);
  visited.add(key);
  const tree = source(file);
  for (const statement of tree.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.name.getText(tree) !== symbol || !declaration.initializer) continue;
        const value = unwrap(declaration.initializer);
        if (!ts.isObjectLiteralExpression(value)) throw new Error('API is not an explicit object: ' + key);
        return { file, tree, node: value };
      }
    }
    if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      const binding = statement.importClause.namedBindings.elements.find(item => item.name.text === symbol);
      if (binding) return objectDefinition(relativeModule(file, statement.moduleSpecifier.text), binding.propertyName?.text ?? symbol, visited);
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const binding = statement.exportClause.elements.find(item => item.name.text === symbol);
      if (binding) return objectDefinition(relativeModule(file, statement.moduleSpecifier.text), binding.propertyName?.text ?? symbol, visited);
    }
  }
  for (const statement of tree.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || statement.exportClause) continue;
    try {
      return objectDefinition(relativeModule(file, statement.moduleSpecifier.text), symbol, new Set(visited));
    } catch (error) {
      if (!error.message.startsWith('Missing API definition:')) throw error;
    }
  }
  throw new Error('Missing API definition: ' + key);
}

function nameOf(property) {
  if (!property.name || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) throw new Error('Unrecognized API member');
  return property.name.text;
}

const surfaces = [
  ['main', 'command', 'packages/frontend/apps/electron/src/main/handlers.ts', 'allHandlers'],
  ['main', 'event', 'packages/frontend/apps/electron/src/main/events.ts', 'allEvents'],
  ['helper', 'command', 'packages/frontend/apps/electron/src/helper/exposed.ts', 'handlers'],
  ['helper', 'event', 'packages/frontend/apps/electron/src/helper/exposed.ts', 'events'],
];
const entries = [];
const namespaces = [];
for (const [process, kind, file, symbol] of surfaces) {
  const definition = objectDefinition(file, symbol);
  for (const property of definition.node.properties) {
    const namespace = nameOf(property);
    const value = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
    if (!value || !ts.isIdentifier(value)) throw new Error('Namespace must resolve to a named definition');
    const handler = objectDefinition(definition.file, value.text);
    namespaces.push({ process, kind, namespace, source: handler.file, members: handler.node.properties.length });
    for (const member of handler.node.properties) {
      const method = nameOf(member);
      entries.push({
        id: kind + ':' + namespace + ':' + method,
        process, kind, namespace, method,
        source: handler.file,
        line: handler.tree.getLineAndCharacterOfPosition(member.getStart(handler.tree)).line + 1,
        platforms: { linux: 'pending', windows: 'pending', macos: 'pending' },
        implementation: null,
        verification: [],
      });
    }
  }
}
entries.push({
  id: 'command:import:createImportSessionFromSource',
  process: 'preload', kind: 'command', namespace: 'import', method: 'createImportSessionFromSource',
  source: 'packages/frontend/apps/electron/src/preload/electron-api.ts',
  line: 371,
  platforms: { linux: 'pending', windows: 'pending', macos: 'pending' },
  implementation: null, verification: [],
});
// Derive the preload wrapper's line rather than relying on a manually maintained location.
const preload = source(entries.at(-1).source);
function visit(node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(preload) === 'createImportSessionFromSource') {
    entries.at(-1).line = preload.getLineAndCharacterOfPosition(node.getStart(preload)).line + 1;
  }
  ts.forEachChild(node, visit);
}
visit(preload);
entries.sort((a, b) => a.id.localeCompare(b.id, 'en'));
if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('Duplicate API identifiers');
process.stdout.write(JSON.stringify({ schemaVersion: 1, reference, namespaces, entries }, null, 2) + '\n');
