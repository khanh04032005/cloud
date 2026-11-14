Set-Location -LiteralPath (Join-Path $PSScriptRoot "..")
$ErrorActionPreference = 'Stop'
$databaseContainer = $null
$redisContainer = $null
$processes = @()
$logs = @()
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('razzia-cloud-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
$nodePath = (Get-Command node).Source
function New-TestPort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = $listener.LocalEndpoint.Port
  $listener.Stop()
  return $port
}
try {
  $databaseContainer = docker run --rm -d -p 127.0.0.1::5432 -e POSTGRES_PASSWORD=cloud-test -e POSTGRES_DB=razzia postgres:16
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL did not start' }
  $redisContainer = docker run --rm -d -p 127.0.0.1::6379 redis:7
  if ($LASTEXITCODE -ne 0) { throw 'Redis did not start' }
  $dbPort = (docker port $databaseContainer 5432/tcp).Trim().Split(':')[-1]
  $redisPort = (docker port $redisContainer 6379/tcp).Trim().Split(':')[-1]
  $dbUrl = "postgresql://postgres:cloud-test@127.0.0.1:$dbPort/razzia"
  $cacheUrl = "redis://127.0.0.1:$redisPort"
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    docker exec $databaseContainer pg_isready -h 127.0.0.1 -U postgres -d razzia | Out-Null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Milliseconds 300
  }
  foreach ($migration in '001_live_quiz.sql','002_shared_room_state.sql','003_durable_answers.sql','004_room_leases.sql') {
    Get-Content -Raw -LiteralPath "packages/socket/migrations/$migration" | docker exec -i $databaseContainer psql -U postgres -d razzia -v ON_ERROR_STOP=1
    if ($LASTEXITCODE -ne 0) { throw "Migration $migration failed" }
  }
  $ports = @(New-TestPort; New-TestPort)
  foreach ($port in $ports) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $nodePath
    $start.WorkingDirectory = Join-Path (Get-Location) 'packages/socket'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in '--import','tsx','src/index.ts') { $start.ArgumentList.Add($argument) }
    $start.Environment['DATABASE_URL'] = $dbUrl
    $start.Environment['REDIS_URL'] = $cacheUrl
    $start.Environment['SOCKET_PORT'] = [string]$port
    $start.Environment['MANAGER_PASSWORD'] = 'test-password'
    $start.Environment['JWT_SECRET'] = 'week4-test-shared-secret-at-least-32-characters'
    $start.Environment['GAME_SPEED'] = '5'
    $start.Environment['CONFIG_PATH'] = Join-Path $scratch "config-$port"
    $process = [Diagnostics.Process]::Start($start)
    $processes += $process
    $logs += @{ Out = $process.StandardOutput.ReadToEndAsync(); Err = $process.StandardError.ReadToEndAsync() }
  }
  foreach ($port in $ports) {
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
      try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health/ready" -TimeoutSec 1
        if ($response.status -eq 'ok') { $ready = $true; break }
      } catch {}
      Start-Sleep -Milliseconds 250
    }
    if (!$ready) { throw "Socket $port was not ready" }
  }
  $env:CLOUD_TEST_A = "http://127.0.0.1:$($ports[0])"
  $env:CLOUD_TEST_B = "http://127.0.0.1:$($ports[1])"
  $env:CLOUD_TEST_DATABASE_URL = $dbUrl
  $env:CLOUD_TEST_REDIS_URL = $cacheUrl
  pnpm.cmd test
  if ($LASTEXITCODE -ne 0) { throw 'Cloud tests failed' }
} finally {
  foreach ($process in $processes) {
    if (!$process.HasExited) { $process.Kill($true); $process.WaitForExit() }
  }
  foreach ($log in $logs) {
    $log.Out.GetAwaiter().GetResult()
    $log.Err.GetAwaiter().GetResult()
  }
  if ($databaseContainer) { docker stop --time 2 $databaseContainer | Out-Null }
  if ($redisContainer) { docker stop --time 2 $redisContainer | Out-Null }
  Write-Output "Temporary test config is in $scratch"
}
