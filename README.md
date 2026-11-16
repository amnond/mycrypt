# mycrypt

![mycrypt screenshot](https://storage.googleapis.com/fixpix/demoimgs/mycrypt.jpg)

A Web password manager for Password Safe v3 files, built on Joey Hewitt's excellent [libpwsafejs](https://github.com/scintill/libpwsafejs) library
(which was only slightly modified to enable progress indication whenever loading or saving .psafe3 password files).

This project also makes use of a modified version of [aimaraJS](https://github.com/rafaelthca/aimaraJS) - Rafael Thofehrn Castro's implementation of a
pure JavaScript TreeView component.

### Supports
* Load existing password safe 3 files from Web
* Save updated files to the Web
* Displays accounts in TreeView
* Create, delete or modify accounts
* Keyboard navigation supported
* Search accounts for certain text
* Set master password
* Manual lock button plus automatic lock after 10 minutes of inactivity

## How it works

The browser does all encryption/decryption locally (`index.html` + `app.js` and the
`libpwsafejs/` library). `manager.php` is a small storage backend: it lists, reads and
writes `.psafe3` files. It never sees the master password and never decrypts anything.

```
index.html, app.js, *.svg, treeview.*   static front end
manager.php                             authenticated storage API (POST + JSON)
config.php                              local secrets (NOT committed)
psafe/                                  default data directory (NOT committed)
```

## Setup

### 1. Requirements

* A web server with PHP 8.0+ (Apache, nginx + PHP-FPM, IIS, ...)
* HTTPS in production. Browser password managers and HTTP Basic authentication
  must not be used over plain HTTP.
* PHP must accept request bodies of about 20 MB (the base64 encoding of the
  15 MB file limit). Raise `post_max_size` and `memory_limit` accordingly,
  e.g. `post_max_size = 25M` and `memory_limit = 128M`.

### 2. Create `config.php`

Copy `config.example.php` to `config.php` and add at least one user. Without a
configured user `manager.php` refuses to serve anything (HTTP 503).

Generate a password hash:

```sh
php -r "echo password_hash('your-strong-password', PASSWORD_DEFAULT), PHP_EOL;"
```

Then:

```php
<?php
return [
    'users' => [
        'alice' => '$2y$10$...hash-from-the-command-above...',
    ],
    // Ideally outside the web root, e.g. /var/lib/mycrypt
    'data_dir' => __DIR__ . DIRECTORY_SEPARATOR . 'psafe',
    'require_https' => true,
    // Only enable behind a reverse proxy that sets X-Forwarded-Proto.
    'trust_proxy' => false,
];
```

`config.php` is listed in `.gitignore`. Keep it that way.

The same settings can also be supplied through environment variables
`MYCRYPT_USER` and `MYCRYPT_PASSWORD_HASH` (used only when `config.php` has no
users).

### 3. Data directory

By default files live in `psafe/`, which is created automatically with mode 0700.
If it is inside the web root, direct HTTP access to it must be denied. The script
writes an Apache `.htaccess` as a best effort; other servers need explicit rules.

For example, with nginx:

```nginx
location ^~ /psafe/ {
    deny all;
    return 404;
}
```

With IIS, add a `requestFiltering`/`hiddenSegments` rule or place the directory
outside the site root. **The safest option is to point `data_dir` outside the
web root entirely.**

### 4. HTTPS and response headers

`manager.php` sends `Strict-Transport-Security`, `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and
`Cache-Control: no-store`.

Static files (`index.html`, `app.js`, ...) need equivalent headers from the web
server. Example for nginx:

```nginx
add_header Strict-Transport-Security "max-age=31536000" always;
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
```

Apache `.htaccess` example:

```apache
Header always set Strict-Transport-Security "max-age=31536000"
Header always set X-Frame-Options "DENY"
Header always set X-Content-Type-Options "nosniff"
Header always set Referrer-Policy "no-referrer"
```

`index.html` also carries a strict `Content-Security-Policy` meta tag
(`script-src 'self'`, no inline scripts or inline event handlers). If you modify
the front end, keep it that way.

### 5. Migrating existing files

Existing `.psafe3` files must be moved into `data_dir`. File names are restricted
to letters, digits, spaces, `_` and `-` (no dots, no slashes), 1-64 characters
long; the `.psafe3` extension is added by the server. Rename files accordingly,
for example:

```sh
mv "my passwords.psafe3" psafe/"my passwords.psafe3"   # already valid
mv "work.2024.psafe3"    psafe/"work-2024.psafe3"      # dots are not allowed
```

Access is then granted through the password manager UI only.

## Security notes

The original version of this project stored database files in the web root and
served them without authentication, generated encryption keys/salts/IVs with
`Math.random()`, and inserted database fields into the page as raw HTML. Those
issues have been fixed:

* **Randomness**: all salts, IVs and record UUIDs now come from the platform
  CSPRNG (`crypto.getRandomValues`); the code throws if no CSPRNG is available.
* **Authentication**: `manager.php` requires HTTP Basic authentication against
  `password_hash()` values, plus a session cookie and a session-bound CSRF
  token (`X-CSRF-Token`) for every state-changing request. It fails closed (503)
  when no user is configured.
* **Transport**: HTTPS is required by default (loopback is exempt for local
  testing). `X-Forwarded-Proto` is only honoured when `trust_proxy` is enabled.
* **File handling**: strict file-name allowlist, containment in `data_dir`,
  size limits (15 MB), base64 validation, `PWS3` magic-byte check, and atomic
  writes. Unauthenticated listing/download of `.psafe3` files is no longer
  possible through the API.
* **XSS**: every value read from a `.psafe3` file is HTML-escaped before it is
  inserted into the page; file lists and the password prompt are built with DOM
  APIs; inline event handlers were removed so a strict CSP can apply.
* **KDF**: new/updated files are written with 300,000 SHA-256 iterations
  (recorded in the file header, so other Password Safe v3 tools remain
  compatible). Files claiming more than 5,000,000 iterations are rejected.
* **Session hardening**: lock button, 10-minute inactivity auto-lock, lock when
  restored from the back/forward cache, clipboard auto-clear after 30 seconds,
  and refusal to save with an empty master password.
* **No secret logging**: decrypted records, derived keys and password material
  are no longer written to the browser console.

### Remaining limitations

* The bundled `libpwsafejs` still uses the legacy Crypto-JS/TwoFish
  implementation. It has been reviewed for the issues above but has not been
  independently audited. For high-value secrets, consider migrating to a
  maintained, audited library (and to a memory-hard KDF such as Argon2id, which
  would require a format change and is therefore not done here).
* Password Safe v3 uses a single SHA-256-based KDF. 300,000 iterations is a
  pragmatic increase for browser use; it does not make weak master passwords
  strong. Use a long, unique master password.
* `manager.php` protects the files on the server, but anyone who obtains a copy
  of a `.psafe3` file still needs the master password. Files that were publicly
  exposed before this change should be considered compromised: change the
  affected passwords and re-save the database with a new master password.
* Brute-force protection for the Basic auth login is left to the web server or
  reverse proxy (for example `fail2ban`, rate limiting, or an IP allowlist).
  Basic auth itself is only as strong as the chosen password and TLS setup.
* Browser extensions, a compromised browser, or malware on the client can read
  decrypted data while a database is unlocked. No web app can prevent that.

## License

See the original project and the upstream `libpwsafejs` and `aimaraJS` projects
for licensing information.
