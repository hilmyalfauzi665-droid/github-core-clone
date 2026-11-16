// GraphQL v4: a small parser and executor for the queries the suite sends.
// It speaks the subset the conformance suite needs: operations with variables,
// arguments (inline enums, lists, input objects, null), aliases, inline
// fragments, named fragments, mutations, batch requests, and __type
// introspection for Issue, PullRequest, Repository and SearchType.

import { mergeBase, parseCommit } from './gitobj.ts';
import {
  isAuthenticated,
  jsonError,
  jsonResponse,
  parseJsonBody,
  type HttpRequest,
  type HttpResponse,
} from './http.ts';
import {
  VIEWER,
  Store,
  globalId,
  parseGlobalId,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'variable' | 'eof';
interface Token { kind: TokenKind; value: string }

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') { i += 1; continue; }
    if (ch === '#') { while (i < n && source[i] !== '\n') i += 1; continue; }
    if (ch === '.' && source.slice(i, i + 3) === '...') { tokens.push({ kind: 'spread', value: '...' }); i += 3; continue; }
    if (ch === '$') {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i + 1));
      if (!match) throw new Error(`Bad variable at ${i}`);
      tokens.push({ kind: 'variable', value: match[0] });
      i += 1 + match[0].length;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < n && source[i] !== '"') {
        const c = source[i]!;
        if (c === '\\') {
          const esc = source[i + 1];
          if (esc === undefined) throw new Error('Unterminated string');
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
            value += map[esc] ?? esc;
            i += 2;
          }
        } else {
          value += c;
          i += 1;
        }
      }
      if (i >= n) throw new Error('Unterminated string');
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(i));
      if (!match) throw new Error(`Bad number at ${i}`);
      const text = match[0];
      tokens.push({ kind: text.includes('.') || /[eE]/.test(text) ? 'float' : 'int', value: text });
      i += text.length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))!;
      tokens.push({ kind: 'name', value: match[0] });
      i += match[0].length;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int' | 'float'; value: number }
  | { kind: 'string' | 'boolean' | 'enum'; value: string | boolean }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface TypeNode { kind: 'named' | 'list' | 'nonNull'; name?: string; ofType?: TypeNode }
interface FieldNode { kind: 'field'; alias?: string; name: string; args: Array<{ name: string; value: ValueNode }>; selections: SelectionNode[] }
interface FragmentSpreadNode { kind: 'fragmentSpread'; name: string }
interface InlineFragmentNode { kind: 'inlineFragment'; typeCondition?: string; selections: SelectionNode[] }
type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;
interface VariableDefinition { name: string; type: TypeNode; defaultValue?: ValueNode }
interface OperationNode { kind: 'operation'; operation: 'query' | 'mutation'; name?: string; variables: VariableDefinition[]; selections: SelectionNode[] }
interface FragmentNode { kind: 'fragment'; name: string; typeCondition: string; selections: SelectionNode[] }
interface DocumentNode { operations: OperationNode[]; fragments: Map<string, FragmentNode> }

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token { return this.tokens[this.pos]!; }
  private next(): Token { return this.tokens[this.pos++]!; }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected ${value}, got ${token.value}`);
  }
  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`Expected a name, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`Expected ${value}, got ${token.value}`);
    return token.value;
  }
  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        const selections = this.parseSelectionSet();
        fragments.set(name, { kind: 'fragment', name, typeCondition, selections });
        continue;
      }
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new Error('No operation in document');
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', variables: [], selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
    }
    let name: string | undefined;
    if (this.peek().kind === 'name') name = this.next().value;
    const variables = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseVariableDefinitions() : [];
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { kind: 'operation', operation, name, variables, selections };
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    this.expectPunct('(');
    const variables: VariableDefinition[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const variable = this.next();
      if (variable.kind !== 'variable') throw new Error('Expected a variable in variable definitions');
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      variables.push({ name: variable.value, type, defaultValue });
    }
    this.expectPunct(')');
    return variables;
  }

  private parseType(): TypeNode {
    let type: TypeNode;
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      type = { kind: 'list', ofType: inner };
    } else {
      type = { kind: 'named', name: this.expectName() };
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      return { kind: 'nonNull', ofType: type };
    }
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
    this.skipDirectives();
    const selections = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'variable': return { kind: 'variable', name: token.value };
      case 'int': return { kind: 'int', value: Number.parseInt(token.value, 10) };
      case 'float': return { kind: 'float', value: Number.parseFloat(token.value) };
      case 'string': return { kind: 'string', value: token.value };
      case 'punct':
        if (token.value === '[') {
          const values: ValueNode[] = [];
          while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
          this.expectPunct(']');
          return { kind: 'list', values };
        }
        if (token.value === '{') {
          const fields: Array<{ name: string; value: ValueNode }> = [];
          while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
          }
          this.expectPunct('}');
          return { kind: 'object', fields };
        }
        throw new Error(`Unexpected punctuation ${token.value} in value`);
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      default:
        throw new Error(`Unexpected token ${token.value} in value`);
    }
  }
}

