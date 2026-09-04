import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyCodexAppserverDiagnostic,
  CodexAppserverDiagnosticCoalescer,
  CodexDaemonLogForwarder,
} from './codex-appserver-diagnostics.js';

const mcpFailure = (url: string) =>
  `[codex-app] 2026-09-04T08:15:15Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Client(HttpRequest(HttpRequest("http/request failed: error sending request for url (${url})")))`;

test('classifies only known non-blocking Codex app-server diagnostics', () => {
  assert.deepEqual(
    classifyCodexAppserverDiagnostic(mcpFailure('http://127.0.0.1:9877/mcp?token=secret')),
    { kind: 'mcp_unavailable', endpoint: 'http://127.0.0.1:9877/mcp' },
  );
  assert.deepEqual(
    classifyCodexAppserverDiagnostic(
      mcpFailure('http://127.0.0.1:9877/mcp').replace('[codex-app] ', ''),
    ),
    { kind: 'mcp_unavailable', endpoint: 'http://127.0.0.1:9877/mcp' },
  );
  assert.deepEqual(
    classifyCodexAppserverDiagnostic(
      '[codex-app] ERROR codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit',
    ),
    { kind: 'model_refresh_timeout' },
  );
  assert.deepEqual(
    classifyCodexAppserverDiagnostic(
      '[codex-app] ERROR codex_skills_extension::host_service: failed to install system skills: io error while remove existing system skills dir: Directory not empty (os error 66)',
    ),
    { kind: 'system_skills_race' },
  );
  assert.equal(
    classifyCodexAppserverDiagnostic(
      '[codex-app] ERROR codex_core::tools::router: apply_patch verification failed',
    ),
    null,
  );
  assert.equal(
    classifyCodexAppserverDiagnostic(
      '[codex-channel] appserver thread resume failed: Transport channel closed',
    ),
    null,
  );
});

test('coalesces repeated diagnostics across agents and strips URL credentials', () => {
  const messages: string[] = [];
  const coalescer = new CodexAppserverDiagnosticCoalescer(message => messages.push(message));
  coalescer.record('one', {
    kind: 'mcp_unavailable',
    endpoint: 'http://127.0.0.1:9877/mcp',
  });
  coalescer.record('two', {
    kind: 'mcp_unavailable',
    endpoint: 'http://127.0.0.1:9877/mcp',
  });
  coalescer.record('two', { kind: 'model_refresh_timeout' });
  coalescer.flush();

  assert.equal(messages.length, 1);
  assert.match(messages[0], /coalesced 3 non-blocking app-server diagnostic\(s\)/);
  assert.match(messages[0], /across 2 daemon\(s\)/);
  assert.match(messages[0], /http:\/\/127\.0\.0\.1:9877\/mcp x2/);
  assert.match(messages[0], /model refresh timeout x1/);
});

test('line-buffered forwarder suppresses known noise but preserves real errors', () => {
  const output: string[] = [];
  const summaries: string[] = [];
  const coalescer = new CodexAppserverDiagnosticCoalescer(message => summaries.push(message));
  const forwarder = new CodexDaemonLogForwarder(
    '[codex:reviewer]',
    'reviewer',
    coalescer,
    true,
    text => output.push(text),
  );
  const noisy = `${mcpFailure('http://127.0.0.1:9877/mcp')}\n`;
  forwarder.push(noisy.slice(0, 70));
  forwarder.push(
    noisy.slice(70)
    + '[codex-app] ERROR codex_core::tools::router: apply_patch verification failed\n',
  );
  forwarder.end();
  coalescer.flush();

  assert.deepEqual(output, [
    '[codex:reviewer] [codex-app] ERROR codex_core::tools::router: apply_patch verification failed\n',
  ]);
  assert.equal(summaries.length, 1);
  assert.match(summaries[0], /MCP unavailable/);
});

test('raw mode forwards known diagnostics unchanged apart from line prefixing', () => {
  const output: string[] = [];
  const summaries: string[] = [];
  const coalescer = new CodexAppserverDiagnosticCoalescer(message => summaries.push(message));
  const forwarder = new CodexDaemonLogForwarder(
    '[codex:runtime]',
    'runtime',
    coalescer,
    false,
    text => output.push(text),
  );
  forwarder.push(`${mcpFailure('http://127.0.0.1:9100/mcp')}\n`);
  forwarder.end();
  coalescer.flush();

  assert.equal(output.length, 1);
  assert.match(output[0], /^\[codex:runtime\] \[codex-app\]/);
  assert.deepEqual(summaries, []);
});
