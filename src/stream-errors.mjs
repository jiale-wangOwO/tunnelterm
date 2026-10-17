// Transport/auth/provider failures are distinct from the SSH user's key login.
// Classifiers return fixed codes only, never remote text, URIs or capabilities.
import {publicStreamEndpointFailure} from './bridge-health.cjs';
export const STREAM_FAILURE_CODES = ['CLI_UNAVAILABLE', 'CLI_FAILED', 'NETWORK_UNAVAILABLE', 'CANCELLED', 'AUTH_REQUIRED', 'MAPPING_UNAVAILABLE', 'BRIDGE_UNAVAILABLE', 'ROUTE_UNAVAILABLE'];
const explicitAuth = text => /\blogin required\b|\bnot logged in\b|\bauthentication failed\b|\bunauthori[sz]ed\b|please (?:log|sign)[ -]?in|\bHTTP(?:\/\S+)?\s+(?:401|403)\b/i.test(text);
// Retry eligibility must not hide an explicit authentication denial behind a
// killed/timeout classification. This returns a boolean, never raw CLI output.
export function hasExplicitCliAuthFailure(error) {
  return error?.code === 'AUTH_REQUIRED' || explicitAuth(String(error?.stderr || '') + '\n' + String(error?.stdout || '') + '\n' + String(error?.message || ''));
}
const networkErrors = ['ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'];
const argumentErrors = ['ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_OUT_OF_RANGE'];
const unavailableErrors = ['ENOENT', 'EACCES', 'ENOEXEC'];
const nodeErrorCodes = new Set([...networkErrors, ...argumentErrors, ...unavailableErrors, 'ABORT_ERR',
  'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'UNKNOWN', 'EINVAL', 'EPERM', 'EIO', 'EBADF', 'ENOTDIR',
  'ENOMEM', 'ENOSPC', 'EBUSY', 'EMFILE', 'ENFILE']);
const causeKinds = new Set(['CANCELLED', 'INVALID_ARGUMENT', 'STDIO_BUFFER_LIMIT', 'CHECK_TIMEOUT',
  'PROCESS_KILLED', 'SIGNAL_EXIT', 'PROCESS_EXIT', 'OS_IO_ERROR', 'UNKNOWN_SPAWN_ERROR', 'AUTH_SIGNAL', 'UNKNOWN_ERROR']);
const processSignals = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV', 'SIGBREAK']);
// Fixed hints keep headless CLI failures diagnosable without retaining raw
// stderr, account details, private endpoint URLs or credential values.
const cliHintPatterns = new Map([
  ['console', /\bconsole\b|\bterminal\b/i], ['handle', /\bhandle\b/i],
  ['credential', /\bcredential|\bkeyring\b|\bkeychain\b|\bvault\b/i],
  ['storage', /\bstorage\b|\bstore\b|\bdirectory\b|\bfile\b/i],
  ['permission', /\bpermission\b|\baccess denied\b|\bnot permitted\b/i],
  ['configuration', /\bconfiguration\b|\bconfig\b/i], ['argument', /\bargument\b|\busage\b/i],
  ['network', /\bnetwork\b|\bconnection\b|\bdns\b|\btimeout\b/i],
  ['tls', /\btls\b|\bssl\b|\bcertificate\b/i], ['proxy', /\bproxy\b/i],
  ['stdio', /\bstdin\b|\bstdout\b|\bstderr\b/i], ['exception', /\bexception\b|\bpanic\b/i],
]);
function safeCliHints(value) {
  return Array.isArray(value) ? [...new Set(value.filter(hint => typeof hint === 'string' && cliHintPatterns.has(hint)))] : [];
}
const hasNumericExit = value => Number.isSafeInteger(value);
const isArgumentError = error => argumentErrors.includes(error?.code) || error?.name === 'TypeError' || error?.name === 'RangeError';

