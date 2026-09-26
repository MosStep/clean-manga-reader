# Clean Manga Reader - High Performance Local Proxy Server
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12 -bor [System.Net.SecurityProtocolType]::Tls11 -bor [System.Net.SecurityProtocolType]::Tls

Add-Type -AssemblyName System.Net.Http

$port = 7777
$prefix = "http://localhost:$port/"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)

try {
    $listener.Start()
} catch {
    Write-Host "[ERROR] Could not bind to port $port. Another instance might be running." -ForegroundColor Red
    exit 1
}

$handler = New-Object System.Net.Http.HttpClientHandler
$handler.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate

$httpClient = New-Object System.Net.Http.HttpClient($handler)
$httpClient.Timeout = [System.TimeSpan]::FromSeconds(12)

$currentDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "==========================================================" -ForegroundColor Green
Write-Host "  Clean Manga Reader Server (Port $port) - READY!" -ForegroundColor Cyan
Write-Host "  URL: http://localhost:$port/" -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Green

while ($listener.IsListening) {
    try {
        $ctx = $listener.GetContext()
    } catch {
        break
    }

    $req = $ctx.Request
    $res = $ctx.Response
    $localPath = $req.Url.LocalPath

    try {
        # 1. Handle CORS Preflight
        if ($req.HttpMethod -eq "OPTIONS") {
            $res.StatusCode = 200
            $res.AddHeader("Access-Control-Allow-Origin", "*")
            $res.AddHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            $res.AddHeader("Access-Control-Allow-Headers", "*")
            $res.Close()
            continue
        }

        # 2. API Proxy
        if ($localPath -eq "/api/proxy") {
            $targetUrl = $req.QueryString["url"]
            if (-not $targetUrl) {
                $rawQuery = $req.Url.Query
                if ($rawQuery -match "(?:^\?|&)url=([^&]+)") {
                    $targetUrl = [System.Uri]::UnescapeDataString($matches[1])
                }
            }

            if (-not $targetUrl -or -not ($targetUrl -match "^https?://")) {
                $res.StatusCode = 400
                $b = [System.Text.Encoding]::UTF8.GetBytes("Bad Request: Invalid target URL")
                $res.OutputStream.Write($b, 0, $b.Length)
                $res.Close()
                continue
            }

            # Safely parse and normalize URI (handles Thai / Unicode automatically)
            $uriObj = $null
            if (-not [System.Uri]::TryCreate($targetUrl, [System.UriKind]::Absolute, [ref]$uriObj)) {
                $res.StatusCode = 400
                $b = [System.Text.Encoding]::UTF8.GetBytes("Bad Request: Cannot parse URI")
                $res.OutputStream.Write($b, 0, $b.Length)
                $res.Close()
                continue
            }

            $safeTargetUrl = $uriObj.AbsoluteUri
            $origin = "$($uriObj.Scheme)://$($uriObj.Host)/"
            $customReferer = $req.QueryString["referer"]
            $referer = if ($customReferer) { $customReferer } elseif ($safeTargetUrl -match "webtoon168") { "https://ped-manga.com/" } elseif ($safeTargetUrl -match "chibi-manga") { "https://chibi-manga.com/" } elseif ($safeTargetUrl -match "mangablackcat") { "https://mangablackcat.com/" } elseif ($safeTargetUrl -match "oremanga") { "https://www.oremanga.net/" } elseif ($safeTargetUrl -match "duketoon") { "https://duketoon.com/" } else { $origin }

            $bytes = $null
            $contentType = $null
            $status = 200

            $method = if ($req.HttpMethod -eq "POST") { [System.Net.Http.HttpMethod]::Post } else { [System.Net.Http.HttpMethod]::Get }
            try {
                $httpReq = New-Object System.Net.Http.HttpRequestMessage($method, $safeTargetUrl)
                $httpReq.Headers.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")
                $httpReq.Headers.Add("Referer", $referer)
                $httpReq.Headers.Add("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")

                if ($req.HttpMethod -eq "POST" -and $req.HasEntityBody) {
                    $reader = New-Object System.IO.StreamReader($req.InputStream, $req.ContentEncoding)
                    $bodyStr = $reader.ReadToEnd()
                    $reader.Close()
                    $httpReq.Content = New-Object System.Net.Http.StringContent($bodyStr, [System.Text.Encoding]::UTF8, "application/x-www-form-urlencoded")
                }

                $httpRes = $httpClient.SendAsync($httpReq).GetAwaiter().GetResult()
                $status = [int]$httpRes.StatusCode

                if ($status -eq 403 -or $status -ge 500) {
                    throw "Need curl fallback for status $status"
                }

                if ($httpRes.Content.Headers.ContentType) {
                    $contentType = $httpRes.Content.Headers.ContentType.ToString()
                }
                $bytes = $httpRes.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
            } catch {
                # Fallback to curl.exe (handles Cloudflare TLS fingerprint differences)
                try {
                    $tempFile = [System.IO.Path]::GetTempFileName()
                    $curlMethod = if ($req.HttpMethod -eq "POST") { "-X POST" } else { "" }
                    & curl.exe -s -L $curlMethod -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" -H "Referer: $referer" -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8" -o $tempFile "$safeTargetUrl"
                    if (Test-Path $tempFile) {
                        $bytes = [System.IO.File]::ReadAllBytes($tempFile)
                        [System.IO.File]::Delete($tempFile)
                        if ($bytes.Length -gt 0) {
                            $status = 200
                        }
                    }
                } catch {}
            }

            if (-not $bytes) {
                $bytes = [System.Text.Encoding]::UTF8.GetBytes("Error fetching resource")
                $status = 502
            }

            $res.StatusCode = $status
            $res.AddHeader("Access-Control-Allow-Origin", "*")
            $res.AddHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
            $res.AddHeader("Cache-Control", "public, max-age=604800, immutable")

            if ($contentType) {
                $res.ContentType = $contentType
            } else {
                if ($targetUrl -match "\.webp(\?.*)?$") { $res.ContentType = "image/webp" }
                elseif ($targetUrl -match "\.(jpe?g)(\?.*)?$") { $res.ContentType = "image/jpeg" }
                elseif ($targetUrl -match "\.png(\?.*)?$") { $res.ContentType = "image/png" }
                else { $res.ContentType = "text/html; charset=utf-8" }
            }

            $res.ContentLength64 = $bytes.Length
            if ($req.HttpMethod -ne "HEAD") {
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            }
            $res.Close()
            continue
        }

        # 3. Static Files
        $filePath = $localPath
        if ($filePath -eq "/" -or $filePath -eq "") { $filePath = "/index.html" }
        $fullPath = Join-Path $currentDir $filePath.TrimStart('/')

        if (Test-Path $fullPath -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($fullPath).ToLower()
            $contentType = switch ($ext) {
                ".html" { "text/html; charset=utf-8" }
                ".css"  { "text/css; charset=utf-8" }
                ".js"   { "application/javascript; charset=utf-8" }
                ".png"  { "image/png" }
                ".jpg"  { "image/jpeg" }
                ".jpeg" { "image/jpeg" }
                ".webp" { "image/webp" }
                Default { "application/octet-stream" }
            }
            $res.ContentType = $contentType
            $res.StatusCode = 200
            $res.AddHeader("Access-Control-Allow-Origin", "*")
            $bytes = [System.IO.File]::ReadAllBytes($fullPath)
            $res.ContentLength64 = $bytes.Length
            if ($req.HttpMethod -ne "HEAD") {
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            }
        } else {
            $res.StatusCode = 404
            $b = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
            $res.ContentLength64 = $b.Length
            if ($req.HttpMethod -ne "HEAD") {
                $res.OutputStream.Write($b, 0, $b.Length)
            }
        }
    } catch {
        Write-Host "[PROXY ERROR] $targetUrl : $_" -ForegroundColor Red
        try {
            $res.StatusCode = 500
            $res.AddHeader("Access-Control-Allow-Origin", "*")
            $b = [System.Text.Encoding]::UTF8.GetBytes("Server Error: $_")
            $res.OutputStream.Write($b, 0, $b.Length)
        } catch { }
    } finally {
        try { $res.Close() } catch { }
    }
}