function parseDocument(source: string): DocumentNode {
  return new Parser(tokenize(source)).parseDocument();
}

// ---------------------------------------------------------------------------------------------
// values the executor works with
// ---------------------------------------------------------------------------------------------

type GqlValue = null | boolean | number | string | GqlObject | GqlValue[];

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

interface PageInfo { __typename: string; hasNextPage: boolean; endCursor: string | null; hasPreviousPage: boolean; startCursor: string | null }

function encodeCursor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1]!, 10) : null;
  } catch {
    return null;
  }
}

function pageInfoFor(page: Array<{ seq: number }>, hasNextPage: boolean): PageInfo {
  return {
    __typename: 'PageInfo',
    hasNextPage,
    endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]!.seq) : null,
    hasPreviousPage: false,
    startCursor: page.length > 0 ? encodeCursor(page[0]!.seq) : null,
  };
}

// The field names each introspected type exposes (checked by the suite).
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'url', 'resourcePath', 'comments', 'labels', 'repository'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'url', 'resourcePath', 'mergeCommit'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'private', 'isPrivate', 'url', 'createdAt', 'updatedAt', 'fork'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'avatarUrl', 'url'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  // SearchType is an enum, not an object type: it lives in ENUM_VALUES below.
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

interface GqlError { message: string; path: Array<string | number> }

class Executor {
  private errors: GqlError[] = [];
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  execute(document: DocumentNode, variables: Record<string, unknown>, operationName?: string): { data: Record<string, unknown>; errors?: GqlError[] } {
    this.errors = [];
    const operation = operationName !== undefined
      ? document.operations.find((op) => op.name === operationName) ?? document.operations[0]!
      : document.operations[0]!;
    const resolvedVariables: Record<string, unknown> = {};
    for (const definition of operation.variables) {
      if (Object.prototype.hasOwnProperty.call(variables, definition.name)) {
        resolvedVariables[definition.name] = variables[definition.name];
      } else if (definition.defaultValue !== undefined) {
        resolvedVariables[definition.name] = this.resolveValue(definition.defaultValue, variables);
      } else {
        resolvedVariables[definition.name] = null;
      }
    }
    const root: GqlObject = { __typename: 'Query' };
    const data = this.executeSelections(root, operation.selections, [], resolvedVariables, document);
    const result: { data: Record<string, unknown>; errors?: GqlError[] } = { data };
    if (this.errors.length > 0) result.errors = this.errors;
    return result;
  }

