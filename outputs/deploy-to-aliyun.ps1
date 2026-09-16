param(
  [string]$ServerIp = '121.41.164.222',
  [string]$SshUser = 'root',
  [string]$KeyPath = '',
  [string]$PublicUrl = 'https://jxgl.flipbeltchina.com'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$secretConfigPath = Join-Path $PSScriptRoot 'dingtalk_config.json'
$deploymentSecretsPath = Join-Path $PSScriptRoot 'aliyun_deployment_secrets.json'
$remote = "$SshUser@$ServerIp"

if ([string]::IsNullOrWhiteSpace($KeyPath)) {
  $keyFolder = -join @([char]0x7EE9, [char]0x6548)
  $KeyPath = Join-Path (Join-Path 'D:\' $keyFolder) 'fbt2.pem'
}

function New-HexSecret([int]$Bytes) {
  $buffer = New-Object byte[] $Bytes
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  return -join ($buffer | ForEach-Object { $_.ToString('x2') })
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $encoding = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, ($Content -replace "`r`n", "`n"), $encoding)
}

if (-not (Test-Path -LiteralPath $KeyPath)) { throw "SSH key not found: $KeyPath" }
if (-not (Test-Path -LiteralPath $secretConfigPath)) { throw "DingTalk config not found: $secretConfigPath" }

$dingTalk = Get-Content -Raw -Encoding UTF8 -LiteralPath $secretConfigPath | ConvertFrom-Json
foreach ($field in @('appKey', 'appSecret', 'agentId', 'corpId')) {
  if (-not $dingTalk.$field) { throw "Missing $field in dingtalk_config.json" }
}

if (Test-Path -LiteralPath $deploymentSecretsPath) {
  $deploymentSecrets = Get-Content -Raw -Encoding UTF8 -LiteralPath $deploymentSecretsPath | ConvertFrom-Json
} else {
  $deploymentSecrets = [ordered]@{
    adminUsername = 'ft-perf-admin'
    adminPassword = New-HexSecret 18
    linkSigningSecret = New-HexSecret 32
  }
  Write-Utf8NoBom $deploymentSecretsPath ($deploymentSecrets | ConvertTo-Json)
}

$tempRoot = Join-Path $env:TEMP ('performance-deploy-' + [Guid]::NewGuid().ToString('N'))
$stage = Join-Path $tempRoot 'app'
$archive = Join-Path $tempRoot 'performance-system.tar.gz'
$envFile = Join-Path $tempRoot 'performance-system.env'
$remoteScriptPath = Join-Path $tempRoot 'install-performance-system.sh'
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'outputs') | Out-Null

try {
  foreach ($name in @('package.json', 'package-lock.json')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination (Join-Path $stage $name)
  }
  Get-ChildItem -LiteralPath $PSScriptRoot -File | Where-Object {
    $_.Name -notin @('dingtalk_config.json', 'aliyun_deployment_secrets.json', 'deploy-to-aliyun.ps1', 'deploy-to-aliyun.cmd', 'maintenance-backups')
  } | Copy-Item -Destination (Join-Path $stage 'outputs')

  & tar.exe -czf $archive -C $stage .
  if ($LASTEXITCODE -ne 0) { throw 'Failed to create deployment archive.' }

  $publicUrl = if ([string]::IsNullOrWhiteSpace($PublicUrl)) {
    "http://${ServerIp}:39080"
  } else {
    $PublicUrl.TrimEnd('/')
  }
  $oa = $dingTalk.oaApproval
  $oaEnabled = if ($oa -and $oa.enabled) { 'true' } else { 'false' }
  $oaProcessName = if ($oa -and $oa.processName) { $oa.processName } else { [string]::Empty }
  $oaProcessCode = if ($oa -and $oa.processCode) { $oa.processCode } else { [string]::Empty }
  $oaAgentId = if ($oa -and $oa.agentId) { $oa.agentId } elseif ($dingTalk.agentId) { $dingTalk.agentId } else { [string]::Empty }
  $oaOriginatorUserId = if ($oa -and $oa.originatorUserId) { $oa.originatorUserId } else { [string]::Empty }
  $oaOriginatorUnionId = if ($oa -and $oa.originatorUnionId) { $oa.originatorUnionId } else { [string]::Empty }
  $oaOriginatorDeptId = if ($oa -and $null -ne $oa.originatorDeptId) { $oa.originatorDeptId } else { -1 }
  $oaProcessRoutesJson = if ($oa -and $oa.processRoutes) { $oa.processRoutes | ConvertTo-Json -Depth 8 -Compress } else { '{}' }
  $oaProcessRoutesB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($oaProcessRoutesJson))
  # Enterprise application robots use the application's Client ID/AppKey as
  # robotCode. An explicit value remains supported for application migrations.
  $robotCode = if ($dingTalk.robotCode) { $dingTalk.robotCode } else { $dingTalk.appKey }
  $environment = @"
