<?php
declare(strict_types=1);

/*
 * MyCrypt storage backend.
 *
 * The service refuses to do anything until it has been configured with at
 * least one user (see config.example.php).  All requests require HTTP Basic
 * authentication plus a session-bound CSRF token.
 */

// Never let PHP warnings/notices (for example from config.php) reach the
// client or be sent before our headers. Everything is emitted through
// respond(), which discards any buffered output first.
ini_set('display_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);
ob_start();

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('X-Frame-Options: DENY');

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

function respond(int $status, array $payload): void
{
    // Drop anything buffered so far (stray warnings, BOMs, etc).
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    http_response_code($status);
    echo json_encode($payload);
    exit;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

$config = [];
$configFile = __DIR__ . DIRECTORY_SEPARATOR . 'config.php';
if (is_file($configFile)) {
    try {
        $loaded = require $configFile;
    } catch (Throwable $e) {
        error_log('MyCrypt: config.php failed to load: ' . $e->getMessage());
        respond(500, ['error' => 'The server configuration is invalid.']);
    }
    if (is_array($loaded)) {
        $config = $loaded;
    } else {
        respond(500, ['error' => 'The server configuration is invalid.']);
    }
}

$users = isset($config['users']) && is_array($config['users']) ? $config['users'] : [];
if ($users === []) {
    // Optional environment based configuration:
    //   MYCRYPT_USER=alice MYCRYPT_PASSWORD_HASH='$2y$10$...'
    $envUser = getenv('MYCRYPT_USER');
    $envHash = getenv('MYCRYPT_PASSWORD_HASH');
    if (is_string($envUser) && $envUser !== '' && is_string($envHash) && $envHash !== '') {
        $users[$envUser] = $envHash;
    }
}

$dataDir = isset($config['data_dir']) && is_string($config['data_dir']) && $config['data_dir'] !== ''
    ? $config['data_dir']
    : __DIR__ . DIRECTORY_SEPARATOR . 'psafe';
$requireHttps = array_key_exists('require_https', $config) ? (bool) $config['require_https'] : true;
$trustProxy = array_key_exists('trust_proxy', $config) ? (bool) $config['trust_proxy'] : false;

// ---------------------------------------------------------------------------
// Transport security
// ---------------------------------------------------------------------------

$remoteAddr = isset($_SERVER['REMOTE_ADDR']) && is_string($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '';
$isLoopback = in_array($remoteAddr, ['127.0.0.1', '::1'], true);
$isHttps = (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off')
    || ($trustProxy && isset($_SERVER['HTTP_X_FORWARDED_PROTO'])
        && strtolower((string) $_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https')
    || $isLoopback;

if ($requireHttps && !$isHttps) {
    respond(403, ['error' => 'HTTPS is required. Configure TLS or set require_https to false in config.php.']);
}
if ($isHttps) {
    header('Strict-Transport-Security: max-age=31536000');
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    respond(405, ['error' => 'Invalid request method']);
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

if ($users === []) {
    respond(503, [
        'error' => 'MyCrypt is not configured. Create config.php with at least one user '
            . '(copy config.example.php and generate a password hash).'
    ]);
}

$authUser = isset($_SERVER['PHP_AUTH_USER']) ? (string) $_SERVER['PHP_AUTH_USER'] : '';
$authPass = isset($_SERVER['PHP_AUTH_PW']) ? (string) $_SERVER['PHP_AUTH_PW'] : '';

// Some CGI/FastCGI setups do not populate PHP_AUTH_USER/PW. Fall back to the
// raw Authorization header so Basic auth also works there.
if ($authUser === '' || $authPass === '') {
    $authHeader = '';
    foreach (['HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION'] as $key) {
        if (isset($_SERVER[$key]) && is_string($_SERVER[$key]) && $_SERVER[$key] !== '') {
            $authHeader = $_SERVER[$key];
            break;
        }
    }
    if (stripos($authHeader, 'basic ') === 0) {
        $decoded = base64_decode(substr($authHeader, 6), true);
        if ($decoded !== false && strpos($decoded, ':') !== false) {
            [$headerUser, $headerPass] = explode(':', $decoded, 2);
            $authUser = $headerUser;
            $authPass = $headerPass;
        }
    }
}

$storedHash = ($authUser !== '' && isset($users[$authUser]) && is_string($users[$authUser]))
    ? $users[$authUser]
    : null;
// Always run password_verify(), even for an unknown user, so response timing
// does not reveal which user names exist. This is a valid bcrypt hash of a
// random string that is never used for authentication.
$dummyHash = '$2y$10$acnYgjIMwj0bqgNBnKoaCO9gCM.1TNLt1ArQiYRQLTz8qkVUQB8gW';
if ($storedHash !== null) {
    $verified = password_verify($authPass, $storedHash);
} else {
    password_verify($authPass, $dummyHash);
    $verified = false;
}

if (!$verified) {
    header('WWW-Authenticate: Basic realm="MyCrypt", charset="UTF-8"');
    respond(401, ['error' => 'Authentication required']);
}

// ---------------------------------------------------------------------------
// Session + CSRF token
// ---------------------------------------------------------------------------

session_name('MYCRYPTSESSID');
session_set_cookie_params([
    'lifetime' => 0,
    'path' => '/',
    'secure' => $isHttps,
    'httponly' => true,
    'samesite' => 'Strict',
]);
if (!@session_start()) {
    respond(500, ['error' => 'Unable to start a PHP session']);
}
// Bind a fresh session ID to the first authenticated request (Basic auth is
// re-checked on every request, but this also resists session fixation).
if (empty($_SESSION['authed'])) {
    if (!@session_regenerate_id(true)) {
        respond(500, ['error' => 'Unable to start a PHP session']);
    }
    $_SESSION['authed'] = true;
}
if (empty($_SESSION['csrf']) || !is_string($_SESSION['csrf'])) {
    $_SESSION['csrf'] = bin2hex(random_bytes(32));
}
$csrfToken = $_SESSION['csrf'];

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

if (!is_dir($dataDir) && !@mkdir($dataDir, 0700, true) && !is_dir($dataDir)) {
    respond(500, ['error' => 'Data directory is not available']);
}
$realDataDir = realpath($dataDir);
if ($realDataDir === false || !is_dir($realDataDir)) {
    respond(500, ['error' => 'Data directory is not available']);
}
$realDataDir = rtrim($realDataDir, DIRECTORY_SEPARATOR);

// Best-effort protection when the data directory lives under the web root
// (Apache only -- see the README for nginx/IIS).
$htaccess = $realDataDir . DIRECTORY_SEPARATOR . '.htaccess';
if (!file_exists($htaccess) && is_writable($realDataDir)) {
    @file_put_contents($htaccess, "<IfModule mod_authz_core.c>\n    Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n</IfModule>\n");
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

$rawBody = file_get_contents('php://input');
if ($rawBody === false || $rawBody === '') {
    respond(400, ['error' => 'Missing request body']);
}
if (strlen($rawBody) > MAX_UPLOAD_BYTES * 2) {
    respond(413, ['error' => 'Request body is too large']);
}

$json = json_decode($rawBody, true);
if (!is_array($json)) {
    respond(400, ['error' => 'Invalid JSON']);
}

$req = isset($json['req']) ? $json['req'] : null;
if (!is_string($req) || $req === '') {
    respond(400, ['error' => 'Missing data']);
}

if ($req !== 'csrf') {
    $sentToken = isset($_SERVER['HTTP_X_CSRF_TOKEN']) ? (string) $_SERVER['HTTP_X_CSRF_TOKEN'] : '';
    if ($sentToken === '' || !hash_equals($csrfToken, $sentToken)) {
        respond(403, ['error' => 'Invalid or missing CSRF token']);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * File names are the basename without the .psafe3 extension. Keep them to a
 * conservative character set so they can never escape the data directory or
 * inject anything into the UI.
 */
function valid_filename($name): bool
{
    return is_string($name)
        && preg_match('/\A[A-Za-z0-9][A-Za-z0-9 _-]{0,63}\z/', $name) === 1;
}

function db_path(string $dir, string $name): ?string
{
    $path = $dir . DIRECTORY_SEPARATOR . $name . '.psafe3';
    // Never follow a symlink planted inside the data directory.
    if (is_link($path)) {
        return null;
    }
    if (file_exists($path)) {
        $real = realpath($path);
        $prefix = $dir . DIRECTORY_SEPARATOR;
        if ($real === false || strncmp($real, $prefix, strlen($prefix)) !== 0) {
            return null;
        }
    }
    return $path;
}

function list_databases(string $dir): array
{
    $names = [];
    $entries = @scandir($dir);
    if ($entries === false) {
        return $names;
    }
    foreach ($entries as $entry) {
        if (preg_match('/\A[A-Za-z0-9][A-Za-z0-9 _-]{0,63}\.psafe3\z/', $entry) === 1) {
            $names[] = $entry;
        }
    }
    sort($names, SORT_STRING);
    return $names;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

switch ($req) {
    case 'csrf':
        respond(200, ['csrf' => $csrfToken]);
        break;

    case 'pwfiles':
        respond(200, ['pwfiles' => list_databases($realDataDir)]);
        break;

    case 'get_file_b64content':
        $name = isset($json['filename']) ? $json['filename'] : null;
        if (!valid_filename($name)) {
            respond(400, ['error' => 'Invalid file name']);
        }
        $path = db_path($realDataDir, $name);
        if ($path === null) {
            respond(400, ['error' => 'Invalid file name']);
        }
        if (!is_file($path)) {
            respond(404, ['error' => 'File not found']);
        }
        $size = filesize($path);
        if ($size === false || $size > MAX_UPLOAD_BYTES) {
            respond(413, ['error' => 'File is too large']);
        }
        $content = file_get_contents($path);
        if ($content === false) {
            respond(500, ['error' => 'Unable to read file']);
        }
        respond(200, ['file_b64_content' => base64_encode($content)]);
        break;

    case 'set_file_b64content':
        $name = isset($json['filename']) ? $json['filename'] : null;
        if (!valid_filename($name)) {
            respond(400, ['error' => 'Invalid file name']);
        }
        $encoded = isset($json['data']) ? $json['data'] : null;
        if (!is_string($encoded) || $encoded === '') {
            respond(400, ['error' => 'Missing data']);
        }
        if (strlen($encoded) > MAX_UPLOAD_BYTES * 2) {
            respond(413, ['error' => 'Upload is too large']);
        }
        $binary = base64_decode($encoded, true);
        if ($binary === false || $binary === '') {
            respond(400, ['error' => 'Invalid base64 data']);
        }
        if (strlen($binary) > MAX_UPLOAD_BYTES) {
            respond(413, ['error' => 'Upload is too large']);
        }
        if (substr($binary, 0, 4) !== 'PWS3') {
            respond(400, ['error' => 'Uploaded data is not a Password Safe v3 file']);
        }

        $path = db_path($realDataDir, $name);
        if ($path === null) {
            respond(400, ['error' => 'Invalid file name']);
        }
        $tmp = @tempnam($realDataDir, '.upload-');
        if ($tmp === false) {
            respond(500, ['error' => 'Unable to write file']);
        }
        $written = @file_put_contents($tmp, $binary, LOCK_EX);
        if ($written !== strlen($binary)) {
            @unlink($tmp);
            respond(500, ['error' => 'Unable to write file']);
        }
        @chmod($tmp, 0600);
        if (!@rename($tmp, $path)) {
            @unlink($tmp);
            respond(500, ['error' => 'Unable to store file']);
        }
        respond(200, ['status' => 'ok']);
        break;

    default:
        respond(400, ['error' => 'Unknown command']);
        break;
}
