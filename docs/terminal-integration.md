# Tích hợp Terminal vào Laravel

Hướng dẫn dành cho developer muốn nhúng terminal OpenClaw vào website Laravel (Blade, Livewire, v.v.).

---

## Tổng quan

Management API cung cấp 2 endpoint cho terminal:

| Endpoint | Mô tả |
|----------|-------|
| `GET /terminal` | Trang terminal web standalone (xterm.js), dùng nhanh không cần code |
| `GET /api/terminal/stream?cmd=...&token=...` | SSE stream — output lệnh theo thời gian thực |

**Kiến trúc bảo mật khi tích hợp:**

```
Browser
  │  (session cookie Laravel — không cần API key)
  ▼
Laravel Route  /terminal/stream?cmd=...
  │  (thêm Bearer token server-side, không lộ ra browser)
  ▼
Management API  :9998/api/terminal/stream?cmd=...&token=<KEY>
  │
  ▼
docker compose / openclaw CLI
```

> API key (`OPENCLAW_MGMT_API_KEY`) chỉ tồn tại trong `.env` của Laravel, **không bao giờ xuất hiện trong HTML hoặc HTTP response trả về browser**.

---

## SSE Event Format

Mỗi message từ `/api/terminal/stream` là một SSE event dạng:

```
data: {"type":"stdout","text":"NAME   STATUS\n"}

data: {"type":"stderr","text":"Warning: ...\n"}

data: {"type":"error","text":"Command not allowed"}

data: {"type":"exit","code":0}
```

| `type` | Ý nghĩa |
|--------|---------|
| `stdout` | Output bình thường của lệnh |
| `stderr` | Output lỗi / cảnh báo |
| `error` | Lỗi xác thực hoặc lệnh không được phép |
| `exit` | Lệnh kết thúc, `code` là exit code (0 = thành công) |

---

## Lệnh được phép

| Nhóm | Cú pháp |
|------|---------|
| Docker Compose | `docker compose ps \| logs \| restart \| pull \| up \| down \| exec \| stats \| images \| top \| config` |
| OpenClaw CLI | `openclaw <cmd>` hoặc `claw <cmd>` |
| Hệ thống | `df` · `free` · `uptime` · `ps` · `date` · `hostname` · `uname` |

Shell metacharacter bị block: `` ; & | ` $ ( ) { } \ ! ' " < > ``

---

## Bước 1 — Cấu hình Laravel

### `.env`

```env
OPENCLAW_MGMT_API_URL=http://103.142.25.188:9998
OPENCLAW_MGMT_API_KEY=your_64char_hex_key
```

### `config/openclaw.php`

```php
<?php
return [
    'mgmt_api_url' => env('OPENCLAW_MGMT_API_URL', 'http://127.0.0.1:9998'),
    'mgmt_api_key' => env('OPENCLAW_MGMT_API_KEY'),
];
```

---

## Bước 2 — Proxy Controller

Tạo `app/Http/Controllers/TerminalProxyController.php`:

```php
<?php
namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;

class TerminalProxyController extends Controller
{
    /**
     * Kiểm tra kết nối tới Management API.
     */
    public function status()
    {
        $res = Http::withToken(config('openclaw.mgmt_api_key'))
            ->timeout(5)
            ->get(config('openclaw.mgmt_api_url') . '/api/status');

        return response()->json($res->json(), $res->status());
    }

    /**
     * Proxy SSE stream — thêm Bearer token server-side.
     */
    public function stream(Request $request)
    {
        $cmd = $request->query('cmd', '');

        // Validate (defence-in-depth — Management API cũng validate)
        if (empty($cmd) || preg_match('/[;&|`$(){}\\\\!\'"<>]/', $cmd)) {
            abort(400, 'Invalid command');
        }

        $upstreamUrl = config('openclaw.mgmt_api_url')
            . '/api/terminal/stream?cmd=' . urlencode($cmd)
            . '&token=' . urlencode(config('openclaw.mgmt_api_key'));

        return response()->stream(function () use ($upstreamUrl) {
            $ch = curl_init($upstreamUrl);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => false,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_TIMEOUT        => 120,
                CURLOPT_WRITEFUNCTION  => function ($ch, $data) {
                    echo $data;
                    ob_flush();
                    flush();
                    return strlen($data);
                },
            ]);
            curl_exec($ch);
            curl_close($ch);
        }, 200, [
            'Content-Type'      => 'text/event-stream',
            'Cache-Control'     => 'no-cache',
            'X-Accel-Buffering' => 'no',
            'Connection'        => 'keep-alive',
        ]);
    }
}
```

---

## Bước 3 — Routes

### `routes/web.php`

```php
use App\Http\Controllers\TerminalProxyController;