function cliCauseFields(cause) {
  let kind;
  if (cause?.code === 'ABORT_ERR' || cause?.name === 'AbortError') kind = 'CANCELLED';
  else if (cause?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') kind = 'STDIO_BUFFER_LIMIT';
  else if (isArgumentError(cause)) kind = 'INVALID_ARGUMENT';
  else if (cause?.code === 'ETIMEDOUT') kind = 'CHECK_TIMEOUT';
  else if (cause?.killed === true) kind = 'PROCESS_KILLED';
  else if (processSignals.has(cause?.signal)) kind = 'SIGNAL_EXIT';
  else if (hasNumericExit(cause?.code)) kind = 'PROCESS_EXIT';
  else if (cause?.code === 'UNKNOWN') kind = 'UNKNOWN_SPAWN_ERROR';
  else if (nodeErrorCodes.has(cause?.code)) kind = 'OS_IO_ERROR';
  else if (/^spawn(?:\s|$)/.test(String(cause?.syscall || ''))) kind = 'UNKNOWN_SPAWN_ERROR';
  else if (explicitAuth(String(cause?.stderr || '') + String(cause?.stdout || '') + String(cause?.message || ''))) kind = 'AUTH_SIGNAL';
  else kind = 'UNKNOWN_ERROR';
  const text = String(cause?.stderr || '') + '\n' + String(cause?.stdout || '');
  const hints = [...cliHintPatterns].filter(([, pattern]) => pattern.test(text)).map(([hint]) => hint);
  return {cause_kind: kind, ...(hints.length ? {cli_hints: hints} : {}), ...(nodeErrorCodes.has(cause?.code) ? {node_error_code: cause.code} : {}),
    ...(hasNumericExit(cause?.code) ? {exit_code: cause.code} : {})};
}

// Defense in depth at the log boundary: fields from a wrapped or injected
// error are independently validated; arbitrary code/name/body is never logged.
export function safeCliCauseFields(error) {
  const hints = safeCliHints(error?.cli_hints);
  return {...(causeKinds.has(error?.cause_kind) ? {cause_kind: error.cause_kind} : {}),
    ...(hints.length ? {cli_hints: hints} : {}),
    ...(nodeErrorCodes.has(error?.node_error_code) ? {node_error_code: error.node_error_code} : {}),
    ...(hasNumericExit(error?.exit_code) ? {exit_code: error.exit_code} : {})};
}

const startupDetails = new Set(['CLI_LOGIN_REQUIRED', 'RESOURCE_LOOKUP_MISMATCH', 'LOCAL_CAPABILITY_STALE',
  'CLI_MAPPING_WAIT_TIMEOUT', 'REMOTE_COMMAND_TIMEOUT', 'INVALID_BROKER_DESCRIPTOR', 'COMPANION_UNAVAILABLE',
  'NATIVE_MAPPING_TIMEOUT', 'AUTH_OR_CLI', 'OTHER_STARTUP_FAILURE']);
// Apply the same narrow boundary at the child IPC and public status layers.
// Passing a worker error through does not permit arbitrary detail or text.
export function safeStartupFailureFields(error) {
  const detail = error?.detail;
  const endpoint = publicStreamEndpointFailure({code: detail});
  const valid = typeof detail === 'string' && (startupDetails.has(detail)
    || /^CLI_(CHECK|METADATA)_(CLI_UNAVAILABLE|CLI_FAILED|NETWORK_UNAVAILABLE|CANCELLED|AUTH_REQUIRED)$/.test(detail)
    || endpoint.code === detail);
  return {...(valid ? {detail} : {}), ...(endpoint.next_action ? {next_action: endpoint.next_action} : {}), ...safeCliCauseFields(error)};
}

export function classifyCliFailure(error) {
  if (STREAM_FAILURE_CODES.includes(error?.code)) return error.code;
  if (error?.code === 'ABORT_ERR' || error?.name === 'AbortError') return 'CANCELLED';
  if (unavailableErrors.includes(error?.code)) return 'CLI_UNAVAILABLE';
  // maxBuffer also kills the child. Neither it nor invalid JS arguments are
  // evidence of a network outage, even if unrelated text mentions login.
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || isArgumentError(error)) return 'CLI_FAILED';
  if (error?.killed === true || networkErrors.includes(error?.code)) return 'NETWORK_UNAVAILABLE';
  if (explicitAuth(String(error?.stderr || '') + String(error?.stdout || '') + String(error?.message || ''))) return 'AUTH_REQUIRED';
  return 'CLI_FAILED';
}

export function cliOperationError(cause, operation) {
  const code = classifyCliFailure(cause);
  const error = new Error('Official CLI operation failed');
  error.code = code;
  error.detail = `CLI_${['CHECK', 'METADATA'].includes(operation) ? operation : 'UNKNOWN'}_${code}`;
  return Object.assign(error, cliCauseFields(cause));
}

export function classifyStreamFailure(error) {
  const message = String(error?.message || '');
  if (STREAM_FAILURE_CODES.includes(error?.code)) return error.code;
  if (explicitAuth(message)) return 'AUTH_REQUIRED';
  if (/port mapping|native endpoint/i.test(message)) return 'MAPPING_UNAVAILABLE';
  if (/active.*bridge|No active/i.test(message)) return 'BRIDGE_UNAVAILABLE';
  return 'ROUTE_UNAVAILABLE';
}
