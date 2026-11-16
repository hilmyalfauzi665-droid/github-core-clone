// The forge's one process: an http server routing /healthz, REST v3, GraphQL v4,
// MCP, and git smart HTTP onto a single in-memory store. Every reply is JSON
// (never HTML) and carries a non-empty X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './git.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import {
  jsonError,
  jsonResponse,
  nextRequestId,
  readBody,
  type HttpRequest,
  type HttpResponse,
} from './http.ts';
import { Store } from './store.ts';

/** Split a raw path into decoded segments, keeping an undecodable one raw. */
function splitPath(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

function send(res: ServerResponse, response: HttpResponse): void {
  const headers: Record<string, string> = {
    'x-github-request-id': nextRequestId(),
    'content-type': response.contentType,
    'content-length': String(response.body.length),
    ...(response.headers ?? {}),
  };
  res.writeHead(response.status, headers);
  res.end(response.body);
}

function route(store: Store, req: HttpRequest): HttpResponse {
  // GET /healthz — the env's boot probe; no auth.
  if (req.pathname === '/healthz' && req.method === 'GET') {
    return jsonResponse(200, { ok: true });
  }

  const rest = handleRest(store, req);
  if (rest !== null) return rest;

  const graphql = handleGraphql(store, req);
  if (graphql !== null) return graphql;

  const mcp = handleMcp(store, req);
  if (mcp !== null) return mcp;

  const segments = splitPath(req.pathname);
  if (
    segments.length >= 3 &&
    segments[1]!.endsWith('.git') &&
    (segments[2] === 'info' || segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')
  ) {
    const git = handleGit(store, req);
    if (git !== null) return git;
  }

  return jsonError(404, 'Not Found');
}

/** Build the server (main.ts binds it to an ephemeral port and registers it). */
export function createApp(store: Store = new Store()): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const rawUrl = req.url ?? '/';
        const url = new URL(rawUrl, 'http://localhost');
        const method = (req.method ?? 'GET').toUpperCase();
        const body = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
          ? Buffer.alloc(0)
          : await readBody(req);
        const headers: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(req.headers)) {
          headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
        }
        const host = headers.host ?? '127.0.0.1';
        const httpRequest: HttpRequest = {
          method,
          pathname: `/${splitPath(url.pathname).join('/')}`,
          query: url.searchParams,
          headers,
          body,
          origin: `http://${host}`,
        };
        send(res, route(store, httpRequest));
      } catch (err) {
        // Never leak a stack or an HTML error page: a JSON 500.
        try {
          send(res, jsonError(500, err instanceof Error ? err.message : 'Internal Server Error'));
        } catch {
          res.destroy();
        }
      }
    })();
  });
}