Route::middleware(['auth'])->group(function () {
    Route::get('/terminal/status', [TerminalProxyController::class, 'status'])
        ->name('terminal.status');

    Route::get('/terminal/stream', [TerminalProxyController::class, 'stream'])
        ->name('terminal.stream');
});
```

### Exempt CSRF — `app/Http/Middleware/VerifyCsrfToken.php`

`EventSource` là GET request và không thể gửi CSRF token, nên cần exempt:

```php
protected $except = [
    'terminal/stream',
];
```

---

## Bước 4 — Livewire Component

### `app/Livewire/TerminalWidget.php`

```php
<?php
namespace App\Livewire;

use Livewire\Component;
use Illuminate\Support\Facades\Http;

class TerminalWidget extends Component
{
    public bool   $connected  = false;
    public string $statusText = '';

    public array $quickCmds = [
        ['label' => 'status',      'cmd' => 'docker compose ps'],
        ['label' => 'logs',        'cmd' => 'docker compose logs --tail=80 openclaw'],
        ['label' => 'logs -f',     'cmd' => 'docker compose logs -f openclaw'],
        ['label' => 'restart',     'cmd' => 'docker compose restart openclaw'],
        ['label' => 'pull',        'cmd' => 'docker compose pull openclaw'],
        ['label' => 'up -d',       'cmd' => 'docker compose up -d'],
        ['label' => 'down',        'cmd' => 'docker compose down'],
        ['label' => 'stats',       'cmd' => 'docker compose stats --no-stream openclaw'],
        ['label' => 'df',          'cmd' => 'df -h'],
        ['label' => 'free',        'cmd' => 'free -h'],
        ['label' => 'uptime',      'cmd' => 'uptime'],
        ['label' => 'models scan', 'cmd' => 'openclaw models scan'],
        ['label' => 'channels',    'cmd' => 'openclaw channels list'],
        ['label' => 'version',     'cmd' => 'openclaw version'],
    ];

    public function mount(): void
    {
        try {
            $res = Http::withToken(config('openclaw.mgmt_api_key'))
                ->timeout(3)
                ->get(config('openclaw.mgmt_api_url') . '/api/status');
            $this->connected  = $res->successful();
            $this->statusText = $res->successful() ? 'Connected' : 'Unreachable';
        } catch (\Throwable) {
            $this->statusText = 'Unreachable';
        }
    }