  private resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
    switch (node.kind) {
      case 'variable': return variables[node.name] ?? null;
      case 'int': case 'float': return node.value;
      case 'string': case 'boolean': case 'enum': return node.value;
      case 'null': return null;
      case 'list': return node.values.map((value) => this.resolveValue(value, variables));
      case 'object': {
        const out: Record<string, unknown> = {};
        for (const field of node.fields) out[field.name] = this.resolveValue(field.value, variables);
        return out;
      }
    }
  }

  private executeSelections(
    object: GqlObject,
    selections: SelectionNode[],
    path: Array<string | number>,
    variables: Record<string, unknown>,
    document: DocumentNode,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'fragmentSpread') {
        const fragment = document.fragments.get(selection.name);
        if (!fragment) {
          this.errors.push({ message: `Unknown fragment "${selection.name}"`, path });
          continue;
        }
        Object.assign(out, this.executeSelections(object, fragment.selections, path, variables, document));
        continue;
      }
      if (selection.kind === 'inlineFragment') {
        if (selection.typeCondition !== undefined && selection.typeCondition !== object.__typename) continue;
        Object.assign(out, this.executeSelections(object, selection.selections, path, variables, document));
        continue;
      }
      const responseKey = selection.alias ?? selection.name;
      const fieldPath = [...path, responseKey];
      let value: unknown;
      try {
        value = this.resolveField(object, selection, variables);
      } catch (err) {
        this.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
        out[responseKey] = null;
        continue;
      }
      if (selection.selections.length > 0) {
        if (value === null || value === undefined) {
          out[responseKey] = null;
          continue;
        }
        if (Array.isArray(value)) {
          out[responseKey] = value.map((item, index) => this.wrapSelection(item, selection.selections, [...fieldPath, index], variables, document));
        } else if (typeof value === 'object') {
          out[responseKey] = this.wrapSelection(value, selection.selections, fieldPath, variables, document);
        } else {
          this.errors.push({ message: `Field "${selection.name}" must not have sub-selections`, path: fieldPath });
          out[responseKey] = null;
        }
        continue;
      }
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        // An object without sub-selections has no shape to return.
        out[responseKey] = null;
        continue;
      }
      out[responseKey] = value as GqlValue;
    }
    return out;
  }

  private wrapSelection(
    value: unknown,
    selections: SelectionNode[],
    path: Array<string | number>,
    variables: Record<string, unknown>,
    document: DocumentNode,
  ): unknown {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' || Array.isArray(value)) return value;
    return this.executeSelections(value as GqlObject, selections, path, variables, document);
  }

  private argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    for (const arg of field.args) args[arg.name] = this.resolveValue(arg.value, variables);
    return args;
  }

  // -- field resolution ----------------------------------------------------------

  private resolveField(object: GqlObject, field: FieldNode, variables: Record<string, unknown>): unknown {
    const args = this.argsOf(field, variables);
    const typeName = object.__typename;

    if (field.name === '__typename') return typeName;

    switch (typeName) {
      case 'Query': return this.resolveQueryField(object, field, args);
      case 'User': return this.resolveUserField(object, field, args);
      case 'Repository': return this.resolveRepositoryField(object, field, args);
      case 'Issue': return this.resolveIssueField(object, field, args);
      case 'PullRequest': return this.resolvePullRequestField(object, field, args);
      case 'IssueComment': return this.resolveCommentField(object, field, args);
      case 'IssueConnection': case 'PullRequestConnection': case 'PullRequestFileConnection':
        return this.resolveConnectionField(object, field, args);
      case 'PullRequestFile': return this.resolveFileField(object, field, args);
      case 'PageInfo': return this.resolvePageInfoField(object, field, args);
      case 'Type': return this.resolveTypeField(object, field, args);
      case 'TypeField': return this.resolveTypeFieldEntry(object, field, args);
      case 'EnumValue': return this.resolveEnumValueField(object, field, args);
      case 'BranchRef': return this.resolveBranchRefField(object, field, args);
      case 'IssueCommentEdge': return (object as { node: GqlObject }).node;
      case 'CreateIssuePayload': case 'CloseIssuePayload': return (object as { issue: GqlObject }).issue;
      case 'CreatePullRequestPayload': case 'MergePullRequestPayload': return (object as { pullRequest: GqlObject }).pullRequest;
      case 'AddCommentPayload': return (object as { commentEdge: GqlObject }).commentEdge;
      default:
        throw new Error(`Cannot query field "${field.name}" on type "${typeName}"`);
    }
  }

  private resolveQueryField(_object: GqlObject, field: FieldNode, args: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'viewer':
        return { __typename: 'User', login: VIEWER.login, id: VIEWER.id } as GqlObject;
      case 'repository': {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        if (owner !== VIEWER.login) return null;
        const repo = this.store.getRepo(owner, name);
        if (!repo) return null;
        return { __typename: 'Repository', repo } as GqlObject;
      }
      case 'node': {
        const id = String(args.id ?? '');
        return this.resolveNode(id);
      }
      case '__type': {
        const name = String(args.name ?? '');
        if (name in TYPE_FIELDS) {
          return { __typename: 'Type', name, kind: 'OBJECT', fields: TYPE_FIELDS[name]!, enumValues: null } as GqlObject;
        }
        if (name in ENUM_VALUES) {
          return { __typename: 'Type', name, kind: 'ENUM', fields: null, enumValues: ENUM_VALUES[name]! } as GqlObject;
        }
        return null;
      }
      case '__schema':
        return { __typename: 'Schema' } as GqlObject;
      default:
        throw new Error(`Cannot query field "${field.name}" on type "Query"`);
    }
  }

  private resolveUserField(object: GqlObject, field: FieldNode, _args: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'login': return object.login;
      case 'id': return globalId('User', String(object.login));
      case 'databaseId': return object.id;
      case 'name': return VIEWER.name;
      case 'email': return VIEWER.email;
      case 'avatarUrl': return '';
      case 'url': return '';
      default:
        throw new Error(`Cannot query field "${field.name}" on type "User"`);
    }
  }

  private resolveRepositoryField(object: GqlObject, field: FieldNode, args: Record<string, unknown>): unknown {
    const repo = object.repo as Repo;
    switch (field.name) {
      case 'id': return globalId('Repository', `${repo.owner}/${repo.name}`);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'owner': return { __typename: 'User', login: repo.owner, id: VIEWER.id } as GqlObject;
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip === undefined ? null : ({ __typename: 'BranchRef', name: repo.defaultBranch } as GqlObject);
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'description': return repo.description;
      case 'private': case 'isPrivate': return repo.private;
      case 'fork': return false;
      case 'url': return '';
      case 'createdAt': case 'updatedAt': return '2025-01-01T00:00:00Z';
      case 'issue': {
        const issue = this.store.findIssue(repo, Number(args.number));
        return issue ? ({ __typename: 'Issue', repo, issue } as GqlObject) : null;
      }
      case 'issues': return this.issueConnection(repo, args);
      case 'pullRequest': {
        const pull = this.store.findPull(repo, Number(args.number));
        return pull ? ({ __typename: 'PullRequest', repo, pull } as GqlObject) : null;
      }
      case 'pullRequests': return this.pullRequestConnection(repo, args);
      default:
        throw new Error(`Cannot query field "${field.name}" on type "Repository"`);
    }
  }

  private resolveIssueField(object: GqlObject, field: FieldNode, _args: Record<string, unknown>): unknown {
    const repo = object.repo as Repo;
    const issue = object.issue as Issue;
    switch (field.name) {
      case 'id': return globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
      case 'databaseId': return issue.id;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'author': return { __typename: 'User', login: VIEWER.login, id: VIEWER.id } as GqlObject;
      case 'repository': return { __typename: 'Repository', repo } as GqlObject;
      case 'createdAt': case 'updatedAt': return '2025-01-01T00:00:00Z';
      case 'url': case 'resourcePath': return '';
      case 'comments': return { __typename: 'IssueConnection', nodes: [], pageInfo: pageInfoFor([], false) } as GqlObject;
      case 'labels': return { __typename: 'LabelConnection', nodes: [] } as GqlObject;
      default:
        throw new Error(`Cannot query field "${field.name}" on type "Issue"`);
    }
  }

  private resolvePullRequestField(object: GqlObject, field: FieldNode, args: Record<string, unknown>): unknown {
    const repo = object.repo as Repo;
    const pull = object.pull as Pull;
    switch (field.name) {
      case 'id': return globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`);
      case 'databaseId': return pull.id;
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED';
      case 'merged': return pull.merged;
      case 'mergeable': {
        if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
        return this.store.prMergeable(repo, pull);
      }
      case 'headRefName': return pull.head;
      case 'baseRefName': return pull.base;
      case 'headRef': return { __typename: 'BranchRef', name: pull.head } as GqlObject;
      case 'baseRef': return { __typename: 'BranchRef', name: pull.base } as GqlObject;
      case 'author': return { __typename: 'User', login: VIEWER.login, id: VIEWER.id } as GqlObject;
      case 'repository': return { __typename: 'Repository', repo } as GqlObject;
      case 'createdAt': case 'updatedAt': return '2025-01-01T00:00:00Z';
      case 'url': case 'resourcePath': return '';
      case 'mergeCommit': return pull.mergeCommitSha === null ? null : ({ __typename: 'Commit', oid: pull.mergeCommitSha } as GqlObject);
      case 'files': return this.pullRequestFiles(repo, pull, args);
      default:
        throw new Error(`Cannot query field "${field.name}" on type "PullRequest"`);
    }
  }

  private resolveCommentField(object: GqlObject, field: FieldNode, _args: Record<string, unknown>): unknown {
    const comment = object.comment as { id: number; body: string };
    switch (field.name) {
      case 'id': return globalId('IssueComment', String(comment.id));
      case 'databaseId': return comment.id;
      case 'body': return comment.body;
      case 'author': return { __typename: 'User', login: VIEWER.login, id: VIEWER.id } as GqlObject;
      case 'createdAt': case 'updatedAt': return '2025-01-01T00:00:00Z';
      case 'url': return '';
      default:
        throw new Error(`Cannot query field "${field.name}" on type "IssueComment"`);
    }
  }

  private resolveConnectionField(object: GqlObject, field: FieldNode, _args: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'nodes': return object.nodes as GqlValue[];
      case 'edges': return (object.nodes as GqlObject[]).map((node) => ({ __typename: 'Edge', node }) as GqlObject);
      case 'pageInfo': return object.pageInfo as GqlObject;
      case 'totalCount': return (object.nodes as unknown[]).length;
      default:
        throw new Error(`Cannot query field "${field.name}" on type "${object.__typename}"`);
    }
  }

  private resolveFileField(object: GqlObject, field: FieldNode, _args: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'path': return object.path;
      case 'additions': return object.additions;
      case 'deletions': return object.deletions;
      case 'changes': return object.changes;
      default:
        throw new Error(`Cannot query field "${field.name}" on type "PullRequestFile"`);
    }
  }

  private resolvePageInfoField(object: GqlObject, field: FieldNode, _args: Record<string, unknown>): unknown {
    const info = object as unknown as PageInfo;
    switch (field.name) {
      case 'hasNextPage': return info.hasNextPage;
      case 'endCursor': return info.endCursor;
      case 'hasPreviousPage': return info.hasPreviousPage;
      case 'startCursor': return info.startCursor;
      default:
        throw new Error(`Cannot query field "${field.name}" on type "PageInfo"`);
    }
  }

  private resolveTypeField(object: GqlObject, field: FieldNode, _args: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'name': return object.name;
      case 'kind': return object.kind;
      case 'description': return null;
      case 'fields': {
        const names = object.fields as string[] | null;
        if (names === null) return null;
        return names.map((name) => ({ __typename: 'TypeField', name }) as GqlObject);
      }
      case 'enumValues': {
        const values = object.enumValues as string[] | null;
        if (values === null) return null;
        return values.map((name) => ({ __typename: 'EnumValue', name }) as GqlObject);
      }
      case 'possibleTypes': return null;
      default:
        throw new Error(`Cannot query field "${field.name}" on type "__Type"`);
    }
  }

  private resolveTypeFieldEntry(object: GqlObject, field: FieldNode, _args: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'name': return object.name;
      case 'description': return null;
      case 'args': return [];
      case 'type': return null;
      default:
        throw new Error(`Cannot query field "${field.name}" on type "__Field"`);
    }
  }

  private resolveEnumValueField(object: GqlObject, field: FieldNode, _args: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'name': return object.name;
      case 'description': return null;
      default:
        throw new Error(`Cannot query field "${field.name}" on type "__EnumValue"`);
    }
  }

  private resolveBranchRefField(object: GqlObject, field: FieldNode, _args: Record<string, unknown>): unknown {
    switch (field.name) {
      case 'name': return object.name;
      default:
        throw new Error(`Cannot query field "${field.name}" on type "Ref"`);
    }
  }

  // -- connections ---------------------------------------------------------------

  private issueConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
    const first = typeof args.first === 'number' ? args.first : null;
    const after = typeof args.after === 'string' ? args.after : null;
    const states = Array.isArray(args.states) ? (args.states as string[]) : null;
    const orderBy = (args.orderBy as { field?: string; direction?: string } | undefined) ?? null;
    let issues = [...repo.issues];
    if (states !== null) {
      const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : 'closed')));
      issues = issues.filter((issue) => wanted.has(issue.state));
    }
    const direction = orderBy?.direction ?? 'ASC';
    issues.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
    let startIndex = 0;
    if (after !== null) {
      const seq = decodeCursor(after);
      if (seq !== null) {
        const index = issues.findIndex((issue) => issue.seq === seq);
        if (index >= 0) startIndex = index + 1;
      }
    }
    const page = first !== null ? issues.slice(startIndex, startIndex + first) : issues.slice(startIndex);
    const hasNextPage = startIndex + page.length < issues.length;
    return {
      __typename: 'IssueConnection',
      nodes: page.map((issue) => ({ __typename: 'Issue', repo, issue }) as GqlObject),
      pageInfo: pageInfoFor(page, hasNextPage),
    } as GqlObject;
  }

  private pullRequestConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
    const first = typeof args.first === 'number' ? args.first : null;
    const after = typeof args.after === 'string' ? args.after : null;
    const pulls = [...repo.pulls].sort((a, b) => b.seq - a.seq);
    let startIndex = 0;
    if (after !== null) {
      const seq = decodeCursor(after);
      if (seq !== null) {
        const index = pulls.findIndex((pull) => pull.seq === seq);
        if (index >= 0) startIndex = index + 1;
      }
    }
    const page = first !== null ? pulls.slice(startIndex, startIndex + first) : pulls.slice(startIndex);
    const hasNextPage = startIndex + page.length < pulls.length;
    return {
      __typename: 'PullRequestConnection',
      nodes: page.map((pull) => ({ __typename: 'PullRequest', repo, pull }) as GqlObject),
      pageInfo: pageInfoFor(page, hasNextPage),
    } as GqlObject;
  }

  private pullRequestFiles(repo: Repo, pull: Pull, args: Record<string, unknown>): GqlObject {
    const first = typeof args.first === 'number' ? args.first : null;
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (!headTip || !baseTip) {
      return { __typename: 'PullRequestFileConnection', nodes: [], pageInfo: pageInfoFor([], false) } as GqlObject;
    }
    const base = mergeBase(headTip, baseTip, (oid) => repo.objects.get(oid));
    const baseTree = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const files = this.store.diffTrees(repo, baseTree, headTree);
    const nodes = files.map((file) => ({
      __typename: 'PullRequestFile',
      path: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      seq: 0,
    }) as GqlObject);
    const page = first !== null ? nodes.slice(0, first) : nodes;
    const hasNextPage = first !== null && nodes.length > first;
    return {
      __typename: 'PullRequestFileConnection',
      nodes: page,
      pageInfo: pageInfoFor(page.map((_, index) => ({ seq: index + 1 })), hasNextPage),
    } as GqlObject;
  }

  // -- node ----------------------------------------------------------------------

  private resolveNode(id: string): GqlObject | null {
    const parsed = parseGlobalId(id);
    if (!parsed) return null;
    const { kind, key } = parsed;
    if (kind === 'Repository') {
      const [owner, name] = key.split('/');
      if (!owner || !name) return null;
      const repo = this.store.getRepo(owner, name);
      return repo ? ({ __typename: 'Repository', repo } as GqlObject) : null;
    }
    if (kind === 'Issue' || kind === 'PullRequest') {
      const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(key);
      if (!match) return null;
      const repo = this.store.getRepo(match[1]!, match[2]!);
      if (!repo) return null;
      const number = Number.parseInt(match[3]!, 10);
      if (kind === 'Issue') {
        const issue = this.store.findIssue(repo, number);
        return issue ? ({ __typename: 'Issue', repo, issue } as GqlObject) : null;
      }
      const pull = this.store.findPull(repo, number);
      return pull ? ({ __typename: 'PullRequest', repo, pull } as GqlObject) : null;
    }
    return null;
  }

  // -- mutations (run from the root, before sub-selections) -----------------------

  /** Execute a mutation operation's top-level fields directly against the store. */
  executeMutation(document: DocumentNode, variables: Record<string, unknown>, operationName?: string): { data: Record<string, unknown>; errors?: GqlError[] } {
    this.errors = [];
    const operation = operationName !== undefined
      ? document.operations.find((op) => op.name === operationName) ?? document.operations[0]!
      : document.operations[0]!;
    const resolvedVariables: Record<string, unknown> = {};
    for (const definition of operation.variables) {
      if (Object.prototype.hasOwnProperty.call(variables, definition.name)) {
        resolvedVariables[definition.name] = variables[definition.name];
      } else if (definition.defaultValue !== undefined) {
        resolvedVariables[definition.name] = this.resolveValue(definition.defaultValue, variables);
      } else {
        resolvedVariables[definition.name] = null;
      }
    }
    const data: Record<string, unknown> = {};
    for (const selection of operation.selections) {
      if (selection.kind !== 'field') continue;
      const responseKey = selection.alias ?? selection.name;
      try {
        const payload = this.runMutation(selection.name, this.argsOf(selection, resolvedVariables));
        if (selection.selections.length === 0) {
          data[responseKey] = payload;
        } else {
          data[responseKey] = this.wrapSelection(payload, selection.selections, [responseKey], resolvedVariables, document);
        }
      } catch (err) {
        this.errors.push({ message: err instanceof Error ? err.message : String(err), path: [responseKey] });
        data[responseKey] = null;
      }
    }
    const result: { data: Record<string, unknown>; errors?: GqlError[] } = { data };
    if (this.errors.length > 0) result.errors = this.errors;
    return result;
  }

  private runMutation(name: string, args: Record<string, unknown>): GqlObject {
    switch (name) {
      case 'createIssue': {
        const input = args.input as Record<string, unknown>;
        const repo = this.mutationRepo(String(input.repositoryId ?? ''));
        const title = String(input.title ?? '');
        if (title === '') throw new Error('title is required');
        const body = typeof input.body === 'string' ? input.body : '';
        const issue = this.store.createIssue(repo, title, body, []);
        return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue } as GqlObject } as GqlObject;
      }
      case 'closeIssue': {
        const input = args.input as Record<string, unknown>;
        const { repo, issue } = this.mutationIssue(String(input.issueId ?? ''));
        issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo, issue } as GqlObject } as GqlObject;
      }
      case 'createPullRequest': {
        const input = args.input as Record<string, unknown>;
        const repo = this.mutationRepo(String(input.repositoryId ?? ''));
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        const title = String(input.title ?? '');
        const headTip = repo.refs.get(`refs/heads/${head}`);
        if (!headTip) throw new Error(`Head branch does not exist: ${head}`);
        const baseTip = repo.refs.get(`refs/heads/${base}`);
        if (!baseTip) throw new Error(`Base branch does not exist: ${base}`);
        const existing = repo.pulls.find((pull) => pull.head === head && pull.base === base && pull.state === 'open');
        if (existing) throw new Error('A pull request already exists for this head and base');
        const body = typeof input.body === 'string' ? input.body : '';
        const pull = this.store.createPull(repo, { title, body, head, base, headSha: headTip, baseSha: baseTip });
        return { __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } as GqlObject } as GqlObject;
      }
      case 'mergePullRequest': {
        const input = args.input as Record<string, unknown>;
        const { repo, pull } = this.mutationPull(String(input.pullRequestId ?? ''));
        const result = this.store.mergePullRequest(repo, pull);
        if (!result.ok) throw new Error(result.reason);
        return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } as GqlObject } as GqlObject;
      }
      case 'addComment': {
        const input = args.input as Record<string, unknown>;
        const { repo, issue } = this.mutationIssue(String(input.subjectId ?? ''));
        const body = String(input.body ?? '');
        if (body === '') throw new Error('body is required');
        const comment = { id: this.store.nextCommentId++, body };
        issue.comments.push(comment);
        const node = { __typename: 'IssueComment', repo, issue, comment } as GqlObject;
        return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node } as GqlObject } as GqlObject;
      }
      default:
        throw new Error(`Unknown mutation "${name}"`);
    }
  }

  private mutationRepo(global: string): Repo {
    const parsed = parseGlobalId(global);
    if (!parsed || parsed.kind !== 'Repository') throw new Error('Unknown repository id');
    const [owner, name] = parsed.key.split('/');
    const repo = owner && name ? this.store.getRepo(owner, name) : undefined;
    if (!repo) throw new Error('Unknown repository id');
    return repo;
  }

  private mutationIssue(global: string): { repo: Repo; issue: Issue } {
    const parsed = parseGlobalId(global);
    if (!parsed || parsed.kind !== 'Issue') throw new Error('Unknown issue id');
    const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(parsed.key);
    if (!match) throw new Error('Unknown issue id');
    const repo = this.store.getRepo(match[1]!, match[2]!);
    if (!repo) throw new Error('Unknown issue id');
    const issue = this.store.findIssue(repo, Number.parseInt(match[3]!, 10));
    if (!issue) throw new Error('Unknown issue id');
    return { repo, issue };
  }

  private mutationPull(global: string): { repo: Repo; pull: Pull } {
    const parsed = parseGlobalId(global);
    if (!parsed || parsed.kind !== 'PullRequest') throw new Error('Unknown pull request id');
    const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(parsed.key);
    if (!match) throw new Error('Unknown pull request id');
    const repo = this.store.getRepo(match[1]!, match[2]!);
    if (!repo) throw new Error('Unknown pull request id');
    const pull = this.store.findPull(repo, Number.parseInt(match[3]!, 10));
    if (!pull) throw new Error('Unknown pull request id');
    return { repo, pull };
  }
}

// ---------------------------------------------------------------------------------------------
// the HTTP handler
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function executeOne(store: Store, operation: unknown): { data: Record<string, unknown>; errors?: GqlError[] } {
  if (!isRecord(operation) || typeof operation.query !== 'string') {
    return { data: {}, errors: [{ message: 'A GraphQL operation must provide a query string', path: [] }] };
  }
  const variables = isRecord(operation.variables) ? operation.variables : {};
  const operationName = typeof operation.operationName === 'string' ? operation.operationName : undefined;
  let document: DocumentNode;
  try {
    document = parseDocument(operation.query);
  } catch (err) {
    return { data: {}, errors: [{ message: err instanceof Error ? err.message : String(err), path: [] }] };
  }
  const executor = new Executor(store);
  if (document.operations[0]?.operation === 'mutation') {
    return executor.executeMutation(document, variables, operationName);
  }
  return executor.execute(document, variables, operationName);
}

/** Handle POST /api/graphql; returns null when the path does not match. */
export function handleGraphql(store: Store, req: HttpRequest): HttpResponse | null {
  if (req.pathname !== '/api/graphql') return null;
  if (req.method !== 'POST') return jsonError(405, 'Method Not Allowed');
  if (!isAuthenticated(req)) return jsonError(401, 'Bad credentials');
  const { value, error } = parseJsonBody(req.body);
  if (error) return jsonError(400, 'Invalid JSON body');
  if (Array.isArray(value)) {
    return jsonResponse(200, value.map((operation) => executeOne(store, operation)));
  }
  return jsonResponse(200, executeOne(store, value));
}