NODE_ENV=production
PORT=18080
DATA_DIR=/var/lib/performance-system
PUBLIC_SERVER_URL=$publicUrl
DINGTALK_APP_KEY=$($dingTalk.appKey)
DINGTALK_APP_SECRET=$($dingTalk.appSecret)
DINGTALK_APP_ID=$($dingTalk.appId)
DINGTALK_CORP_ID=$($dingTalk.corpId)
DINGTALK_AGENT_ID=$($dingTalk.agentId)
DINGTALK_ROBOT_CODE=$robotCode
DINGTALK_OA_ENABLED=$oaEnabled
DINGTALK_OA_PROCESS_NAME=$oaProcessName
DINGTALK_OA_PROCESS_CODE=$oaProcessCode
DINGTALK_OA_AGENT_ID=$oaAgentId
DINGTALK_OA_ORIGINATOR_USER_ID=$oaOriginatorUserId
DINGTALK_OA_ORIGINATOR_UNION_ID=$oaOriginatorUnionId
DINGTALK_OA_ORIGINATOR_DEPT_ID=$oaOriginatorDeptId
DINGTALK_OA_PROCESS_ROUTES_B64=$oaProcessRoutesB64
ADMIN_USERNAME=$($deploymentSecrets.adminUsername)
ADMIN_PASSWORD=$($deploymentSecrets.adminPassword)
LINK_SIGNING_SECRET=$($deploymentSecrets.linkSigningSecret)
"@
  Write-Utf8NoBom $envFile $environment

  $remoteScript = @'
#!/usr/bin/env bash
set -euo pipefail

APP_ROOT=/opt/performance-system
DATA_ROOT=/var/lib/performance-system
UPLOAD_ROOT=/root/performance-deploy
RELEASE="$APP_ROOT/releases/$(date +%Y%m%d%H%M%S)"
OLD_RELEASE="$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)"

install_runtime() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y curl ca-certificates gnupg nginx
    if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -lt 20 ]; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      apt-get install -y nodejs
    fi
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y curl ca-certificates nginx
    if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -lt 20 ]; then
      curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
      dnf install -y nodejs
    fi
  elif command -v yum >/dev/null 2>&1; then
    yum install -y curl ca-certificates nginx
    if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -lt 20 ]; then
      curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
      yum install -y nodejs
    fi
  else
    echo 'Unsupported Linux distribution: apt-get, dnf or yum is required.' >&2
    exit 1
  fi
}

install_runtime
id performance-system >/dev/null 2>&1 || useradd --system --home-dir "$DATA_ROOT" --shell /sbin/nologin performance-system
install -d -o performance-system -g performance-system -m 750 "$DATA_ROOT"
# The application uses atomic rewrites. Maintenance scripts may leave replacement
# files owned by root, so normalize ownership on every deployment before chmod.
chown -R performance-system:performance-system "$DATA_ROOT"
find "$DATA_ROOT" -type d -exec chmod 750 {} +
find "$DATA_ROOT" -type f -exec chmod 640 {} +
install -d -m 755 "$APP_ROOT/releases" "$RELEASE"
tar -xzf "$UPLOAD_ROOT/performance-system.tar.gz" -C "$RELEASE"
cd "$RELEASE"
npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com
chown -R root:root "$RELEASE"
install -o root -g performance-system -m 640 "$UPLOAD_ROOT/performance-system.env" /etc/performance-system.env