    public function render()
    {
        return view('livewire.terminal-widget');
    }
}
```

### `resources/views/livewire/terminal-widget.blade.php`

```blade
<div class="flex flex-col bg-[#0d1117] rounded-xl overflow-hidden border border-[#30363d]"
     style="height: 600px">

    {{-- Header --}}
    <div class="flex items-center gap-2 px-4 py-2 bg-[#161b22] border-b border-[#30363d] shrink-0">
        <span class="w-2 h-2 rounded-full {{ $connected ? 'bg-green-500' : 'bg-red-500' }}"></span>
        <span class="text-sm font-semibold text-[#58a6ff]">🦞 OpenClaw Terminal</span>
        <span class="text-xs text-[#8b949e] ml-1">{{ $statusText }}</span>
        <button wire:click="mount" class="ml-auto text-xs text-[#484f58] hover:text-[#8b949e]"
                title="Refresh status">↺</button>
    </div>

    {{-- Quick commands --}}
    <div id="oc-qbar"
         class="flex items-center gap-1 px-3 py-1.5 bg-[#0d1117] border-b border-[#21262d] shrink-0 overflow-x-auto">
        <span class="text-[11px] text-[#484f58] mr-1 shrink-0">Quick:</span>
        @foreach($quickCmds as $qc)
            <button class="oc-qbtn shrink-0 px-2 py-0.5 bg-[#161b22] border border-[#21262d]
                           rounded text-[#8b949e] text-xs hover:text-[#e6edf3] hover:border-[#58a6ff]
                           transition-colors cursor-pointer"
                    data-cmd="{{ $qc['cmd'] }}">
                {{ $qc['label'] }}
            </button>
        @endforeach
    </div>

    {{--
        wire:ignore — QUAN TRỌNG:
        Ngăn Livewire diff/patch vùng này khi re-render.
        xterm.js tự quản lý DOM bên trong, nếu Livewire động vào sẽ crash terminal.
    --}}
    <div wire:ignore class="flex-1 overflow-hidden p-1">
        <div id="oc-terminal"></div>
    </div>

    {{-- Inject stream URL (không có API key) --}}
    @script
    <script>
        window._ocStreamUrl = @json(route('terminal.stream'));
        initOcTerminal();
    </script>
    @endscript

</div>
```

> **Lưu ý `wire:ignore`**: bắt buộc phải có. Nếu thiếu, mỗi khi Livewire re-render (ví dụ sau `wire:click`) sẽ xoá sạch nội dung terminal.

### `resources/js/terminal-widget.js`

File này load xterm.js từ CDN rồi khởi tạo terminal. Import vào `app.js` hoặc dùng `@vite`:

```js
// resources/js/terminal-widget.js

function initOcTerminal() {
    if (window._ocTermReady) return;  // Tránh init 2 lần khi Livewire re-render
    window._ocTermReady = true;

    const HIST_KEY = 'oc_term_hist';

    // Load xterm.js từ CDN nếu chưa có
    function loadCss(href) {
        if (document.querySelector(`link[href="${href}"]`)) return;
        const l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = href;
        document.head.appendChild(l);
    }
    function loadScript(src, cb) {
        if (window[src + '_loaded']) { cb(); return; }
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => { window[src + '_loaded'] = true; cb(); };
        document.head.appendChild(s);
    }

    loadCss('https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css');
    loadScript('https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js', () => {
        loadScript('https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js', boot);
    });

    function boot() {
        const term = new Terminal({
            cursorBlink: true,
            fontFamily: '"Cascadia Code", "JetBrains Mono", "Courier New", monospace',
            fontSize: 14,
            lineHeight: 1.3,
            scrollback: 5000,
            theme: {
                background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff',
                selectionBackground: '#264f78',
                black: '#484f58',   red: '#f85149',   green: '#3fb950', yellow: '#d29922',
                blue: '#58a6ff',    magenta: '#bc8cff', cyan: '#76e3ea', white: '#b1bac4',
                brightBlack: '#6e7681', brightRed: '#ff7b72', brightGreen: '#56d364',
                brightYellow: '#e3b341', brightBlue: '#79c0ff',
            },
        });

        const fit = new FitAddon.FitAddon();
        term.loadAddon(fit);
        term.open(document.getElementById('oc-terminal'));
        fit.fit();
        window.addEventListener('resize', () => fit.fit());

        let buf = '', hist = [], hidx = -1, running = false, sse = null;
        try { hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch {}

        const prompt  = () => term.write('\x1b[32m$\x1b[0m ');
        const killSSE = () => { sse?.close(); sse = null; running = false; };
        const clrBuf  = () => { if (buf.length) term.write('\b \b'.repeat(buf.length)); buf = ''; };

        function execCmd(cmd) {
            running = true;
            // Kết nối tới Laravel proxy — session cookie tự động được gửi
            sse = new EventSource(window._ocStreamUrl + '?cmd=' + encodeURIComponent(cmd));

            sse.onmessage = (ev) => {
                try {
                    const d = JSON.parse(ev.data);
                    if (d.type === 'stdout')
                        term.write(d.text.replace(/\n/g, '\r\n').replace(/\r\r\n/g, '\r\n'));
                    else if (d.type === 'stderr')
                        term.write('\x1b[33m' + d.text.replace(/\n/g, '\r\n') + '\x1b[0m');
                    else if (d.type === 'error') {
                        term.write('\x1b[31m' + d.text + '\x1b[0m\r\n');
                        killSSE(); prompt();
                    } else if (d.type === 'exit') {
                        if (d.code) term.write('\r\n\x1b[2m[exit ' + d.code + ']\x1b[0m');
                        term.write('\r\n');
                        killSSE(); prompt();
                    }
                } catch {}
            };

            sse.onerror = () => {
                term.write('\r\n\x1b[31m[stream error]\x1b[0m\r\n');
                killSSE(); prompt();
            };
        }

        term.onKey(({ key, domEvent: e }) => {
            if (running) {
                if (e.ctrlKey && e.key === 'c') { killSSE(); term.write('^C\r\n'); prompt(); }
                return;
            }
            if (e.ctrlKey) { if (e.key === 'l') { term.clear(); prompt(); } return; }

            if (e.key === 'Enter') {
                const cmd = buf.trim(); term.write('\r\n'); buf = ''; hidx = -1;
                if (cmd) {
                    if (!hist.length || hist[0] !== cmd) {
                        hist.unshift(cmd);
                        if (hist.length > 200) hist.pop();
                        try { localStorage.setItem(HIST_KEY, JSON.stringify(hist)); } catch {}
                    }
                    execCmd(cmd);
                } else { prompt(); }
            } else if (e.key === 'Backspace') {
                if (buf.length) { buf = buf.slice(0, -1); term.write('\b \b'); }
            } else if (e.key === 'ArrowUp') {
                if (hidx < hist.length - 1) { hidx++; clrBuf(); buf = hist[hidx]; term.write(buf); }
            } else if (e.key === 'ArrowDown') {
                if (hidx > 0) { hidx--; clrBuf(); buf = hist[hidx]; term.write(buf); }
                else if (hidx === 0) { hidx = -1; clrBuf(); }
            } else if (!e.altKey && !e.metaKey && key.length === 1) {
                buf += key; term.write(key);
            }
        });

        // Quick-command buttons — event delegation (hoạt động sau Livewire re-render)
        document.getElementById('oc-qbar')?.addEventListener('click', (e) => {
            const btn = e.target.closest('.oc-qbtn');
            if (!btn) return;
            if (running) killSSE();
            clrBuf();
            term.write('\x1b[32m$\x1b[0m ' + btn.dataset.cmd + '\r\n');
            execCmd(btn.dataset.cmd);
        });

        // Welcome
        term.write('\x1b[1;34m OpenClaw Terminal\x1b[0m\r\n');
        term.write('\x1b[2m Ctrl+C = cancel  |  Ctrl+L = clear\x1b[0m\r\n\r\n');
        prompt();
    }
}

window.initOcTerminal = initOcTerminal;
```

### `resources/js/app.js` — import

```js
import './terminal-widget.js';
```

Hoặc nếu dùng Vite:

```bash
npm run build
```

---

## Bước 5 — Dùng component

### Trong bất kỳ Blade view nào:

```blade
<livewire:terminal-widget />
```

### Full-page admin terminal:

```php
// routes/web.php
Route::middleware(['auth'])->get('/admin/terminal', function () {
    return view('admin.terminal');
});
```

```blade
{{-- resources/views/admin/terminal.blade.php --}}
@extends('layouts.admin')

@section('content')
<div class="p-6 h-screen">
    <livewire:terminal-widget />
</div>
@endsection
```

---

## Bước 6 — Cấu hình Nginx

Bắt buộc tắt buffering cho SSE endpoint, nếu không output sẽ bị giữ lại thay vì stream thẳng:

```nginx
location /terminal/stream {
    fastcgi_buffering    off;
    proxy_buffering      off;
    proxy_read_timeout   120s;
}
```

Với **Laravel Octane** (Swoole/RoadRunner) không cần config nginx vì không đi qua fastcgi.

---

## Troubleshooting

### Stream không chạy, lệnh trả về ngay lập tức

PHP output buffering đang bật. Thêm vào đầu method `stream()`:

```php
if (ob_get_level()) ob_end_clean();
```

### `[stream error]` hiện ra ngay khi chạy lệnh

Kiểm tra:
1. `OPENCLAW_MGMT_API_URL` có đúng IP/port không
2. Management API đang chạy: `systemctl status openclaw-mgmt`
3. Port 9998 không bị firewall block từ server Laravel

### Terminal bị xoá sau khi click button Livewire

Thiếu `wire:ignore` trên thẻ bao container `#oc-terminal`. Xem lại Bước 4.

### `docker compose logs -f` không ngừng sau Ctrl+C

Lệnh huỷ phía client đóng `EventSource`, server nhận `req.on('close')` và `SIGTERM` process. Nếu docker compose không tắt ngay, có thể cần vài giây. Bình thường.

---

## Sơ đồ tóm tắt

```
browser
  │ GET /terminal/stream?cmd=docker+compose+ps
  │ Cookie: laravel_session=...   ← xác thực bằng session
  ▼
Laravel TerminalProxyController::stream()
  │ Validate cmd (regex)
  │ Thêm ?token=<MGMT_KEY> (server-side)
  ▼
Management API :9998/api/terminal/stream
  │ Validate token
  │ parseTerminalCmd() — whitelist
  │ spawn('docker', ['compose', ...])
  ▼
stdout/stderr  →  SSE events  →  Laravel proxy  →  Browser
                                                       │
                                                    xterm.js render
```
