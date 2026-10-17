import assert from 'node:assert/strict';
import test from 'node:test';
import {classifyStreamFailure, classifyCliFailure, cliOperationError, safeCliCauseFields, safeStartupFailureFields, hasExplicitCliAuthFailure} from '../src/stream-errors.mjs';

test('account-check wording and metadata mismatch are not evidence of auth expiry', () => {
  assert.equal(classifyStreamFailure(new Error('Official CLI cannot check login')), 'ROUTE_UNAVAILABLE');
  assert.equal(classifyStreamFailure(new Error('The logged-in account could not match a private endpoint')), 'ROUTE_UNAVAILABLE');
  for(const code of ['NETWORK_UNAVAILABLE', 'CANCELLED', 'CLI_FAILED']) assert.equal(classifyStreamFailure({code, message:'cannot check login'}), code);
});
test('official CLI Login required is auth failure even when user show has cached account metadata', () => {
  assert.equal(classifyStreamFailure({code: 3, message: 'Command failed: official-cli list --labels test\nLogin required.\r\n'}), 'AUTH_REQUIRED');
  assert.equal(classifyStreamFailure(new Error('Not logged in.')), 'AUTH_REQUIRED');
});
test('missing executable, mapping stall and missing bridge retain distinct fixed codes', () => {
  assert.equal(classifyStreamFailure({code: 'CLI_UNAVAILABLE', message: 'cannot check login'}), 'CLI_UNAVAILABLE');
  assert.equal(classifyStreamFailure(new Error('VS Code port mapping did not finish before its deadline')), 'MAPPING_UNAVAILABLE');
  assert.equal(classifyStreamFailure(new Error('No active bridge matches target')), 'BRIDGE_UNAVAILABLE');
  assert.equal(classifyStreamFailure(new Error('socket unavailable')), 'ROUTE_UNAVAILABLE');
});