NODE_BIN="$(command -v node)"
cat >/etc/systemd/system/performance-system.service <<EOF
[Unit]
Description=Performance Management System
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=performance-system
Group=performance-system
WorkingDirectory=$APP_ROOT/current
EnvironmentFile=/etc/performance-system.env
ExecStart=$NODE_BIN outputs/eval-server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
UMask=0027
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_ROOT

[Install]
WantedBy=multi-user.target
EOF

ln -sfn "$RELEASE" "$APP_ROOT/current"
systemctl daemon-reload
systemctl enable performance-system >/dev/null
if ! systemctl restart performance-system || ! bash -c 'for i in {1..20}; do curl -fsS http://127.0.0.1:18080/healthz >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1'; then
  echo 'Application health check failed; rolling back.' >&2
  if [ -n "$OLD_RELEASE" ] && [ -d "$OLD_RELEASE" ]; then
    ln -sfn "$OLD_RELEASE" "$APP_ROOT/current"
    systemctl restart performance-system || true
  fi
  journalctl -u performance-system -n 80 --no-pager >&2 || true
  exit 1
fi

cat >/etc/nginx/conf.d/performance-system.conf <<'EOF'
server {
    listen 39080;
    listen [::]:39080;
    server_name 121.41.164.222;

    client_max_body_size 20m;
    location / {
        proxy_pass http://127.0.0.1:18080;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 10s;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
EOF

if command -v setsebool >/dev/null 2>&1; then setsebool -P httpd_can_network_connect 1 || true; fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=39080/tcp >/dev/null
  firewall-cmd --reload >/dev/null
fi
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then ufw allow 39080/tcp >/dev/null; fi
nginx -t
systemctl enable nginx >/dev/null
systemctl reload nginx
curl -fsS http://127.0.0.1:39080/healthz
echo
echo 'DEPLOYMENT_OK'
'@
  Write-Utf8NoBom $remoteScriptPath $remoteScript

  $sshCommon = @('-i', $KeyPath, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new')
  Write-Host "Connecting to $remote ..." -ForegroundColor Cyan
  & ssh @sshCommon $remote 'install -d -m 700 /root/performance-deploy'
  if ($LASTEXITCODE -ne 0) { throw 'SSH connection failed.' }

  & scp @sshCommon $archive "${remote}:/root/performance-deploy/performance-system.tar.gz"
  if ($LASTEXITCODE -ne 0) { throw 'Application upload failed.' }
  & scp @sshCommon $envFile "${remote}:/root/performance-deploy/performance-system.env"
  if ($LASTEXITCODE -ne 0) { throw 'Environment upload failed.' }
  & scp @sshCommon $remoteScriptPath "${remote}:/root/performance-deploy/install-performance-system.sh"
  if ($LASTEXITCODE -ne 0) { throw 'Installer upload failed.' }

  & ssh @sshCommon $remote 'chmod 700 /root/performance-deploy/install-performance-system.sh && /root/performance-deploy/install-performance-system.sh'
  if ($LASTEXITCODE -ne 0) { throw 'Remote deployment failed.' }

  Write-Host ''
  Write-Host 'Deployment completed.' -ForegroundColor Green
  Write-Host "System URL: $publicUrl/" -ForegroundColor Green
  Write-Host "Admin username: $($deploymentSecrets.adminUsername)" -ForegroundColor Yellow
  Write-Host "Admin password: $($deploymentSecrets.adminPassword)" -ForegroundColor Yellow
  Write-Host "Credentials are also stored at: $deploymentSecretsPath" -ForegroundColor DarkYellow
  try {
    $health = Invoke-RestMethod -Uri "http://${ServerIp}:39080/healthz" -TimeoutSec 15
    Write-Host "Public health check: $($health.status)" -ForegroundColor Green
  } catch {
    Write-Warning 'The server is healthy internally, but the public check failed. Allow inbound TCP 39080 in the Alibaba Cloud security group.'
  }
} finally {
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