const privateText = 'PRIVATE_OUTPUT https://private.invalid/capability token=PRIVATE_TOKEN account=PRIVATE_ACCOUNT';
for (const [label, cause, classification, diagnostics] of [
  ['nonzero exit', {code: 1}, 'CLI_FAILED', {cause_kind: 'PROCESS_EXIT', exit_code: 1}],
  ['unknown spawn', {code: 'UNKNOWN', syscall: 'spawn ' + privateText}, 'CLI_FAILED', {cause_kind: 'UNKNOWN_SPAWN_ERROR', node_error_code: 'UNKNOWN'}],
  ['TypeError', {name: 'TypeError'}, 'CLI_FAILED', {cause_kind: 'INVALID_ARGUMENT'}],
  ['RangeError', {name: 'RangeError', code: 'ERR_OUT_OF_RANGE'}, 'CLI_FAILED', {cause_kind: 'INVALID_ARGUMENT', node_error_code: 'ERR_OUT_OF_RANGE'}],
  ['invalid argument', {code: 'ERR_INVALID_ARG_TYPE'}, 'CLI_FAILED', {cause_kind: 'INVALID_ARGUMENT', node_error_code: 'ERR_INVALID_ARG_TYPE'}],
  ['killed by maxBuffer', {code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM'}, 'CLI_FAILED', {cause_kind: 'STDIO_BUFFER_LIMIT', node_error_code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}],
  ['timeout', {code: 'ETIMEDOUT', killed: true}, 'NETWORK_UNAVAILABLE', {cause_kind: 'CHECK_TIMEOUT', node_error_code: 'ETIMEDOUT'}],
  ['killed process', {code: null, killed: true, signal: 'SIGTERM'}, 'NETWORK_UNAVAILABLE', {cause_kind: 'PROCESS_KILLED'}],
  ['signal exit', {code: null, signal: 'SIGKILL'}, 'CLI_FAILED', {cause_kind: 'SIGNAL_EXIT'}],
  ['cancellation', {code: 'ABORT_ERR', name: 'AbortError', killed: true}, 'CANCELLED', {cause_kind: 'CANCELLED', node_error_code: 'ABORT_ERR'}],
  ['executable missing', {code: 'ENOENT'}, 'CLI_UNAVAILABLE', {cause_kind: 'OS_IO_ERROR', node_error_code: 'ENOENT'}],
  ['DNS failure', {code: 'ENOTFOUND'}, 'NETWORK_UNAVAILABLE', {cause_kind: 'OS_IO_ERROR', node_error_code: 'ENOTFOUND'}],
  ['explicit auth exit', {code: 3, stderr: 'Login required. ' + privateText}, 'AUTH_REQUIRED', {cause_kind: 'PROCESS_EXIT', exit_code: 3}],
  ['explicit auth signal', {stderr: 'Login required. ' + privateText}, 'AUTH_REQUIRED', {cause_kind: 'AUTH_SIGNAL'}],
  ['unknown exception', {name: privateText, code: privateText, argv: [privateText], body: privateText}, 'CLI_FAILED', {cause_kind: 'UNKNOWN_ERROR'}],
]) {
  test(`CLI ${label} retains only its fixed cause diagnostics`, () => {
    const source = {...cause, message: privateText, stdout: privateText, ...(!cause.stderr ? {stderr: privateText} : {})};
    assert.equal(classifyCliFailure(source), classification);
    const wrapped = cliOperationError(source, 'CHECK');
    assert.equal(wrapped.code, classification);
    assert.equal(wrapped.detail, `CLI_CHECK_${classification}`);
    assert.deepEqual(safeCliCauseFields(wrapped), diagnostics);
    assert.deepEqual(Object.keys(wrapped).sort(), ['code', 'detail', ...Object.keys(diagnostics)].sort());
    const logged = JSON.stringify({detail: wrapped.detail, error_code: wrapped.code, ...safeCliCauseFields(wrapped)});
    assert.equal(logged.includes('PRIVATE_'), false);
    assert.equal(logged.includes('private.invalid'), false);
    assert.equal(wrapped.cause, undefined);
    assert.equal(wrapped.message, 'Official CLI operation failed');
  });
}

test('log boundary drops forged diagnostics and non-numeric exit codes', () => {
  assert.deepEqual(safeCliCauseFields({cause_kind: privateText, node_error_code: privateText,
    exit_code: privateText, message: privateText, stdout: privateText, account: privateText}), {});
  for (const exit_code of [NaN, Infinity, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(safeCliCauseFields({cause_kind: 'PROCESS_EXIT', exit_code}), {cause_kind: 'PROCESS_EXIT'});
  }
  assert.equal(cliOperationError({code: 1}, privateText).detail, 'CLI_UNKNOWN_CLI_FAILED');
});

test('headless console and handle failures expose only fixed CLI hints', () => {
  const stderr = `Cannot use CONSOLE: the handle is invalid. ${privateText}`;
  const wrapped = cliOperationError({code: 1, stderr}, 'CHECK');
  assert.equal(wrapped.code, 'CLI_FAILED');
  assert.deepEqual(safeCliCauseFields(wrapped), {
    cause_kind: 'PROCESS_EXIT', cli_hints: ['console', 'handle'], exit_code: 1,
  });
  assert.equal(wrapped.stderr, undefined);
  assert.equal(wrapped.stdout, undefined);
  assert.equal(wrapped.cause, undefined);
  assert.equal(wrapped.message, 'Official CLI operation failed');
  const logged = JSON.stringify({detail: wrapped.detail, ...safeCliCauseFields(wrapped)});
  for (const secret of ['PRIVATE_', 'private.invalid', 'token=', 'account=', 'Cannot use CONSOLE']) {
    assert.equal(logged.includes(secret), false);
  }
});

test('credential failures retain a category without raw credential or token text', () => {
  const stderr = `Credential vault failed: password=PRIVATE_PASSWORD bearer=PRIVATE_BEARER ${privateText}`;
  const wrapped = cliOperationError({code: 1, stderr}, 'METADATA');
  assert.equal(wrapped.code, 'CLI_FAILED');
  assert.deepEqual(safeCliCauseFields(wrapped), {
    cause_kind: 'PROCESS_EXIT', cli_hints: ['credential'], exit_code: 1,
  });
  const logged = JSON.stringify(wrapped);
  for (const secret of ['PRIVATE_', 'private.invalid', 'password=', 'bearer=', 'token=', 'account=', 'Credential vault failed']) {
    assert.equal(logged.includes(secret), false);
  }
});

test('CLI hint categories are deduplicated while unknown stderr has no hints', () => {
  const wrapped = cliOperationError({code: 1, stderr: 'console console terminal handle handle'}, 'CHECK');
  assert.deepEqual(wrapped.cli_hints, ['console', 'handle']);
  const unknown = cliOperationError({code: 1, stderr: privateText}, 'CHECK');
  assert.equal(Object.hasOwn(unknown, 'cli_hints'), false);
  assert.deepEqual(safeCliCauseFields(unknown), {cause_kind: 'PROCESS_EXIT', exit_code: 1});
});

test('log boundary accepts only exact fixed hint strings and removes duplicates', () => {
  const cli_hints = ['console', privateText, 'handle', 'console', 'credential', 'token',
    'CONSOLE', ' console', 'handle ', '', null, undefined, false, 1,
    new String('console'), ['console'], {hint: 'console'}, 'credential'];
  assert.deepEqual(safeCliCauseFields({cause_kind: 'PROCESS_EXIT', exit_code: 1, cli_hints,
    stderr: privateText, stdout: privateText, credentials: privateText, token: privateText}), {
    cause_kind: 'PROCESS_EXIT', cli_hints: ['console', 'handle', 'credential'], exit_code: 1,
  });
});

test('log boundary rejects non-array and wholly forged CLI hints', () => {
  for (const cli_hints of [undefined, null, 'console', privateText, 1, true,
    {0: 'console', length: 1}, new Set(['console']), ['token', privateText, 'Console']]) {
    assert.deepEqual(safeCliCauseFields({cli_hints}), {});
  }
});

test('log boundary supports the complete fixed CLI hint vocabulary', () => {
  const cli_hints = ['console', 'handle', 'credential', 'storage', 'permission', 'configuration',
    'argument', 'network', 'tls', 'proxy', 'stdio', 'exception'];
  assert.deepEqual(safeCliCauseFields({cli_hints: [...cli_hints, ...cli_hints]}), {cli_hints});
});

test('explicit authentication remains visible to retry guards even with a killed process', () => {
  assert.equal(hasExplicitCliAuthFailure({killed: true, stderr: 'HTTP 403 ' + privateText}), true);
  assert.equal(hasExplicitCliAuthFailure({code: 'AUTH_REQUIRED'}), true);
  assert.equal(hasExplicitCliAuthFailure({code: 1, stderr: privateText}), false);
  assert.equal(hasExplicitCliAuthFailure({message: 'Cannot check login'}), false);
});

test('startup diagnostics survive IPC with a fixed stage but no private body', () => {
  const value = {detail: 'CLI_CHECK_CLI_FAILED', cause_kind: 'PROCESS_EXIT', exit_code: 1,
    cli_hints: ['console', privateText, 'console'], message: privateText, stderr: privateText,
    endpoint: {token: privateText}, token: privateText};
  assert.deepEqual(safeStartupFailureFields(value), {
    detail: 'CLI_CHECK_CLI_FAILED', cause_kind: 'PROCESS_EXIT', cli_hints: ['console'], exit_code: 1,
  });
  assert.equal(JSON.stringify(safeStartupFailureFields(value)).includes('PRIVATE_'), false);
});

test('startup diagnostic stage is allowlisted independently of cause enums', () => {
  for (const detail of [privateText, 'CLI_UNKNOWN_CLI_FAILED', 'CLI_CHECK_FAKE',
    'CLI_CHECK_CLI_FAILED\n' + privateText, ['CLI_CHECK_CLI_FAILED'], null]) {
    assert.deepEqual(safeStartupFailureFields({detail, cause_kind: 'PROCESS_EXIT', exit_code: 1}),
      {cause_kind: 'PROCESS_EXIT', exit_code: 1});
  }
  for (const detail of ['CLI_METADATA_NETWORK_UNAVAILABLE', 'CLI_CHECK_AUTH_REQUIRED', 'REMOTE_COMMAND_TIMEOUT']) {
    assert.deepEqual(safeStartupFailureFields({detail}), {detail});
  }
});

test('typed endpoint setup failure retains only its canonical human action', () => {
  assert.deepEqual(safeStartupFailureFields({detail: 'MAPPING_TIMEOUT', next_action: privateText,
    message: privateText, endpoint: privateText, token: privateText}),
    {detail: 'MAPPING_TIMEOUT', next_action: 'reload_selected_workspace'});
  assert.deepEqual(safeStartupFailureFields({detail: privateText, next_action: 'reload_selected_workspace'}), {});
});
